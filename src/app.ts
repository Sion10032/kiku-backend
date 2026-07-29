import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import sensible from '@fastify/sensible';
import fastifySSE from '@fastify/sse';
import { authPlugin } from './auth/plugin.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { metadataRoutes } from './routes/metadata.js';
import { mediaRoutes } from './routes/media.js';
import { credentialsRoutes } from './routes/credentials.js';
import { reviewRoutes } from './routes/review.js';
import { configRoutes } from './routes/config.js';
import { versionRoutes } from './routes/version.js';
import { scannerRoutes } from './routes/scanner.js';

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  // Configure Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  app.register(sensible);
  app.register(authPlugin);
  await app.register(fastifySSE);

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(metadataRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api/media' });
  await app.register(credentialsRoutes, { prefix: '/api/credentials' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(versionRoutes, { prefix: '/api' });
  await app.register(scannerRoutes, { prefix: '/api/scanner' });

  return app;
}
