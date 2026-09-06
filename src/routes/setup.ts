import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signToken } from '../auth/utils.js';
import { getConfig } from '../infra/config/index.js';
import {
  detectKikoeruData,
  getOldDataDir,
  migrateFromKikoeru,
} from '../migration/kikoeru.js';
import { setupInstance } from '../services/auth.service.js';
import { getUsers } from '../services/user.service.js';

const loginSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
});

const setupSchema = loginSchema.extend({
  instanceMode: z.enum(['private', 'public']),
  allowRegistration: z.boolean(),
});

const authResponseSchema = z.object({
  token: z.string(),
  name: z.string(),
  group: z.string(),
});

const statsSchema = z.object({
  works: z.number(),
  users: z.number(),
  reviews: z.number(),
  playHistory: z.number(),
  covers: z.number(),
});

const migrationStatsSchema = z.object({
  circles: z.number(),
  works: z.number(),
  worksSkipped: z.number(),
  tags: z.number(),
  vas: z.number(),
  tagWork: z.number(),
  vaWork: z.number(),
  users: z.number(),
  usersSkipped: z.number(),
  reviews: z.number(),
  reviewsSkipped: z.number(),
  readStates: z.number(),
  readStatesSkipped: z.number(),
  coversImported: z.number(),
});

/** Setup 首次部署向导：守卫 / 提交 / 旧数据迁移（均免鉴权，白名单收敛到 /api/setup） */
export const setupRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // Setup 状态守卫：用户表是否为空
  fastify.get(
    '/',
    {
      schema: {
        response: {
          200: z.object({ needed: z.boolean() }),
        },
      },
    },
    async () => {
      const existing = await getUsers();
      return { needed: existing.length === 0 };
    },
  );

  // Setup 提交：创建管理员 + 写入实例配置，返回登录态
  fastify.post(
    '/',
    {
      schema: {
        body: setupSchema,
        response: {
          200: authResponseSchema,
          403: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const result = await setupInstance(request.body);
      if (!result)
        return reply.status(403).send({ error: 'Setup already completed' });
      return { token: signToken(fastify, result), ...result };
    },
  );

  // 旧数据迁移：status 探测
  fastify.get(
    '/migration/status',
    {
      schema: {
        response: {
          200: z.object({
            available: z.boolean(),
            migrated: z.boolean(),
            flavor: z.enum(['number178-fork', 'vanilla']).optional(),
            stats: statsSchema.optional(),
          }),
        },
      },
    },
    async () => {
      const detection = detectKikoeruData(getOldDataDir());
      return {
        available: detection !== null,
        migrated: Boolean(getConfig().kikoeruMigratedAt),
        ...(detection
          ? { flavor: detection.flavor, stats: detection.stats }
          : {}),
      };
    },
  );

  // 旧数据迁移：run 执行
  fastify.post(
    '/migration/run',
    {
      schema: {
        response: {
          200: z.object({ stats: migrationStatsSchema }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const result = migrateFromKikoeru(getOldDataDir());
      if (!result.ok || !result.stats) {
        return reply.status(409).send({ error: result.error ?? '迁移失败' });
      }
      return { stats: result.stats };
    },
  );
};
