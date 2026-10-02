import { and, desc, eq, gt, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  readStates,
  tracks,
  userProgress,
  works,
} from '../infra/db/main/schema.js';
import { getUserByName } from './user.service.js';
import { liveWorkExists } from './work.service.js';

/** 听完判定阈值（position/duration ≥ 此值视为听完），前端 progressStore 同值对齐。 */
export const LISTENED_RATIO = 0.95;

/** 已听完轨数（仅计已知时长的音轨；自动已读跳变判定用，与 listenedCount 同口径）。 */
async function countListenedTracks(
  userName: string,
  workId: string,
): Promise<number> {
  const [row] = await db
    .select({ count: sql<number>`count(*)` })
    .from(tracks)
    .innerJoin(
      userProgress,
      and(
        eq(userProgress.workId, tracks.workId),
        eq(userProgress.mediaIndex, tracks.mediaIndex),
        eq(userProgress.userName, userName),
      ),
    )
    .where(
      and(
        eq(tracks.workId, workId),
        gt(tracks.durationSec, 0),
        gt(userProgress.duration, 0),
        sql`${userProgress.position} * 1.0 / ${userProgress.duration} >= ${LISTENED_RATIO}`,
      ),
    );
  return row?.count ?? 0;
}

/** 单作品的进度聚合（列表注入用，camelCase 对齐前端 Review 响应风格）。 */
export interface WorkProgressSummary {
  /** 上次播放的音轨（media index = 文件相对路径） */
  mediaIndex: string;
  trackTitle: string | null;
  position: number;
  duration: number | null;
  /** 已听完的轨数（position/duration ≥ 0.95 视为听完） */
  listenedCount: number;
  /** 整体收听进度百分比（0-100）：已听完轨时长（最新行除外）+ 最新行 position，
   * ÷ SUM(tracks.duration_sec)；作品无已知时长音轨时为 null。 */
  progressPercent: number | null;
  updatedAt: string;
}

/** 单条进度上报 → 写入/覆盖 (user, work, track) 行。 */
export async function upsertProgress(data: {
  userName: string;
  workId: string;
  mediaIndex: string;
  trackTitle?: string;
  position: number;
  duration?: number | null;
}): Promise<'user-missing' | 'work-missing' | 'ok'> {
  // FK 防护：幽灵 token（用户已不存在）→ 'user-missing'（route 映射 401）；
  // 作品不在库 → 'work-missing'（route 映射 404，进度静默丢弃）
  if (!(await getUserByName(data.userName))) return 'user-missing';
  if (!(await liveWorkExists(data.workId))) return 'work-missing';

  const now = new Date().toISOString();

  // 自动已读快速门控（性能优化）：「非听完 → 听完」跳变只能由当前上报的这轨
  // 新变为听完触发（其余音轨的状态不受本次上报影响），因此仅当「上报后当前
  // 轨听完」时才值得做计数比对：
  // - 上报自带有效 duration（>0）：直接按 payload 判定，不读库——播放中的
  //   绝大多数未听完上报在此短路，省去每次 1-2 次计数查询
  // - 上报缺省/为 null 的 duration（upsert 保留库中旧值）：需查原行 duration 判定
  let currentListened = false;
  if (data.duration != null) {
    currentListened =
      data.duration > 0 && data.position / data.duration >= LISTENED_RATIO;
  } else {
    const [prev] = await db
      .select({ duration: userProgress.duration })
      .from(userProgress)
      .where(
        and(
          eq(userProgress.userName, data.userName),
          eq(userProgress.workId, data.workId),
          eq(userProgress.mediaIndex, data.mediaIndex),
        ),
      )
      .limit(1);
    currentListened =
      prev?.duration != null &&
      prev.duration > 0 &&
      data.position / prev.duration >= LISTENED_RATIO;
  }

  // 听完判定基数：仅计已知时长的音轨（与 listenedCount 的 duration>0 口径一致）。
  // 全部时长未知的作品无法自动判定，仅能手动标记。
  let total = 0;
  let listenedBefore = 0;
  if (currentListened) {
    const [trackTotal] = await db
      .select({ count: sql<number>`count(*)` })
      .from(tracks)
      .where(and(eq(tracks.workId, data.workId), gt(tracks.durationSec, 0)));
    total = trackTotal?.count ?? 0;
    if (total > 0) {
      listenedBefore = await countListenedTracks(data.userName, data.workId);
    }
  }

  await db
    .insert(userProgress)
    .values({
      userName: data.userName,
      workId: data.workId,
      mediaIndex: data.mediaIndex,
      trackTitle: data.trackTitle ?? null,
      position: data.position,
      duration: data.duration ?? null,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [
        userProgress.userName,
        userProgress.workId,
        userProgress.mediaIndex,
      ],
      set: {
        position: data.position,
        // 未上报的字段保留库中原值（excluded 引用待插入行，此处引用原行）
        trackTitle: data.trackTitle ?? sql`${userProgress.trackTitle}`,
        duration: data.duration ?? sql`${userProgress.duration}`,
        updatedAt: now,
      },
    });

  // 自动已读（修订 D2）：仅在「非听完 → 听完」跳变时顺带写标记。
  // 已听完作品的继续上报无跳变——手动未读不会被播放翻回（手动意图优先）；
  // onConflictDoNothing 保证并发上报不覆盖已有标记。
  if (total > 0 && listenedBefore < total) {
    const listenedAfter = await countListenedTracks(data.userName, data.workId);
    if (listenedAfter >= total) {
      await db
        .insert(readStates)
        .values({ userName: data.userName, workId: data.workId, readAt: now })
        .onConflictDoNothing();
    }
  }

  return 'ok';
}

