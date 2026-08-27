import { and, eq, inArray, isNull, like, or, sql } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { db } from '../db/main/index.js';
import type { Circle, Tag, Va, Work } from '../db/main/schema.js';
import {
  circles,
  tags,
  tagWork,
  vas,
  vaWork,
  works,
} from '../db/main/schema.js';
import { openWorkSource } from '../filesystem/source/index.js';
import type { TrackNode } from '../filesystem/utils.js';
import { extractRJCode } from '../utils/rjcode.js';
import { deleteAllCovers } from './cover.service.js';
import {
  getProgressByWorks,
  type WorkProgressSummary,
} from './progress.service.js';

// ---------- Upsert (used by scanner) ----------

export interface UpsertWorkInput {
  id: string; // Full RJ code like "RJ01578781"
  rootFolder: string; // config rootFolder name
  dir: string; // relative directory path
  title: string;
  circleName: string;
  circleId?: string; // DLsite maker_id (optional)
  nsfw?: boolean;
  release?: string;
  dlCount?: number;
  price?: number;
  reviewCount?: number;
  rateCount?: number;
  rateAverage2dp?: number;
  rateCountDetail?: Record<string, number>;
  rank?: Record<string, number>;
  tags?: string[];
  vas?: Array<{ id: string; name: string }>;
  language?: string;
  sourceId?: string;
}

export interface UpsertResult {
  workId: string;
  title: string;
  created: boolean;
  success: boolean;
  error?: string;
}

/**
 * Create or update a work with all its relations (circle, tags, VAs).
 * Used by the scanner to persist DLsite metadata into the database.
 */
