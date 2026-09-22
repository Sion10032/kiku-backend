import { and, eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { reviews, works } from '../infra/db/main/schema.js';
import { liveWorkExists } from './work.service.js';

export async function getReviewsByWorkId(workId: string) {
  return db.query.reviews.findMany({
    where: { RAW: (t, op) => op.eq(t.workId, workId) },
    with: { user: true },
  });
}

export async function getReviewsByUsername(username: string) {
  return db.query.reviews.findMany({
    where: { RAW: (t, op) => op.eq(t.userName, username) },
    with: { work: true },
  });
}

export async function getReview(username: string, workId: string) {
  return db.query.reviews.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.eq(t.userName, username), op.eq(t.workId, workId))!,
    },
  });
}

/** upsertReview 结果：ok 携带落库后的 review 行（可能为 undefined），reason 供 route 映射状态码。 */
export type UpsertReviewOutcome =
  | { ok: true; review: Awaited<ReturnType<typeof getReview>> }
  | { ok: false; reason: 'work-missing' };

export async function upsertReview(data: {
  userName: string;
  workId: string;
  rating?: number;
  reviewText?: string;
  progress?: string;
}): Promise<UpsertReviewOutcome> {
  // FK 防护：作品不在库（或已软删）→ 'work-missing'（route 映射 404），
  // 否则 t_review.work_id 外键违反会抛 500
  if (!(await liveWorkExists(data.workId))) {
    return { ok: false, reason: 'work-missing' };
  }

  const existing = await getReview(data.userName, data.workId);
  const now = new Date().toISOString();

  await db
    .insert(reviews)
    .values({
      userName: data.userName,
      workId: data.workId,
      rating: data.rating ?? null,
      reviewText: data.reviewText ?? null,
      progress: data.progress ?? null,
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [reviews.userName, reviews.workId],
      set: {
        rating: data.rating ?? existing?.rating ?? null,
        reviewText: data.reviewText ?? existing?.reviewText ?? null,
        progress: data.progress ?? existing?.progress ?? null,
        updatedAt: now,
      },
    });

  await updateWorkReviewStats(data.workId);

  return { ok: true, review: await getReview(data.userName, data.workId) };
}

export async function deleteReview(username: string, workId: string) {
  await db
    .delete(reviews)
    .where(and(eq(reviews.userName, username), eq(reviews.workId, workId)));

  await updateWorkReviewStats(workId);
}

async function updateWorkReviewStats(workId: string) {
  const allReviews = await db.query.reviews.findMany({
    where: { RAW: (t, op) => op.eq(t.workId, workId) },
  });

  const ratings = allReviews.flatMap((r) =>
    r.rating != null ? [r.rating] : [],
  );
  const reviewCount = allReviews.length;
  const rateCount = ratings.length;
  const rateAverage2dp =
    rateCount > 0
      ? Math.round((ratings.reduce((a, b) => a + b, 0) / rateCount) * 100) / 100
      : null;

  const rateCountDetail = [1, 2, 3, 4, 5].reduce(
    (acc, star) => {
      acc[star] = ratings.filter((r) => r === star).length;
      return acc;
    },
    {} as Record<number, number>,
  );

  await db
    .update(works)
    .set({
      reviewCount,
      rateCount,
      rateAverage2dp,
      rateCountDetail: JSON.stringify(rateCountDetail),
    })
    .where(eq(works.id, workId));
}