/** 某用户在某作品的全部进度行（详情页/继续播放用）。 */
export async function getWorkProgress(userName: string, workId: string) {
  return db.query.userProgress.findMany({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.eq(t.userName, userName), op.eq(t.workId, workId))!,
    },
  });
}

/**
 * 批量查询多个作品的进度并聚合（works 列表注入用，避免 N+1）。
 *
 * 聚合规则：
 * - "上次听到"取 updatedAt 最新的行
 * - listenedCount：duration > 0 且 position/duration ≥ 0.95 的行数
 *   （自然结束时上报 position=duration 自动满足）
 * - progressPercent：整体收听进度（0-100）。分母 = SUM(tracks.duration_sec)
 *   （与 works.duration 同口径，忽略 NULL；实现额外排除非正值防御）；
 *   分子 = 除最新行外的听完轨按整轨时长计 +
 *   最新行按实际 position 计（顺听时 ≈ 整轨，回听时不高估）。音轨时长取
 *   tracks.duration_sec（权威值，userProgress.duration 可能为 null/过期）；
 *   时长未知的轨分子分母均不计（口径一致）。无已知时长 → null
 */
export async function getProgressByWorks(
  userName: string,
  workIds: string[],
): Promise<Map<string, WorkProgressSummary>> {
  const result = new Map<string, WorkProgressSummary>();
  if (workIds.length === 0) return result;

  const rows = await db.query.userProgress.findMany({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.eq(t.userName, userName), op.inArray(t.workId, workIds))!,
    },
  });

  const byWork = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWork.get(row.workId);
    if (list) list.push(row);
    else byWork.set(row.workId, [row]);
  }

  // progressPercent 用音轨时长：一次批量取（避免逐作品查询），
  // 同时累加各作品总时长（分母；与 works.duration 同为 SUM 忽略 NULL，
  // 此处额外排除非正值防御）
  const trackRows = await db
    .select({
      workId: tracks.workId,
      mediaIndex: tracks.mediaIndex,
      durationSec: tracks.durationSec,
    })
    .from(tracks)
    .where(inArray(tracks.workId, [...byWork.keys()]));
  const durationByWork = new Map<string, Map<string, number>>();
  const totalByWork = new Map<string, number>();
  for (const t of trackRows) {
    if (t.durationSec == null || t.durationSec <= 0) continue;
    let byIndex = durationByWork.get(t.workId);
    if (!byIndex) {
      byIndex = new Map();
      durationByWork.set(t.workId, byIndex);
    }
    byIndex.set(t.mediaIndex, t.durationSec);
    totalByWork.set(t.workId, (totalByWork.get(t.workId) ?? 0) + t.durationSec);
  }

  for (const [workId, list] of byWork) {
    // updatedAt 最新的行 = 上次播放位置
    const latest = list.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));

    const listenedCount = list.filter(
      (r) =>
        r.duration != null &&
        r.duration > 0 &&
        r.position / r.duration >= LISTENED_RATIO,
    ).length;

    // 整体收听进度分子：听完轨按整轨计（最新行除外），最新行按实际 position 计；
    // 时长未知的轨跳过（分母同样不含，口径一致）
    const durations = durationByWork.get(workId);
    const totalSec = totalByWork.get(workId) ?? 0;
    let listenedSec = 0;
    for (const r of list) {
      const trackSec = durations?.get(r.mediaIndex);
      if (trackSec == null) continue;
      if (r === latest) {
        listenedSec += Math.min(r.position, trackSec);
      } else if (
        r.duration != null &&
        r.duration > 0 &&
        r.position / r.duration >= LISTENED_RATIO
      ) {
        listenedSec += trackSec;
      }
    }
    const progressPercent =
      totalSec > 0
        ? Math.min(100, Math.max(0, Math.round((listenedSec / totalSec) * 100)))
        : null;

    result.set(workId, {
      mediaIndex: latest.mediaIndex,
      trackTitle: latest.trackTitle,
      position: latest.position,
      duration: latest.duration,
      listenedCount,
      progressPercent,
      updatedAt: latest.updatedAt,
    });
  }

  return result;
}