export async function upsertWork(
  input: UpsertWorkInput,
): Promise<UpsertResult> {
  try {
    // 1. Find or create circle
    let circle = await db.query.circles.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, input.circleName) },
    });
    if (!circle) {
      const result = await db
        .insert(circles)
        .values({ name: input.circleName })
        .returning();
      circle = result[0];
    }
    if (!circle) throw new Error('Failed to create circle');

    // 2. Check if work already exists
    const existing = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, input.id) },
    });

    if (existing) {
      // Update existing work（源恢复时清除软删标记）
      await db
        .update(works)
        .set({
          title: input.title,
          circleId: circle.id,
          rootFolder: input.rootFolder,
          dir: input.dir,
          deletedAt: null,
          nsfw: input.nsfw ?? existing.nsfw,
          release: input.release ?? existing.release,
          dlCount: input.dlCount ?? existing.dlCount,
          price: input.price ?? existing.price,
          reviewCount: input.reviewCount ?? existing.reviewCount,
          rateCount: input.rateCount ?? existing.rateCount,
          rateAverage2dp: input.rateAverage2dp ?? existing.rateAverage2dp,
          rateCountDetail: input.rateCountDetail
            ? JSON.stringify(input.rateCountDetail)
            : existing.rateCountDetail,
          rank: input.rank ? JSON.stringify(input.rank) : existing.rank,
          language: input.language ?? existing.language,
          sourceId: input.sourceId ?? existing.sourceId,
        })
        .where(eq(works.id, input.id));

      // Update tags: delete old, then insert new
      if (input.tags) {
        await db.delete(tagWork).where(eq(tagWork.workId, input.id));
        for (const tagName of input.tags) {
          let tag = await db.query.tags.findFirst({
            where: { RAW: (t, op) => op.eq(t.name, tagName) },
          });
          if (!tag) {
            const result = await db
              .insert(tags)
              .values({ name: tagName })
              .returning();
            tag = result[0];
          }
          if (tag) {
            await db
              .insert(tagWork)
              .values({ tagId: tag.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      // Update VAs: delete old, then insert new
      if (input.vas) {
        await db.delete(vaWork).where(eq(vaWork.workId, input.id));
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({
            where: { RAW: (t, op) => op.eq(t.id, va.id) },
          });
          if (!existingVa) {
            const result = await db
              .insert(vas)
              .values({ id: va.id, name: va.name })
              .returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db
              .insert(vaWork)
              .values({ vaId: existingVa.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      return {
        workId: input.id,
        title: input.title,
        created: false,
        success: true,
      };
    } else {
      // Create new work
      await db.insert(works).values({
        id: input.id as string,
        rootFolder: input.rootFolder,
        dir: input.dir,
        title: input.title,
        circleId: circle.id,
        nsfw: input.nsfw ?? false,
        release: input.release ?? null,
        dlCount: input.dlCount ?? null,
        price: input.price ?? null,
        reviewCount: input.reviewCount ?? null,
        rateCount: input.rateCount ?? null,
        rateAverage2dp: input.rateAverage2dp ?? null,
        rateCountDetail: input.rateCountDetail
          ? JSON.stringify(input.rateCountDetail)
          : '{}',
        rank: input.rank ? JSON.stringify(input.rank) : null,
        language: input.language ?? null,
        sourceId: input.sourceId ?? null,
      });

      // Create tags
      if (input.tags) {
        for (const tagName of input.tags) {
          let tag = await db.query.tags.findFirst({
            where: { RAW: (t, op) => op.eq(t.name, tagName) },
          });
          if (!tag) {
            const result = await db
              .insert(tags)
              .values({ name: tagName })
              .returning();
            tag = result[0];
          }
          if (tag) {
            await db
              .insert(tagWork)
              .values({ tagId: tag.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      // Create VAs
      if (input.vas) {
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({
            where: { RAW: (t, op) => op.eq(t.id, va.id) },
          });
          if (!existingVa) {
            const result = await db
              .insert(vas)
              .values({ id: va.id, name: va.name })
              .returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db
              .insert(vaWork)
              .values({ vaId: existingVa.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      return {
        workId: input.id,
        title: input.title,
        created: true,
        success: true,
      };
    }
  } catch (err) {
    return {
      workId: input.id,
      title: input.title,
      created: false,
      success: false,
      error: String(err),
    };
  }
}

// ---------- 软删除 / 物理删除（scanner prune 使用） ----------

/** 取某 rootFolder 下的全部作品记录（含软删标记），供 scanner 做源缺失差集。 */
export async function getWorksByRootFolder(rootFolder: string) {
  return db.query.works.findMany({
    where: { RAW: (t, op) => op.eq(t.rootFolder, rootFolder) },
    columns: { id: true, deletedAt: true, dir: true, sourceId: true },
  });
}

/** 软删除：置 deletedAt 标记（ISO 时间串）。源缺失时的第一动作，宽限期内可恢复。 */
export async function softDeleteWork(id: string): Promise<void> {
  await db
    .update(works)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(works.id, id));
}

/**
 * 物理删除：删除作品记录（级联清 tagWork/vaWork/reviews/userProgress，
 * SQLite 外键已开启）并清理封面 blob。
 */
export async function hardDeleteWork(id: string): Promise<void> {
  await db.delete(works).where(eq(works.id, id));
  deleteAllCovers(id);
}

// 带关联的查询结果类型
type WorkWithRelations = Work & {
  circle: Circle;
  tags?: Array<{ tag: Tag }>;
  vas?: Array<{ va: Va }>;
  reviews?: Array<{ rating: number | null }>;
};

// 格式化后的输出类型
export interface FormattedWork {
  id: string;
  rootFolder: string;
  dir: string;
  title: string;
  circle: { id: number; name: string };
  nsfw: boolean;
  release: string | null;
  dl_count: number | null;
  price: number | null;
  review_count: number | null;
  rate_count: number | null;
  rate_average_2dp: number | null;
  rate_count_detail: Record<string, number>;
  rank: Record<string, number> | null;
  tags: Array<{ id: number; name: string }>;
  vas: Array<{ id: string; name: string }>;
  userRating: number | null;
  /** 当前用户播放进度聚合（null = 未读/未登录） */
  userProgress: WorkProgressSummary | null;
  language: string | null;
  sourceId: string | null;
}

function formatWork(row: WorkWithRelations): FormattedWork {
  return {
    id: row.id,
    rootFolder: row.rootFolder,
    dir: row.dir,
    title: row.title,
    circle: { id: row.circle.id, name: row.circle.name },
    nsfw: Boolean(row.nsfw),
    release: row.release,
    dl_count: row.dlCount,
    price: row.price,
    review_count: row.reviewCount,
    rate_count: row.rateCount,
    rate_average_2dp: row.rateAverage2dp,
    rate_count_detail: JSON.parse(row.rateCountDetail ?? '{}'),
    rank: row.rank ? JSON.parse(row.rank) : null,
    tags: row.tags?.map((tw) => ({ id: tw.tag.id, name: tw.tag.name })) ?? [],
    vas: row.vas?.map((vw) => ({ id: vw.va.id, name: vw.va.name })) ?? [],
    userRating: row.reviews?.[0]?.rating ?? null,
    userProgress: null,
    language: row.language,
    sourceId: row.sourceId,
  };
}

/**
 * 批量注入当前用户的评分与播放进度（userRating/userProgress，避免逐作品 N+1）。
 *
 * 未登录（username 为空）时保持 null（未读态），不做任何查询。
 * 到调用点后再覆盖 formatWork 的默认值。
 */
async function attachUserData(
  items: FormattedWork[],
  username?: string,
): Promise<void> {
  if (!username || items.length === 0) return;
  const workIds = items.map((w) => w.id);

  const [reviewRows, progressMap] = await Promise.all([
    db.query.reviews.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
          op.and(op.eq(t.userName, username), op.inArray(t.workId, workIds))!,
      },
      columns: { workId: true, rating: true },
    }),
    getProgressByWorks(username, workIds),
  ]);

  const ratingByWork = new Map(reviewRows.map((r) => [r.workId, r.rating]));
  for (const item of items) {
    item.userRating = ratingByWork.get(item.id) ?? null;
    item.userProgress = progressMap.get(item.id) ?? null;
  }
}

export async function getWorkById(id: string, username?: string) {
  const row = await db.query.works.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
        op.and(op.eq(t.id, id), op.isNull(t.deletedAt))!,
    },
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
    },
  });
  if (!row) throw new Error(`Work ${id} not found`);
  const work = formatWork(row);
  await attachUserData([work], username);
  return work;
}

/**
 * 按 id 批量取作品并保持传入顺序（收听历史等「顺序由外部决定」的场景）。
 *
 * - inArray 批量查询（避免 N+1），结果按 ids 重排（findMany 不保证顺序）
 * - 过滤软删：ids 中已软删的作品静默跳过（不出现在结果里）
 * - attachUserData 注入 userRating/userProgress（同其他列表端点）
 */
export async function getWorksByIdsOrdered(
  ids: string[],
  username?: string,
): Promise<FormattedWork[]> {
  if (ids.length === 0) return [];

  const rows = await db.query.works.findMany({
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
    },
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.inArray(t.id, ids), op.isNull(t.deletedAt))!,
    },
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((r) => r != null)
    .map((r) => formatWork(r));

  await attachUserData(items, username);
  return items;
}

/** 排序字段映射（getWorksPaginated 与筛选查询共用）。 */
const ORDER_KEY_MAP = {
  id: 'id',
  release: 'release',
  dl_count: 'dlCount',
  price: 'price',
  rate_average_2dp: 'rateAverage2dp',
  review_count: 'reviewCount',
} as const;

/**
 * 筛选查询通用分页参数（默认与 getWorksPaginated 一致）。
 * random/betterRandom 在筛选场景退化为 release。
 */

/** 作品列表通用分页/排序参数（筛选类查询与各列表端点共用）。 */
export type WorksListOpts = {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  sortDir?: 'asc' | 'desc';
};

function filteredPageOpts(opts?: WorksListOpts) {
  const {
    page = 1,
    pageSize = 20,
    orderBy = 'release',
    sortDir = 'desc',
  } = opts ?? {};
  const key = ORDER_KEY_MAP[orderBy as keyof typeof ORDER_KEY_MAP] ?? 'release';
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    orderKey: key,
    sortDir,
  };
}

export async function getWorksPaginated(
  opts: WorksListOpts & { username?: string; seed?: number },
) {
  const {
    page = 1,
    pageSize = 20,
    orderBy = 'release',
    sortDir = 'desc',
    username,
  } = opts;
  const offset = (page - 1) * pageSize;

  // 处理随机排序：先随机取 id，再用 findMany 查关联
  if (orderBy === 'random' || orderBy === 'betterRandom') {
    // 子查询：随机排序取一页 id（排除软删）
    const randomIds = db
      .select({ id: works.id })
      .from(works)
      .where(sql`${works.deletedAt} IS NULL`)
      .orderBy(sql`RANDOM()`)
      .limit(pageSize)
      .offset(offset);

    const [items, countResult] = await Promise.all([
      db.query.works.findMany({
        with: {
          circle: true,
          tags: { with: { tag: true } },
          vas: { with: { va: true } },
        },
        where: {
          RAW: (t, op) =>
            // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
            op.and(op.inArray(t.id, randomIds), op.isNull(t.deletedAt))!,
        },
      }),
      db
        .select({ count: sql<number>`count(*)` })
        .from(works)
        .where(sql`${works.deletedAt} IS NULL`),
    ]);
    const totalCount = countResult[0]?.count ?? 0;

    const formatted = items.map((item) => formatWork(item));
    await attachUserData(formatted, username);

    return {
      works: formatted,
      pagination: { currentPage: page, pageSize, totalCount },
    };
  }

  const orderKey =
    ORDER_KEY_MAP[orderBy as keyof typeof ORDER_KEY_MAP] ?? 'release';

  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 isNull() 返回 SQL | undefined
          op.isNull(t.deletedAt)!,
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .where(sql`${works.deletedAt} IS NULL`),
  ]);
  const totalCount = countResult[0]?.count ?? 0;

  const formatted = items.map((item) => formatWork(item));
  await attachUserData(formatted, username);

  return {
    works: formatted,
    pagination: { currentPage: page, pageSize, totalCount },
  };
}

export async function searchWorks(
  keyword: string,
  username?: string,
  opts?: WorksListOpts,
) {
  const { page, pageSize, offset, orderKey, sortDir } = filteredPageOpts(opts);
  // 命中 RJ 号则按精确 ID 匹配（extractRJCode 已做校验，保持原样不做规范化/补零）
  const rjCode = extractRJCode(keyword);
  if (rjCode) {
    const items = await db.query.works.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
          op.and(op.eq(t.id, rjCode), op.isNull(t.deletedAt))!,
      },
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
    });
    const formatted = items.map((item) => formatWork(item));
    await attachUserData(formatted, username);
    return {
      works: formatted,
      pagination: { currentPage: page, pageSize, totalCount: formatted.length },
    };
  }

  const circleIds = db
    .select({ id: circles.id })
    .from(circles)
    .where(like(circles.name, `%${keyword}%`));
  const tagWorkIds = db
    .select({ workId: tagWork.workId })
    .from(tagWork)
    .innerJoin(tags, eq(tagWork.tagId, tags.id))
    .where(like(tags.name, `%${keyword}%`));
  const vaWorkIds = db
    .select({ workId: vaWork.workId })
    .from(vaWork)
    .innerJoin(vas, eq(vaWork.vaId, vas.id))
    .where(like(vas.name, `%${keyword}%`));

  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
          op.and(
            // biome-ignore lint/style/noNonNullAssertion: drizzle 的 or() 返回 SQL | undefined，RAW where 需要 SQL
            op.or(
              op.like(t.title, `%${keyword}%`),
              op.like(t.id, `%${keyword}%`),
              op.inArray(t.circleId, circleIds),
              op.inArray(t.id, tagWorkIds),
              op.inArray(t.id, vaWorkIds),
            )!,
            op.isNull(t.deletedAt),
          )!,
      },
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .where(
        and(
          or(
            like(works.title, `%${keyword}%`),
            like(works.id, `%${keyword}%`),
            inArray(works.circleId, circleIds),
            inArray(works.id, tagWorkIds),
            inArray(works.id, vaWorkIds),
          ),
          isNull(works.deletedAt),
        ),
      ),
  ]);
  const formatted = items.map((item) => formatWork(item));
  await attachUserData(formatted, username);
  return {
    works: formatted,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult[0]?.count ?? 0,
    },
  };
}

