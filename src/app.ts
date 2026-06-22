import Fastify from 'fastify';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { metadataRoutes } from './routes/metadata.js';
import { mediaRoutes } from './routes/media.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(metadataRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api/media' });

  return app;
}
