import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deleteReview,
  getReviewsByUsername,
  getReviewsByWorkId,
  upsertReview,
} from '../services/review.service.js';

const reviewSchema = z.object({
  work_id: z.string(),
  rating: z.number().min(1).max(5).optional(),
  review_text: z.string().optional(),
  progress: z
    .enum(['marked', 'listening', 'listened', 'replay', 'postponed'])
    .optional(),
  starOnly: z.boolean().optional(),
  progressOnly: z.boolean().optional(),
});

const reviewQuerySchema = z
  .object({
    work_id: z.string().optional(),
    username: z.string().min(1).optional(),
  })
  .refine((data) => data.work_id || data.username, {
    message: 'work_id or username is required',
  });

const deleteReviewSchema = z.object({
  work_id: z.string(),
});

const reviewResponseSchema = z.object({
  userName: z.string(),
  workId: z.string(),
  rating: z.number().nullable(),
  reviewText: z.string().nullable(),
  progress: z.string().nullable(),
  createdAt: z.string().nullable(),
  updatedAt: z.string().nullable(),
});

export const reviewRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/review',
    {
      schema: {
        querystring: reviewQuerySchema,
        response: {
          200: z.array(reviewResponseSchema),
          400: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { work_id, username } = request.query;

      if (work_id) {
        return getReviewsByWorkId(work_id);
      }

      if (username) {
        return getReviewsByUsername(username);
      }

      return reply
        .status(400)
        .send({ error: 'work_id or username is required' });
    },
  );

  fastify.put(
    '/review',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: reviewSchema,
        response: {
          200: reviewResponseSchema.nullable(),
        },
      },
    },
    async (request) => {
      const user = request.user as { name: string; group: string };
      const { work_id, rating, review_text, progress } = request.body;

      return upsertReview({
        userName: user.name,
        workId: work_id,
        rating,
        reviewText: review_text,
        progress,
      });
    },
  );

  fastify.delete(
    '/review',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: deleteReviewSchema,
        response: {
          200: z.object({ message: z.string() }),
        },
      },
    },
    async (request) => {
      const { work_id } = request.body;
      const user = request.user as { name: string; group: string };
      await deleteReview(user.name, work_id);

      return { message: 'Review deleted' };
    },
  );
};
