import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import sensible from '@fastify/sensible';
import fastifySSE from '@fastify/sse';
import fastifyStatic from '@fastify/static';
import Fastify, { type FastifyInstance } from 'fastify';
import {
  serializerCompiler,
  validatorCompiler,
  type ZodTypeProvider,
} from 'fastify-type-provider-zod';
import { initAdminFromEnv } from './auth/init.js';
import { getConfig } from './infra/config/index.js';
import { analysisRoutes } from './routes/analysis.js';
import { authRoutes } from './routes/auth.js';
import { configRoutes } from './routes/config.js';
import { credentialsRoutes } from './routes/credentials.js';
import { favouriteRoutes } from './routes/favourite.js';
import { healthRoutes } from './routes/health.js';
import { mediaRoutes } from './routes/media.js';
import { metadataRoutes } from './routes/metadata.js';
import { authPlugin } from './routes/plugins/auth.js';
import { i18nPlugin } from './routes/plugins/i18n.js';
import { progressRoutes } from './routes/progress.js';
import { reviewRoutes } from './routes/review.js';
import { rootFolderRoutes } from './routes/rootFolders.js';
import { scannerRoutes } from './routes/scanner.js';
import { settingsBackupRoutes } from './routes/settingsBackup.js';
import { setupRoutes } from './routes/setup.js';
import { versionRoutes } from './routes/version.js';
import { workAdminRoutes } from './routes/workAdmin.js';
import { worksRoutes } from './routes/works.js';

export interface BuildAppOptions {
  /** 静态资源根目录；默认 cwd 相对的 `./public`（与 CONFIG_PATH 同约定）。 */
  staticRoot?: string;
}

export async function buildApp(options: BuildAppOptions = {}) {
  const app = Fastify({ logger: true }).withTypeProvider<ZodTypeProvider>();

  // Configure Zod Type Provider
  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  // 初始化必要的目录
  initializeDirectories();

  app.register(sensible);
  app.register(i18nPlugin);

  // 环境变量管理员初始化（注册路由前）
  await initAdminFromEnv();

  app.register(authPlugin);
  await app.register(fastifySSE);

  // Register routes
  await app.register(healthRoutes, { prefix: '/api' });
  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(worksRoutes, { prefix: '/api' });
  await app.register(workAdminRoutes, { prefix: '/api' });
  await app.register(metadataRoutes, { prefix: '/api' });
  await app.register(mediaRoutes, { prefix: '/api/media' });
  await app.register(credentialsRoutes, { prefix: '/api/credentials' });
  await app.register(reviewRoutes, { prefix: '/api' });
  await app.register(favouriteRoutes, { prefix: '/api' });
  await app.register(settingsBackupRoutes, { prefix: '/api' });
  await app.register(progressRoutes, { prefix: '/api' });
  await app.register(configRoutes, { prefix: '/api/config' });
  await app.register(rootFolderRoutes, { prefix: '/api/config' });
  await app.register(versionRoutes, { prefix: '/api' });
  await app.register(scannerRoutes, { prefix: '/api/scanner' });
  await app.register(analysisRoutes, { prefix: '/api/analysis' });
  await app.register(setupRoutes, { prefix: '/api/setup' });

  registerStaticAssets(
    app,
    options.staticRoot ?? join(process.cwd(), 'public'),
  );

  return app;
}

/**
 * 注册前端静态资源与 SPA 深度链接回落。
 *
 * 静态目录缺少 index.html（未构建前端产物）时跳过，交给 Fastify 默认 404——
 * 开发时前端由 Vite 提供，后端只在部署形态下托管产物。
 */
function registerStaticAssets(app: FastifyInstance, root: string): void {
  const indexHtml = join(root, 'index.html');
  if (!existsSync(indexHtml)) {
    app.log.info(`Static assets not served: ${indexHtml} not found`);
    return;
  }

  app.register(fastifyStatic, { root, prefix: '/', index: ['index.html'] });

  app.setNotFoundHandler((request, reply) => {
    const isApi = request.url === '/api' || request.url.startsWith('/api/');
    const isGet = request.method === 'GET' || request.method === 'HEAD';

    if (isApi || !isGet) {
      // 保持 Fastify 默认 404 形状：API 响应体不能混进 index.html
      reply.code(404).send({
        message: `Route ${request.method}:${request.url} not found`,
        error: 'Not Found',
        statusCode: 404,
      });
      return;
    }

    reply.sendFile('index.html');
  });
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
  } catch (error) {
    console.error('Failed to initialize directories:', error);
  }
}

function resolveDir(dirPath: string, baseDir: string): string {
  if (dirPath.startsWith('/')) {
    return dirPath;
  }
  return join(baseDir, dirPath);
}
