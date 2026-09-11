import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { tracks, works } from '../infra/db/main/schema.js';

export type TrackRow = typeof tracks.$inferSelect;

export interface TrackSyncPlan {
  toUpsert: Array<{
    mediaIndex: string;
    title: string;
    sizeBytes: number;
    revalidate: boolean;
  }>;
  toDelete: string[];
  unchanged: number;
}

/** 磁盘音轨叶子 vs 库内行 → 同步计划。revalidate = size 变化（内容变了；姊妹计划据此失效响度）。 */
export function planTrackSync(
  audioLeaves: Array<{ mediaIndex: string; title: string; sizeBytes: number }>,
  existing: Array<{ mediaIndex: string; sizeBytes: number }>,
): TrackSyncPlan {
  const byIndex = new Map(existing.map((r) => [r.mediaIndex, r]));
  const keep = new Set<string>();
  const toUpsert: TrackSyncPlan['toUpsert'] = [];
  let unchanged = 0;
  for (const leaf of audioLeaves) {
    const row = byIndex.get(leaf.mediaIndex);
    keep.add(leaf.mediaIndex);
    if (!row || row.sizeBytes !== leaf.sizeBytes) {
      toUpsert.push({ ...leaf, revalidate: row !== undefined });
    } else unchanged++;
  }
  const toDelete = existing
    .filter((r) => !keep.has(r.mediaIndex))
    .map((r) => r.mediaIndex);
  return { toUpsert, toDelete, unchanged };
}

export async function getTrackRows(workId: string): Promise<TrackRow[]> {
  return db.select().from(tracks).where(eq(tracks.workId, workId));
}

export interface NewTrackInput {
  workId: string;
  mediaIndex: string;
  title: string;
  sizeBytes: number;
  durationSec: number | null;
}

export async function upsertTrackRow(
  row: NewTrackInput,
  opts?: { resetLoudness?: boolean },
): Promise<void> {
  await db
    .insert(tracks)
    .values(row)
    .onConflictDoUpdate({
      target: [tracks.workId, tracks.mediaIndex],
      set: opts?.resetLoudness
        ? {
            ...row,
            loudnessLufs: null,
            loudnessTruePeakDb: null,
            loudnessCurve: null,
            analyzedAt: null,
            analyzeError: null,
          }
        : {
            title: row.title,
            sizeBytes: row.sizeBytes,
            durationSec: row.durationSec,
          },
    });
}

export async function deleteTrackRows(
  workId: string,
  mediaIndexes: string[],
): Promise<void> {
  if (mediaIndexes.length === 0) return;
  await db
    .delete(tracks)
    .where(
      and(eq(tracks.workId, workId), inArray(tracks.mediaIndex, mediaIndexes)),
    );
}

/**
 * 作品总时长批量聚合：SUM(duration_sec)（秒）。
 *
 * - SUM 天然忽略 null：个别音轨探测失败 → 已知部分和
 * - 无音轨行 / 全部未知 → null（Map 仍含键，调用方免判 undefined）
 * - 批量入参供列表页整页一次查询，避免 N+1
 */
export async function getTotalDurations(
  workIds: string[],
): Promise<Map<string, number | null>> {
  const map = new Map<string, number | null>(workIds.map((id) => [id, null]));
  if (workIds.length === 0) return map;
  const rows = await db
    .select({
      workId: tracks.workId,
      total: sql<number | null>`sum(${tracks.durationSec})`,
    })
    .from(tracks)
    .where(inArray(tracks.workId, workIds))
    .groupBy(tracks.workId);
  for (const r of rows) {
    if (map.has(r.workId)) map.set(r.workId, r.total);
  }
  return map;
}

export type LoudnessValue =
  | {
      lufs: number;
      truePeakDb: number;
      /** short-term 按秒降采样序列（1 点/秒，1 位小数，空段 null）；正常分析总带值 */
      curve?: Array<number | null>;
    }
  | { error: string };

export async function setTrackLoudness(
  workId: string,
  mediaIndex: string,
  value: LoudnessValue,
): Promise<void> {
  const base =
    'error' in value
      ? {
          loudnessLufs: null,
          loudnessTruePeakDb: null,
          loudnessCurve: null,
          analyzeError: value.error,
        }
      : {
          loudnessLufs: value.lufs,
          loudnessTruePeakDb: value.truePeakDb,
          loudnessCurve: value.curve ? JSON.stringify(value.curve) : null,
          analyzeError: null,
        };
  await db
    .update(tracks)
    .set({ ...base, analyzedAt: new Date().toISOString() })
    .where(and(eq(tracks.workId, workId), eq(tracks.mediaIndex, mediaIndex)));
}

/** 待分析 = 存在 loudness IS NULL 音轨的作品（含 analyze_error 的可重试）；join works 排除软删与孤儿轨。 */
export async function getPendingAnalysisWorkIds(): Promise<string[]> {
  const rows = await db
    .selectDistinct({ workId: tracks.workId })
    .from(tracks)
    .innerJoin(works, eq(tracks.workId, works.id))
    .where(and(isNull(tracks.loudnessLufs), isNull(works.deletedAt)));
  return rows.map((r) => r.workId);
}

/** 作品响度 = 已分析音轨按时长加权 LUFS + true peak 最大值；无已分析音轨返回 null。 */
export async function computeWorkLoudness(
  workId: string,
): Promise<{ lufs: number; truePeakDb: number } | null> {
  const rows = (await getTrackRows(workId)).filter(
    (r) =>
      r.loudnessLufs !== null && r.durationSec !== null && r.durationSec > 0,
  );
  if (rows.length === 0) {
    await db
      .update(works)
      .set({ loudnessLufs: null, loudnessTruePeakDb: null })
      .where(eq(works.id, workId));
    return null;
  }
  const totalDur = rows.reduce((s, r) => s + (r.durationSec ?? 0), 0);
  const lufs =
    rows.reduce((s, r) => s + (r.durationSec ?? 0) * (r.loudnessLufs ?? 0), 0) /
    totalDur;
  const truePeakDb = Math.max(...rows.map((r) => r.loudnessTruePeakDb ?? -99));
  await db
    .update(works)
    .set({ loudnessLufs: lufs, loudnessTruePeakDb: truePeakDb })
    .where(eq(works.id, workId));
  return { lufs, truePeakDb };
}
