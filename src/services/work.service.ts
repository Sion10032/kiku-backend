import { db } from '../db/index.js';
import { works, circles, tags, vas, tagWork, vaWork, reviews } from '../db/schema.js';
import type { Work, Circle, Tag, Va } from '../db/schema.js';
import { eq, like, inArray, or, sql, desc, asc } from 'drizzle-orm';

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
  };
}

export async function getWorkById(id: string, username?: string) {
  const row = await db.query.works.findFirst({
    where: eq(works.id, id),
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
      ...(username ? { reviews: { where: eq(reviews.userName, username) } } : {}),
    },
  });
  if (!row) throw new Error(`Work ${id} not found`);
  return formatWork(row);
}

export async function getWorksPaginated(opts: {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  sortDir?: 'asc' | 'desc';
  username?: string;
}) {
  const { page = 1, pageSize = 12, orderBy = 'release', sortDir = 'desc' } = opts;
  const offset = (page - 1) * pageSize;

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

  return {
    works: items.map(item => formatWork(item)),
    pagination: { currentPage: page, pageSize, totalCount },
  };
}

export async function searchWorks(keyword: string) {
  // Try to match RJ code
  const rjMatch = keyword.match(/([Rr][Jj])(\d{6,8})/);
  if (rjMatch && rjMatch[2]) {
    const rjCode = `RJ${rjMatch[2].padStart(8, '0')}`;
    const items = await db.query.works.findMany({
      where: eq(works.id, rjCode),
      with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
    });
    return { works: items.map(item => formatWork(item)) };
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
      inArray(works.circleId, circleIds),
      inArray(works.id, tagWorkIds),
      inArray(works.id, vaWorkIds),
    ),
    with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
  });
  return { works: items.map(item => formatWork(item)) };
}

export async function getCircleById(id: number | string) {
  const numId = typeof id === 'string' ? parseInt(id, 10) : id;
  const row = await db.query.circles.findFirst({
    where: eq(circles.id, numId),
  });
  if (!row) throw new Error(`Circle ${id} not found`);
  return row;
}

export async function getCircleWorks(circleId: number | string) {
  const numId = typeof circleId === 'string' ? parseInt(circleId, 10) : circleId;
  const items = await db.query.works.findMany({
    where: eq(works.circleId, numId),
    with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
  });
  return items.map(item => formatWork(item));
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

export async function getTagWorks(tagId: number | string) {
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
  return tagWorkItems.map(item => formatWork(item.work));
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

export async function getVaWorks(vaId: string) {
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
  return vaWorkItems.map(item => formatWork(item.work));
}

export async function getVas() {
  return db.query.vas.findMany();
}
