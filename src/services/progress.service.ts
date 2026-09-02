import { and, desc, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../db/main/index.js';
import { readStates, userProgress, works } from '../db/main/schema.js';

/** 听完判定阈值（position/duration ≥ 此值视为听完），前端 progressStore 同值对齐。 */
export const LISTENED_RATIO = 0.95;

/** 单作品的进度聚合（列表注入用，camelCase 对齐前端 Review 响应风格）。 */
export interface WorkProgressSummary {
  /** 上次播放的音轨（media index = 文件相对路径） */
  mediaIndex: string;
  trackTitle: string | null;
  position: number;
  duration: number | null;
  /** 已听完的轨数（position/duration ≥ 0.95 视为听完） */
  listenedCount: number;
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
}) {
  const now = new Date().toISOString();

  // 自动已读（D2）：作品此前无任何进度行（真·首次收听）时顺带写标记。
  // 仅此一次跳变触发——手动标记未读后继续上报不会翻回已读；
  // onConflictDoNothing 保证并发上报/重复触发不覆盖已有标记。
  const existed = await db.query.userProgress.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.eq(t.userName, data.userName), op.eq(t.workId, data.workId))!,
    },
    columns: { mediaIndex: true },
  });
  if (!existed) {
    await db
      .insert(readStates)
      .values({ userName: data.userName, workId: data.workId, readAt: now })
      .onConflictDoNothing();
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

  for (const [workId, list] of byWork) {
    // updatedAt 最新的行 = 上次播放位置
    const latest = list.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));

    const listenedCount = list.filter(
      (r) =>
        r.duration != null &&
        r.duration > 0 &&
        r.position / r.duration >= LISTENED_RATIO,
    ).length;

    result.set(workId, {
      mediaIndex: latest.mediaIndex,
      trackTitle: latest.trackTitle,
      position: latest.position,
      duration: latest.duration,
      listenedCount,
      updatedAt: latest.updatedAt,
    });
  }

  return result;
}

/** 置为已读（手动入口：upsert，重复标记刷新 readAt）。 */
export async function markWorkRead(userName: string, workId: string) {
  const now = new Date().toISOString();
  await db
    .insert(readStates)
    .values({ userName, workId, readAt: now })
    .onConflictDoUpdate({
      target: [readStates.userName, readStates.workId],
      set: { readAt: now },
    });
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
