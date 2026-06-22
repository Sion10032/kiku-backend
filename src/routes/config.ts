import type { FastifyInstance } from 'fastify';
import { getConfig, updateConfig, getSharedConfig } from '../config/index.js';

export async function configRoutes(fastify: FastifyInstance) {
  fastify.get('/admin', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async () => {
    return getConfig();
  });

  fastify.put('/admin', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async (request) => {
    const updates = request.body as Record<string, unknown>;
    return updateConfig(updates);
  });

  fastify.get('/shared', async () => {
    return getSharedConfig();
  });
}
