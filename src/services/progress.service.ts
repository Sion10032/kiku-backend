import { db } from '../db/main/index.js';
import { userProgress } from '../db/main/schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';

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

  await db.insert(userProgress)
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
      target: [ userProgress.userName, userProgress.workId, userProgress.mediaIndex ],
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
    where: and(
      eq(userProgress.userName, userName),
      eq(userProgress.workId, workId),
    ),
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
    where: and(
      eq(userProgress.userName, userName),
      inArray(userProgress.workId, workIds),
    ),
  });

  const byWork = new Map<string, typeof rows>();
  for (const row of rows) {
    const list = byWork.get(row.workId);
    if (list) list.push(row);
    else byWork.set(row.workId, [ row ]);
  }

  for (const [ workId, list ] of byWork) {
    // updatedAt 最新的行 = 上次播放位置
    const latest = list.reduce((a, b) => (a.updatedAt >= b.updatedAt ? a : b));

    const listenedCount = list.filter(
      r => r.duration != null && r.duration > 0 && r.position / r.duration >= 0.95,
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

/** 删除某用户在某作品的全部进度（作品回到未读态）。返回删除行数。 */
export async function deleteWorkProgress(userName: string, workId: string) {
  const deleted = await db.delete(userProgress).where(and(
    eq(userProgress.userName, userName),
    eq(userProgress.workId, workId),
  )).run();

  return deleted.changes;
}