export async function getCircleById(id: number | string) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const row = await db.query.circles.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, numId) },
  });
  if (!row) throw new Error(`Circle ${id} not found`);
  return row;
}

export async function getCircleWorks(
  circleId: number | string,
  username?: string,
  opts?: WorksListOpts,
) {
  const numId =
    typeof circleId === 'string' ? parseInt(circleId, 10) : circleId;
  const { page, pageSize, offset, orderKey, sortDir } = filteredPageOpts(opts);
  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
          op.and(op.eq(t.circleId, numId), op.isNull(t.deletedAt))!,
      },
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    // count 查询无法复用 RAW where（其面向 findMany 的回调形态），按列引用重写等价条件
    db
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .where(and(eq(works.circleId, numId), isNull(works.deletedAt))),
  ]);
  const formatted = items.map((item) => formatWork(item));
  await attachUserData(formatted, username);
  return {
    works: formatted,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult[0]?.count ?? 0,
    },
  };
}

export async function getCircles() {
  return db.query.circles.findMany();
}

export async function getTagById(id: number | string) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const row = await db.query.tags.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, numId) },
  });
  if (!row) throw new Error(`Tag ${id} not found`);
  return row;
}

export async function getTagWorks(
  tagId: number | string,
  username?: string,
  opts?: WorksListOpts,
) {
  const numId = typeof tagId === 'string' ? parseInt(tagId, 10) : tagId;
  const { page, pageSize, offset, orderKey, sortDir } = filteredPageOpts(opts);
  const workIds = db
    .select({ workId: tagWork.workId })
    .from(tagWork)
    .where(eq(tagWork.tagId, numId));
  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
          op.and(op.inArray(t.id, workIds), op.isNull(t.deletedAt))!,
      },
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .innerJoin(tagWork, eq(tagWork.workId, works.id))
      .where(and(eq(tagWork.tagId, numId), isNull(works.deletedAt))),
  ]);
  const formatted = items.map((item) => formatWork(item));
  await attachUserData(formatted, username);
  return {
    works: formatted,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult[0]?.count ?? 0,
    },
  };
}

