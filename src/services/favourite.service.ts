import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  favourites,
  series,
  vas,
  vaWork,
  works,
} from '../infra/db/main/schema.js';

export type FavouriteTargetType = 'work' | 'series' | 'va' | 'circle';

/** 收藏目标摘要：work 与 实体（系列/声优/社团）二选一（对齐路由 zod union）。 */
export interface FavouriteItemDto {
  targetType: FavouriteTargetType;
  targetId: string;
  createdAt: string;
  target:
    | { id: string; title: string; circleName: string }
    | { id: string; name: string; workCount: number };
}

/** 校验收藏目标存在（多态无 FK，service 层维护完整性）。软删作品视为不存在。 */
async function targetExists(
  targetType: FavouriteTargetType,
  targetId: string,
): Promise<boolean> {
  switch (targetType) {
    case 'work': {
      const w = await db.query.works.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, targetId) },
      });
      return !!w && !w.deletedAt;
    }
    case 'series':
      return !!(await db.query.series.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, targetId) },
      }));
    case 'va':
      return !!(await db.query.vas.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, targetId) },
      }));
    case 'circle':
      return !!(await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, targetId) },
      }));
  }
}

export async function addFavourite(
  userName: string,
  targetType: FavouriteTargetType,
  targetId: string,
): Promise<boolean> {
  if (!(await targetExists(targetType, targetId))) return false;
  await db
    .insert(favourites)
    .values({
      userName,
      targetType,
      targetId,
      createdAt: new Date().toISOString(),
    })
    .onConflictDoNothing();
  return true;
}

export async function removeFavourite(
  userName: string,
  targetType: FavouriteTargetType,
  targetId: string,
): Promise<void> {
  await db
    .delete(favourites)
    .where(
      and(
        eq(favourites.userName, userName),
        eq(favourites.targetType, targetType),
        eq(favourites.targetId, targetId),
      ),
    );
}

export async function statusFavourites(
  userName: string,
  targetType: FavouriteTargetType,
  ids: string[],
): Promise<Record<string, boolean>> {
  if (ids.length === 0) return {};
  const rows = await db
    .select({ targetId: favourites.targetId })
    .from(favourites)
    .where(
      and(
        eq(favourites.userName, userName),
        eq(favourites.targetType, targetType),
        inArray(favourites.targetId, ids),
      ),
    );
  const set = new Set(rows.map((r) => r.targetId));
  return Object.fromEntries(ids.map((id) => [id, set.has(id)]));
}

export async function listFavourites(
  userName: string,
  targetType?: FavouriteTargetType,
): Promise<{ favourites: FavouriteItemDto[] }> {
  const rows = await db
    .select()
    .from(favourites)
    .where(
      targetType
        ? and(
            eq(favourites.userName, userName),
            eq(favourites.targetType, targetType),
          )
        : eq(favourites.userName, userName),
    )
    .orderBy(favourites.createdAt);

  const inType = (t: FavouriteTargetType) =>
    rows.filter((r) => r.targetType === t).map((r) => r.targetId);

  // 作品摘要：join 社团名；软删作品不返回（收藏行保留，展示层过滤）
  const workIds = inType('work');
  const workRows = workIds.length
    ? await db
        .select({
          id: works.id,
          title: works.title,
          circleName: circles.name,
        })
        .from(works)
        .innerJoin(circles, eq(works.circleId, circles.id))
        .where(and(inArray(works.id, workIds), isNull(works.deletedAt)))
    : [];
  const workMap = new Map(workRows.map((w) => [w.id, w]));

  // 系列/声优/社团摘要 + 在库作品数（leftJoin 保证 0 部作品也返回；软删不计入）
  const seriesIds = inType('series');
  const seriesRows = seriesIds.length
    ? await db
        .select({
          id: series.id,
          name: series.name,
          workCount: sql<number>`count(${works.id})`.mapWith(Number),
        })
        .from(series)
        .leftJoin(
          works,
          and(eq(works.seriesId, series.id), isNull(works.deletedAt)),
        )
        .where(inArray(series.id, seriesIds))
        .groupBy(series.id)
    : [];
  const seriesMap = new Map(seriesRows.map((s) => [s.id, s]));

  const vaIds = inType('va');
  const vaRows = vaIds.length
    ? await db
        .select({
          id: vas.id,
          name: vas.name,
          workCount: sql<number>`count(${works.id})`.mapWith(Number),
        })
        .from(vas)
        .leftJoin(vaWork, eq(vaWork.vaId, vas.id))
        .leftJoin(
          works,
          and(eq(works.id, vaWork.workId), isNull(works.deletedAt)),
        )
        .where(inArray(vas.id, vaIds))
        .groupBy(vas.id)
    : [];
  const vaMap = new Map(vaRows.map((v) => [v.id, v]));

  const circleIds = inType('circle');
  const circleRows = circleIds.length
    ? await db
        .select({
          id: circles.id,
          name: circles.name,
          workCount: sql<number>`count(${works.id})`.mapWith(Number),
        })
        .from(circles)
        .leftJoin(
          works,
          and(eq(works.circleId, circles.id), isNull(works.deletedAt)),
        )
        .where(inArray(circles.id, circleIds))
        .groupBy(circles.id)
    : [];
  const circleMap = new Map(circleRows.map((c) => [c.id, c]));

  const items: FavouriteItemDto[] = [];
  for (const row of rows) {
    if (row.targetType === 'work') {
      const w = workMap.get(row.targetId);
      if (!w) continue; // 目标已消失（软删/清理）→ 不展示
      items.push({
        targetType: 'work',
        targetId: row.targetId,
        createdAt: row.createdAt,
        target: {
          id: w.id,
          title: w.title,
          circleName: w.circleName,
        },
      });
    } else if (row.targetType === 'series') {
      const s = seriesMap.get(row.targetId);
      if (!s) continue;
      items.push({
        targetType: 'series',
        targetId: row.targetId,
        createdAt: row.createdAt,
        target: { id: s.id, name: s.name, workCount: s.workCount },
      });
    } else if (row.targetType === 'va') {
      const v = vaMap.get(row.targetId);
      if (!v) continue;
      items.push({
        targetType: 'va',
        targetId: row.targetId,
        createdAt: row.createdAt,
        target: { id: v.id, name: v.name, workCount: v.workCount },
      });
    } else {
      const c = circleMap.get(row.targetId);
      if (!c) continue;
      items.push({
        targetType: 'circle',
        targetId: row.targetId,
        createdAt: row.createdAt,
        target: { id: c.id, name: c.name, workCount: c.workCount },
      });
    }
  }

  // 收藏时间倒序（新收藏在前）
  items.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  return { favourites: items };
}
