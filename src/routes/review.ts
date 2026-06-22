import type { FastifyInstance } from 'fastify';
import { reviewSchema } from '../config/schema.js';
import { getReviewsByWorkId, getReviewsByUsername, upsertReview, deleteReview } from '../services/review.service.js';

export async function reviewRoutes(fastify: FastifyInstance) {
  fastify.get('/review', async (request, reply) => {
    const { work_id, username } = request.query as { work_id?: string; username?: string; };

    if (work_id) {
      return getReviewsByWorkId(Number(work_id));
    }

    if (username) {
      return getReviewsByUsername(username);
    }

    return reply.status(400).send({ error: 'work_id or username is required' });
  });

  fastify.put('/review', {
    preHandler: [ fastify.authenticate ],
  }, async (request, reply) => {
    const parsed = reviewSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const user = request.user as { name: string; group: string; };
    const { work_id, rating, review_text, progress } = parsed.data;

    const review = await upsertReview({
      userName: user.name,
      workId: work_id,
      rating,
      reviewText: review_text,
      progress,
    });

    return review;
  });

  fastify.delete('/review', {
    preHandler: [ fastify.authenticate ],
  }, async (request, reply) => {
    const { work_id } = request.body as { work_id?: number; };
    if (!work_id) {
      return reply.status(400).send({ error: 'work_id is required' });
    }

    const user = request.user as { name: string; group: string; };
    await deleteReview(user.name, work_id);

    return { message: 'Review deleted' };
  });
}
