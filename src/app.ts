import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';
import sensible from '@fastify/sensible';
import fastifySSE from '@fastify/sse';
import { authPlugin } from './auth/plugin.js';
import { initAdminFromEnv } from './auth/init.js';
import { healthRoutes } from './routes/health.js';
import { authRoutes } from './routes/auth.js';
import { metadataRoutes } from './routes/metadata.js';
import { mediaRoutes } from './routes/media.js';
import { credentialsRoutes } from './routes/credentials.js';
import { reviewRoutes } from './routes/review.js';
import { progressRoutes } from './routes/progress.js';
import { configRoutes } from './routes/config.js';
import { versionRoutes } from './routes/version.js';
import { scannerRoutes } from './routes/scanner.js';
import { getConfig } from './config/index.js';
import { existsSync, mkdirSync } from 'fs';
import { join } from 'path';

export async function buildApp() {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  // Configure Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 初始化必要的目录
  initializeDirectories();

  app.register(sensible);

  // 环境变量管理员初始化（注册路由前）
  await initAdminFromEnv();

  app.register(authPlugin);
  await app.register(fastifySSE);

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(metadataRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api/media' });
  await app.register(credentialsRoutes, { prefix: '/api/credentials' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(progressRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(versionRoutes, { prefix: '/api' });
  await app.register(scannerRoutes, { prefix: '/api/scanner' });

  return app;
}

function initializeDirectories() {
  try {
    const config = getConfig();
    const workDir = process.env.WORK_DIR || process.cwd();

    // 确保数据库目录存在
    const dbDir = resolveDir(config.databaseFolderDir, workDir);
    if (!existsSync(dbDir)) {
      mkdirSync(dbDir, { recursive: true });
      console.log(`Created database directory: ${dbDir}`);
    }
  }
  catch (error) {
    console.error('Failed to initialize directories:', error);
  }
}

function resolveDir(dirPath: string, baseDir: string): string {
  if (dirPath.startsWith('/')) {
    return dirPath;
  }
  return join(baseDir, dirPath);
}
