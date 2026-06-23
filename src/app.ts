import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler } from 'fastify-type-provider-zod';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { metadataRoutes } from './routes/metadata.js';
import { mediaRoutes } from './routes/media.js';
import { credentialsRoutes } from './routes/credentials.js';
import { reviewRoutes } from './routes/review.js';
import { configRoutes } from './routes/config.js';
import { versionRoutes } from './routes/version.js';
import { setupWebSocket } from './websocket/scanner.js';

export async function buildApp() {
  const app = Fastify({
    logger: true,
  });

  // Configure Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // Setup WebSocket
  setupWebSocket(app);

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(metadataRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api/media' });
  await app.register(credentialsRoutes, { prefix: '/api/credentials' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(versionRoutes, { prefix: '/api' });

  return app;
}
