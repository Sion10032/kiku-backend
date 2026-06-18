import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });

  return app;
}
