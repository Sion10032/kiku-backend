import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

const CURRENT_VERSION = '1.0.0';

export const versionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/version',
    {
      schema: {
        response: {
          200: z.object({
            current: z.string(),
            latest: z.string().nullable(),
            updateAvailable: z.boolean(),
          }),
        },
      },
    },
    async () => {
      const latestVersion: string | null = null;

      return {
        current: CURRENT_VERSION,
        latest: latestVersion,
        updateAvailable:
          latestVersion !== null && latestVersion !== CURRENT_VERSION,
      };
    },
  );
};