export async function getTags() {
  return db.query.tags.findMany();
}

export async function getVaById(id: string) {
  const row = await db.query.vas.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, id) },
  });
  if (!row) throw new Error(`VA ${id} not found`);
  return row;
}

export async function getVaWorks(
  vaId: string,
  username?: string,
  opts?: WorksListOpts,
) {
  const { page, pageSize, offset, orderKey, sortDir } = filteredPageOpts(opts);
  const workIds = db
    .select({ workId: vaWork.workId })
    .from(vaWork)
    .where(eq(vaWork.vaId, vaId));
  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
          op.and(op.inArray(t.id, workIds), op.isNull(t.deletedAt))!,
      },
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    db
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .innerJoin(vaWork, eq(vaWork.workId, works.id))
      .where(and(eq(vaWork.vaId, vaId), isNull(works.deletedAt))),
  ]);
  const formatted = items.map((item) => formatWork(item));
  await attachUserData(formatted, username);
  return {
    works: formatted,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult[0]?.count ?? 0,
    },
  };
}

export async function getVas() {
  return db.query.vas.findMany();
}

/**
 * 获取作品的文件树
 * @param id 作品 ID（完整 RJ code）
 * @returns 文件树结构
 */
export async function getWorkTracks(id: string): Promise<TrackNode[]> {
  const row = await db.query.works.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
        op.and(op.eq(t.id, id), op.isNull(t.deletedAt))!,
    },
    columns: {
      id: true,
      rootFolder: true,
      dir: true,
      title: true,
    },
  });

  if (!row) {
    throw new Error(`Work ${id} not found`);
  }

  const config = getConfig();
  const rootFolder = config.rootFolders.find((f) => f.name === row.rootFolder);

  if (!rootFolder) {
    throw new Error(`Root folder "${row.rootFolder}" not found`);
  }

  const source = await openWorkSource(rootFolder.path, row.dir);
  return source.buildTree();
}

// ---------- Scanner update mode ----------

/** 所有未软删作品的最小引用（供扫描器 update 模式遍历，不 join 关联）。 */
export async function getAllWorkRefs(): Promise<
  Array<{ id: string; rootFolder: string; dir: string }>
> {
  return db
    .select({ id: works.id, rootFolder: works.rootFolder, dir: works.dir })
    .from(works)
    .where(isNull(works.deletedAt));
}
