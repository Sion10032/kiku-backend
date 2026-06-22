import type { FastifyInstance } from 'fastify';

const CURRENT_VERSION = '1.0.0';

export async function versionRoutes(fastify: FastifyInstance) {
  fastify.get('/version', async () => {
    const latestVersion: string | null = null;

    return {
      current: CURRENT_VERSION,
      latest: latestVersion,
      updateAvailable: latestVersion !== null && latestVersion !== CURRENT_VERSION,
    };
  });
}
