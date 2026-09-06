import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signToken } from '../auth/utils.js';
import { getConfig } from '../infra/config/index.js';
import {
  MIGRATION_EVENT,
  type MigrationJobEvent,
  migration,
} from '../migration/job.js';
import { detectKikoeruData, getOldDataDir } from '../migration/kikoeru.js';
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

  // Setup 提交：创建管理员 + 写入实例配置，返回登录态（迁移改经 /migration/run 后台执行）
  fastify.post(
    '/',
    {
      schema: {
        body: setupSchema,
        response: {
          200: authResponseSchema,
          403: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const result = await setupInstance(request.body);
      if (!result)
        return reply.status(403).send({ error: 'Setup already completed' });
      // 初始化成功即消费旧终态：下次迁移（如有）从干净状态开始
      migration.reset();
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

  // 旧数据迁移：后台启动（立即返回；进度经 /migration/events SSE 推送）
  fastify.post(
    '/migration/run',
    {
      schema: {
        response: {
          200: z.object({ started: z.boolean() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      if (!migration.start()) {
        return reply.status(409).send({ error: '迁移正在进行中' });
      }
      return { started: true };
    },
  );

  // 迁移进度 SSE：首连/reconnect 推全量状态，之后转发 job 事件
  fastify.get('/migration/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();
    await reply.sse.send({
      event: 'MIGRATION_STATE',
      data: migration.getState(),
    });
    const handler = (event: MigrationJobEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    migration.on(MIGRATION_EVENT, handler);
    // 同时监听 raw close：若初始 send 期间客户端已断开，
    // @fastify/sse 的 cleanup 先于 onClose 注册执行，
    // 之后注册的回调永不触发，会造成 EventEmitter listener 泄漏（同 scanner）。
    const cleanup = (): void => {
      migration.off(MIGRATION_EVENT, handler);
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });
};
