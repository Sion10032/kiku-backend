import { db } from '../db/main/index.js';
import { reviews, works } from '../db/main/schema.js';
import { eq, and } from 'drizzle-orm';

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
    where: { RAW: (t, op) => op.and(
      op.eq(t.userName, username),
      op.eq(t.workId, workId),
    )! },
  });
}

export async function upsertReview(data: {
  userName: string;
  workId: string;
  rating?: number;
  reviewText?: string;
  progress?: string;
}) {
  const existing = await getReview(data.userName, data.workId);
  const now = new Date().toISOString();

  await db.insert(reviews)
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
      target: [ reviews.userName, reviews.workId ],
      set: {
        rating: data.rating ?? existing?.rating ?? null,
        reviewText: data.reviewText ?? existing?.reviewText ?? null,
        progress: data.progress ?? existing?.progress ?? null,
        updatedAt: now,
      },
    });

  await updateWorkReviewStats(data.workId);

  return getReview(data.userName, data.workId);
}

export async function deleteReview(username: string, workId: string) {
  await db.delete(reviews).where(and(
    eq(reviews.userName, username),
    eq(reviews.workId, workId),
  ));

  await updateWorkReviewStats(workId);
}

async function updateWorkReviewStats(workId: string) {
  const allReviews = await db.query.reviews.findMany({
    where: { RAW: (t, op) => op.eq(t.workId, workId) },
  });

  const ratings = allReviews.filter(r => r.rating != null).map(r => r.rating!);
  const reviewCount = allReviews.length;
  const rateCount = ratings.length;
  const rateAverage2dp = rateCount > 0
    ? Math.round((ratings.reduce((a, b) => a + b, 0) / rateCount) * 100) / 100
    : null;

  const rateCountDetail = [ 1, 2, 3, 4, 5 ].reduce((acc, star) => {
    acc[star] = ratings.filter(r => r === star).length;
    return acc;
  }, {} as Record<number, number>);

  await db.update(works)
    .set({
      reviewCount,
      rateCount,
      rateAverage2dp,
      rateCountDetail: JSON.stringify(rateCountDetail),
    })
    .where(eq(works.id, workId));
}
