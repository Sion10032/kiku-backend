import { db } from '../db/main/index.js';
import { works, circles, tags, vas, tagWork, vaWork, reviews } from '../db/main/schema.js';
import type { Work, Circle, Tag, Va } from '../db/main/schema.js';
import { eq, like, inArray, or, sql, desc, asc, and } from 'drizzle-orm';
import { getConfig } from '../config/index.js';
import { buildTrackTree, type TrackNode } from '../filesystem/utils.js';
import { getProgressByWorks, type WorkProgressSummary } from './progress.service.js';

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
  vas?: Array<{ id: string; name: string; }>;
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
export async function upsertWork(input: UpsertWorkInput): Promise<UpsertResult> {
  try {
    // 1. Find or create circle
    let circle = await db.query.circles.findFirst({
      where: eq(circles.name, input.circleName),
    });
    if (!circle) {
      const result = await db.insert(circles).values({ name: input.circleName }).returning();
      circle = result[0];
    }
    if (!circle) throw new Error('Failed to create circle');

    // 2. Check if work already exists
    const existing = await db.query.works.findFirst({
      where: eq(works.id, input.id),
    });

    if (existing) {
      // Update existing work
      await db.update(works)
        .set({
          title: input.title,
          circleId: circle.id,
          rootFolder: input.rootFolder,
          dir: input.dir,
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
          let tag = await db.query.tags.findFirst({ where: eq(tags.name, tagName) });
          if (!tag) {
            const result = await db.insert(tags).values({ name: tagName }).returning();
            tag = result[0];
          }
          if (tag) {
            await db.insert(tagWork).values({ tagId: tag.id, workId: input.id }).onConflictDoNothing();
          }
        }
      }

      // Update VAs: delete old, then insert new
      if (input.vas) {
        await db.delete(vaWork).where(eq(vaWork.workId, input.id));
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({ where: eq(vas.id, va.id) });
          if (!existingVa) {
            const result = await db.insert(vas).values({ id: va.id, name: va.name }).returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db.insert(vaWork).values({ vaId: existingVa.id, workId: input.id }).onConflictDoNothing();
          }
        }
      }

      return { workId: input.id, title: input.title, created: false, success: true };
    }
    else {
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
        rateCountDetail: input.rateCountDetail ? JSON.stringify(input.rateCountDetail) : '{}',
        rank: input.rank ? JSON.stringify(input.rank) : null,
        language: input.language ?? null,
        sourceId: input.sourceId ?? null,
      });

      // Create tags
      if (input.tags) {
        for (const tagName of input.tags) {
          let tag = await db.query.tags.findFirst({ where: eq(tags.name, tagName) });
          if (!tag) {
            const result = await db.insert(tags).values({ name: tagName }).returning();
            tag = result[0];
          }
          if (tag) {
            await db.insert(tagWork).values({ tagId: tag.id, workId: input.id }).onConflictDoNothing();
          }
        }
      }

      // Create VAs
      if (input.vas) {
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({ where: eq(vas.id, va.id) });
          if (!existingVa) {
            const result = await db.insert(vas).values({ id: va.id, name: va.name }).returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db.insert(vaWork).values({ vaId: existingVa.id, workId: input.id }).onConflictDoNothing();
          }
        }
      }

      return { workId: input.id, title: input.title, created: true, success: true };
    }
  }
  catch (err) {
    return { workId: input.id, title: input.title, created: false, success: false, error: String(err) };
  }
}

// 带关联的查询结果类型
type WorkWithRelations = Work & {
  circle: Circle;
  tags?: Array<{ tag: Tag; }>;
  vas?: Array<{ va: Va; }>;
  reviews?: Array<{ rating: number | null; }>;
};

// 格式化后的输出类型
export interface FormattedWork {
  id: string;
  rootFolder: string;
  dir: string;
  title: string;
  circle: { id: number; name: string; };
  nsfw: boolean;
  release: string | null;
  dl_count: number | null;
  price: number | null;
  review_count: number | null;
  rate_count: number | null;
  rate_average_2dp: number | null;
  rate_count_detail: Record<string, number>;
  rank: Record<string, number> | null;
  tags: Array<{ id: number; name: string; }>;
  vas: Array<{ id: string; name: string; }>;
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
    tags: row.tags?.map(tw => ({ id: tw.tag.id, name: tw.tag.name })) ?? [],
    vas: row.vas?.map(vw => ({ id: vw.va.id, name: vw.va.name })) ?? [],
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
async function attachUserData(items: FormattedWork[], username?: string): Promise<void> {
  if (!username || items.length === 0) return;
  const workIds = items.map(w => w.id);

  const [ reviewRows, progressMap ] = await Promise.all([
    db.query.reviews.findMany({
      where: and(eq(reviews.userName, username), inArray(reviews.workId, workIds)),
      columns: { workId: true, rating: true },
    }),
    getProgressByWorks(username, workIds),
  ]);

  const ratingByWork = new Map(reviewRows.map(r => [ r.workId, r.rating ]));
  for (const item of items) {
    item.userRating = ratingByWork.get(item.id) ?? null;
    item.userProgress = progressMap.get(item.id) ?? null;
  }
}

export async function getWorkById(id: string, username?: string) {
  const row = await db.query.works.findFirst({
    where: eq(works.id, id),
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
    },
  });
  if (!row) throw new Error(`Work ${id} not found`);
  const work = formatWork(row);
  await attachUserData([ work ], username);
  return work;
}

