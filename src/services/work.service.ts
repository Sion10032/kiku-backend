import { db } from '../db/index.js';
import { works, circles, tags, vas, tagWork, vaWork, reviews } from '../db/schema.js';
import { eq, like, inArray, or, sql, desc, asc } from 'drizzle-orm';

function formatWork(row: Record<string, unknown>) {
  return {
    id: row.id,
    title: row.title,
    circle: { id: (row.circle as Record<string, unknown>).id, name: (row.circle as Record<string, unknown>).name },
    nsfw: Boolean(row.nsfw),
    release: row.release,
    dl_count: row.dlCount,
    price: row.price,
    review_count: row.reviewCount,
    rate_count: row.rateCount,
    rate_average_2dp: row.rateAverage2dp,
    rate_count_detail: JSON.parse((row.rateCountDetail as string) ?? '{}'),
    rank: row.rank ? JSON.parse(row.rank as string) : null,
    tags: (row.tags as Array<{ tag: Record<string, unknown>; }>)?.map(tw => ({ id: tw.tag.id, name: tw.tag.name })) ?? [],
    vas: (row.vas as Array<{ va: Record<string, unknown>; }>)?.map(vw => ({ id: vw.va.id, name: vw.va.name })) ?? [],
    userRating: (row.reviews as Array<{ rating: number; }>)?.[0]?.rating ?? null,
  };
}

export async function getWorkById(id: number, username?: string) {
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
  return formatWork(row as Record<string, unknown>);
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
    works: items.map(item => formatWork(item as Record<string, unknown>)),
    pagination: { currentPage: page, pageSize, totalCount },
  };
}

export async function searchWorks(keyword: string) {
  const rjMatch = keyword.match(/([Rr][Jj])?(\d+)/);
  if (rjMatch) {
    const rjId = parseInt(rjMatch[2]!, 10);
    const items = await db.query.works.findMany({
      where: eq(works.id, rjId),
      with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
    });
    return { works: items.map(item => formatWork(item as Record<string, unknown>)) };
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
  return { works: items.map(item => formatWork(item as Record<string, unknown>)) };
}

export async function getCircleById(id: number) {
  const row = await db.query.circles.findFirst({
    where: eq(circles.id, id),
  });
  if (!row) throw new Error(`Circle ${id} not found`);
  return row;
}

export async function getCircleWorks(circleId: number) {
  const items = await db.query.works.findMany({
    where: eq(works.circleId, circleId),
    with: { circle: true, tags: { with: { tag: true } }, vas: { with: { va: true } } },
  });
  return items.map(item => formatWork(item as Record<string, unknown>));
}

export async function getCircles() {
  return db.query.circles.findMany();
}

export async function getTagById(id: number) {
  const row = await db.query.tags.findFirst({
    where: eq(tags.id, id),
  });
  if (!row) throw new Error(`Tag ${id} not found`);
  return row;
}

export async function getTagWorks(tagId: number) {
  const items = await db.select()
    .from(works)
    .innerJoin(tagWork, eq(works.id, tagWork.workId))
    .where(eq(tagWork.tagId, tagId));
  return items.map(item => formatWork(item.t_work as Record<string, unknown>));
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
  const items = await db.select()
    .from(works)
    .innerJoin(vaWork, eq(works.id, vaWork.workId))
    .where(eq(vaWork.vaId, vaId));
  return items.map(item => formatWork(item.t_work as Record<string, unknown>));
}

export async function getVas() {
  return db.query.vas.findMany();
}
