import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

export const healthRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get('/health', {
    schema: {
      response: {
        200: z.object({
          status: z.string(),
        }),
      },
    },
  }, async () => {
    return { status: 'ok' };
  });
};
