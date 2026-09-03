import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deleteSettingBackup,
  getSettingBackup,
  listSettingBackups,
  upsertSettingBackup,
} from '../services/settingsBackup.service.js';

// 备份名：非空、最长 50 字符（前端设置界面同名约束）
const backupNameSchema = z.string().min(1).max(50);

// 列表项（不含 payload，轻量）
const backupSummarySchema = z.object({
  name: z.string(),
  updatedAt: z.string(),
});

// 详情（payload 为 JSON 文本，由前端 parse）
const backupDetailSchema = z.object({
  name: z.string(),
  payload: z.string(),
  updatedAt: z.string(),
});

// 错误响应
const errorResponseSchema = z.object({ error: z.string() });

// 设置云端备份：用户手动命名的设置快照，按 (userName, name) upsert
export const settingsBackupRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // 备份列表（service 按 updatedAt 倒序返回）
  fastify.get(
    '/settings-backups',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: z.object({ backups: z.array(backupSummarySchema) }),
        },
      },
    },
    async (request) => {
      const user = request.user as { name: string; group: string };
      return listSettingBackups(user.name);
    },
  );

  // 读取单个备份
  fastify.get(
    '/settings-backups/:name',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: z.object({ name: backupNameSchema }),
        response: {
          200: backupDetailSchema,
          404: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user as { name: string; group: string };
      const backup = await getSettingBackup(user.name, request.params.name);
      if (!backup) {
        return reply.status(404).send({ error: '备份不存在' });
      }
      return backup;
    },
  );

  // 新建 / 覆盖更新备份
  fastify.put(
    '/settings-backups/:name',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: z.object({ name: backupNameSchema }),
        body: z.object({
          // 宽松校验：结构由前端 settingsStore 白名单保证，后端仅要求是对象
          payload: z.record(z.string(), z.unknown()),
        }),
        response: {
          200: z.object({ name: z.string(), updatedAt: z.string() }),
          409: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user as { name: string; group: string };
      const { name } = request.params;
      const ok = await upsertSettingBackup(
        user.name,
        name,
        JSON.stringify(request.body.payload),
      );
      if (!ok) {
        // 新建时已达每用户上限（覆盖更新不受限，不会走到这里）
        return reply.status(409).send({ error: '最多保留 10 条备份' });
      }
      // upsert 仅返回 boolean，组合 get 组装响应（upsert 成功后必然存在）
      const backup = await getSettingBackup(user.name, name);
      if (!backup) {
        // 理论上不可达：响应 schema 未声明 404，抛错兼作类型收窄
        throw new Error(
          `unreachable: upsert succeeded but backup missing (${name})`,
        );
      }
      return { name: backup.name, updatedAt: backup.updatedAt };
    },
  );

  // 删除备份（幂等，删不存在不报错）
  fastify.delete(
    '/settings-backups/:name',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: z.object({ name: backupNameSchema }),
        response: {
          200: z.object({ message: z.string() }),
        },
      },
    },
    async (request) => {
      const user = request.user as { name: string; group: string };
      await deleteSettingBackup(user.name, request.params.name);
      return { message: '备份已删除' };
    },
  );
};