export async function getWorksPaginated(opts: {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  sortDir?: 'asc' | 'desc';
  username?: string;
  seed?: number;
}) {
  const { page = 1, pageSize = 12, orderBy = 'release', sortDir = 'desc', username } = opts;
  const offset = (page - 1) * pageSize;

  // 处理随机排序：先随机取 id，再用 findMany 查关联
  if (orderBy === 'random' || orderBy === 'betterRandom') {
    // 子查询：随机排序取一页 id
    const randomIds = db
      .select({ id: works.id })
      .from(works)
      .orderBy(sql`RANDOM()`)
      .limit(pageSize)
      .offset(offset);

    const [ items, countResult ] = await Promise.all([
      db.query.works.findMany({
        with: {
          circle: true,
          tags: { with: { tag: true } },
          vas: { with: { va: true } },
        },
        where: inArray(works.id, randomIds),
      }),
      db.select({ count: sql<number>`count(*)` }).from(works),
    ]);
    const totalCount = countResult[0]?.count ?? 0;

    const formatted = items.map(item => formatWork(item));
    await attachUserData(formatted, username);

    return {
      works: formatted,
      pagination: { currentPage: page, pageSize, totalCount },
    };
  }

  const orderCol = {
    id: works.id,
    release: works.release,
    dl_count: works.dlCount,
    price: works.price,
    rate_average_2dp: works.rateAverage2dp,
    review_count: works.reviewCount,
  }[orderBy] ?? works.release;

  const [ items, countResult ] = await Promise.all([
    db.query.works.findMany({
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
      },
      orderBy: sortDir === 'asc' ? [ asc(orderCol) ] : [ desc(orderCol) ],
      limit: pageSize,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(works),
  ]);
  const totalCount = countResult[0]?.count ?? 0;

  const formatted = items.map(item => formatWork(item));
  await attachUserData(formatted, username);

  return {
    works: formatted,
    pagination: { currentPage: page, pageSize, totalCount },
  };
}

export async function searchWorks(keyword: string, username?: string) {
  // Try to match RJ code
  const rjMatch = keyword.match(/([Rr][Jj])(\d{6,8})/);
  if (rjMatch && rjMatch[2]) {
    const rjCode = `RJ${rjMatch[2].padStart(8, '0')}`;
    const items = await db.query.works.findMany({
      where: eq(works.id, rjCode),
      with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
    });
    const formatted = items.map(item => formatWork(item));
    await attachUserData(formatted, username);
    return { works: formatted };
  }

  const circleIds = db.select({ id: circles.id }).from(circles)
    .where(like(circles.name, `%${keyword}%`));
  const tagWorkIds = db.select({ workId: tagWork.workId }).from(tagWork)
    .innerJoin(tags, eq(tagWork.tagId, tags.id))
    .where(like(tags.name, `%${keyword}%`));
  const vaWorkIds = db.select({ workId: vaWork.workId }).from(vaWork)
    .innerJoin(vas, eq(vaWork.vaId, vas.id))
    .where(like(vas.name, `%${keyword}%`));

  const items = await db.query.works.findMany({
    where: or(
      like(works.title, `%${keyword}%`),
      like(works.id, `%${keyword}%`),
      inArray(works.circleId, circleIds),
      inArray(works.id, tagWorkIds),
      inArray(works.id, vaWorkIds),
    ),
    with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
  });
  const formatted = items.map(item => formatWork(item));
  await attachUserData(formatted, username);
  return { works: formatted };
}

export async function getCircleById(id: number | string) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const row = await db.query.circles.findFirst({
    where: eq(circles.id, numId),
  });
  if (!row) throw new Error(`Circle ${id} not found`);
  return row;
}

export async function getCircleWorks(circleId: number | string, username?: string) {
  const numId = typeof circleId === 'string' ? parseInt(circleId, 10) : circleId;
  const items = await db.query.works.findMany({
    where: eq(works.circleId, numId),
    with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
  });
  const formatted = items.map(item => formatWork(item));
  await attachUserData(formatted, username);
  return formatted;
}

export async function getCircles() {
  return db.query.circles.findMany();
}

export async function getTagById(id: number | string) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const row = await db.query.tags.findFirst({
    where: eq(tags.id, numId),
  });
  if (!row) throw new Error(`Tag ${id} not found`);
  return row;
}

export async function getTagWorks(tagId: number | string, username?: string) {
  const numId = typeof tagId === 'string' ? parseInt(tagId, 10) : tagId;
  const tagWorkItems = await db.query.tagWork.findMany({
    where: eq(tagWork.tagId, numId),
    with: {
      work: {
        with: {
          circle: true,
          tags: { with: { tag: true } },
          vas: { with: { va: true } },
        },
      },
    },
  });
  const formatted = tagWorkItems.map(item => formatWork(item.work));
  await attachUserData(formatted, username);
  return formatted;
}

export async function getTags() {
  return db.query.tags.findMany();
}

export async function getVaById(id: string) {
  const row = await db.query.vas.findFirst({
    where: eq(vas.id, id),
  });
  if (!row) throw new Error(`VA ${id} not found`);
  return row;
}

export async function getVaWorks(vaId: string, username?: string) {
  const vaWorkItems = await db.query.vaWork.findMany({
    where: eq(vaWork.vaId, vaId),
    with: {
      work: {
        with: {
          circle: true,
          tags: { with: { tag: true } },
          vas: { with: { va: true } },
        },
      },
    },
  });
  const formatted = vaWorkItems.map(item => formatWork(item.work));
  await attachUserData(formatted, username);
  return formatted;
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
    where: eq(works.id, id),
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
  const rootFolder = config.rootFolders.find(f => f.name === row.rootFolder);

  if (!rootFolder) {
    throw new Error(`Root folder "${row.rootFolder}" not found`);
  }

  const { join } = await import('path');
  const dirPath = join(rootFolder.path, row.dir);

  return buildTrackTree(dirPath);
}
