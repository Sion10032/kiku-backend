import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { getConfig, getSharedConfig, updateConfig } from '../config/index.js';
import { configSchema, sharedConfigSchema } from '../config/schema.js';

const updateConfigSchema = configSchema.partial();

export const configRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/admin',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: configSchema,
        },
      },
    },
    async () => {
      return getConfig();
    },
  );

  fastify.put(
    '/admin',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: updateConfigSchema,
        response: {
          200: configSchema,
        },
      },
    },
    async (request) => {
      return updateConfig(request.body);
    },
  );

  fastify.get(
    '/shared',
    {
      schema: {
        response: {
          200: sharedConfigSchema,
        },
      },
    },
    async () => {
      return getSharedConfig();
    },
  );
};
