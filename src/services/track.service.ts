import { and, eq, inArray, sql } from 'drizzle-orm';
import { db } from '../db/main/index.js';
import { tracks } from '../db/main/schema.js';

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

export async function upsertTrackRow(row: NewTrackInput): Promise<void> {
  await db
    .insert(tracks)
    .values(row)
    .onConflictDoUpdate({
      target: [tracks.workId, tracks.mediaIndex],
      set: {
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
