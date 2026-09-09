import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  addFavourite,
  listFavourites,
  removeFavourite,
  statusFavourites,
} from '../services/favourite.service.js';

const targetTypeSchema = z.enum(['work', 'series', 'va', 'circle']);

const workTargetSchema = z.object({
  id: z.string(),
  title: z.string(),
  circleName: z.string(),
});

const entityTargetSchema = z.object({
  id: z.union([z.string(), z.number()]),
  name: z.string(),
  workCount: z.number(),
});

const favouriteItemSchema = z.object({
  targetType: targetTypeSchema,
  targetId: z.string(),
  createdAt: z.string(),
  target: z.union([workTargetSchema, entityTargetSchema]),
});

export const favouriteRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/favourites',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: z.object({
          targetType: targetTypeSchema.optional(),
        }),
        response: {
          200: z.object({ favourites: z.array(favouriteItemSchema) }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      return listFavourites(user.name, request.query.targetType);
    },
  );

  fastify.get(
    '/favourites/status',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: z.object({
          targetType: targetTypeSchema,
          ids: z.string().min(1),
        }),
        response: {
          200: z.record(z.string(), z.boolean()),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { targetType, ids } = request.query;
      return statusFavourites(
        user.name,
        targetType,
        ids
          .split(',')
          .map((s) => s.trim())
          .filter(Boolean),
      );
    },
  );

  fastify.post(
    '/favourites',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: z.object({
          targetType: targetTypeSchema,
          targetId: z.string().min(1),
        }),
        response: {
          200: z.object({ favourited: z.boolean() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const { targetType, targetId } = request.body;
      const ok = await addFavourite(user.name, targetType, targetId);
      if (!ok) {
        return reply.fail(404, 'errors.favourite.target-not-found', {
          id: targetId,
        });
      }
      return { favourited: true };
    },
  );

  fastify.delete(
    '/favourites/:targetType/:targetId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: z.object({
          targetType: targetTypeSchema,
          targetId: z.string().min(1),
        }),
        response: {
          200: z.object({ message: z.string() }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { targetType, targetId } = request.params;
      await removeFavourite(user.name, targetType, targetId);
      return { message: 'Favourite removed' };
    },
  );
};