/** 置为已读（手动入口：upsert，重复标记刷新 readAt）。 */
export async function markWorkRead(
  userName: string,
  workId: string,
): Promise<'work-missing' | 'ok'> {
  // FK 防护：作品不在库（或已软删）→ 'work-missing'（route 映射 404）
  if (!(await liveWorkExists(workId))) return 'work-missing';

  const now = new Date().toISOString();
  await db
    .insert(readStates)
    .values({ userName, workId, readAt: now })
    .onConflictDoUpdate({
      target: [readStates.userName, readStates.workId],
      set: { readAt: now },
    });

  return 'ok';
}

/** 置为未读（删标记行；进度不动，见 D3）。 */
export async function markWorkUnread(userName: string, workId: string) {
  await db
    .delete(readStates)
    .where(
      and(eq(readStates.userName, userName), eq(readStates.workId, workId)),
    )
    .run();
}

/** 批量查已读作品集合（attachUserData 注入用，避免 N+1）。 */
export async function getReadWorkIds(
  userName: string,
  workIds: string[],
): Promise<Set<string>> {
  if (workIds.length === 0) return new Set();
  const rows = await db
    .select({ workId: readStates.workId })
    .from(readStates)
    .where(
      and(
        eq(readStates.userName, userName),
        inArray(readStates.workId, workIds),
      ),
    );
  return new Set(rows.map((r) => r.workId));
}

/** 删除某用户在某作品的全部进度（作品回到未读态）。返回删除行数。 */
export async function deleteWorkProgress(userName: string, workId: string) {
  const deleted = await db
    .delete(userProgress)
    .where(
      and(eq(userProgress.userName, userName), eq(userProgress.workId, workId)),
    )
    .run();

  // 删除进度 = 彻底回到未读态：级联清已读标记（对齐前端对话框文案）
  await markWorkUnread(userName, workId);

  return deleted.changes;
}

/**
 * 用户收听历史（按作品去重）：max(updatedAt) 倒序分页取 workId。
 *
 * - join works 过滤软删（deletedAt 非空的作品不出现在历史）
 * - updatedAt 为 ISO 8601 文本，字典序即时间序（见计划 D3）
 * - 仅返回 id 与总数；works 格式化由 work.service.getWorksByIdsOrdered
 *   完成（避免 progress.service → work.service 反向依赖，见计划 D2）
 */
export async function getUserHistoryIds(
  userName: string,
  opts: { page?: number; pageSize?: number } = {},
): Promise<{ workIds: string[]; totalCount: number }> {
  const { page = 1, pageSize = 20 } = opts;
  const offset = (page - 1) * pageSize;

  const where = and(
    eq(userProgress.userName, userName),
    isNull(works.deletedAt),
  );

  const [rows, countRows] = await Promise.all([
    db
      .select({ workId: userProgress.workId })
      .from(userProgress)
      .innerJoin(works, eq(userProgress.workId, works.id))
      .where(where)
      .groupBy(userProgress.workId)
      .orderBy(desc(sql`max(${userProgress.updatedAt})`))
      .limit(pageSize)
      .offset(offset),
    db
      .select({ count: sql<number>`count(distinct ${userProgress.workId})` })
      .from(userProgress)
      .innerJoin(works, eq(userProgress.workId, works.id))
      .where(where),
  ]);

  return {
    workIds: rows.map((r) => r.workId),
    totalCount: countRows[0]?.count ?? 0,
  };
}
