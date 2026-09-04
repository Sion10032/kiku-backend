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

// 与前端 kiku-frontend/src/stores/settingsStore.ts 的 SNAPSHOT_KEYS/设置类型严格同步：前端新增/修改设置字段（尤其枚举值）时必须同步本 schema，否则备份时该字段会被 trim/拒绝，还原丢失
//
// 严格校验设计（防止本接口被滥用为任意数据存储）：
// - 顶层/嵌套对象的未知键在 zod 解析时被 strip（trim 无关字段）；类型/枚举不匹配 → 验证失败 → 400
// - 全部键 optional：快照可能来自旧版本前端，缺键合法（前端 apply 时忽略缺失字段）
// - 嵌套对象字段全必填（与前端 FloatingLyricsSettings/PreviewSettings 一致）
// - uiScale 前端 apply 时已夹取 80–130，后端仅校验为 number，不做范围校验
const payloadSchema = z.object({
  dynamicColor: z.boolean().optional(),
  colorMode: z.enum(['light', 'dark', 'auto']).optional(),
  mediaNotification: z.boolean().optional(),
  floatingLyrics: z
    .object({
      enabled: z.boolean(),
      fontSize: z.number(),
      lines: z.number(),
      opacity: z.number(),
    })
    .optional(),
  preview: z
    .object({
      textFontSize: z.number(),
      textWordWrap: z.boolean(),
    })
    .optional(),
  coverBlurMode: z.enum(['always', 'hover', 'never']).optional(),
  timeDisplayMode: z.enum(['total', 'remaining']).optional(),
  worksPaginationMode: z.enum(['paginate', 'infinite']).optional(),
  worksPaginatorPosition: z.enum(['top', 'bottom', 'both']).optional(),
  worksHistoryStrip: z.boolean().optional(),
  uiScale: z.number().optional(),
});

// payload 序列化后的文本大小上限（4KB）：在 zod 验证前的 preValidation 中检查，
// 否则「带超大未知键」的请求会先被 strip 掉未知键而绕过大小限制
const PAYLOAD_MAX_SIZE = 4096;

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
      const user = request.user;
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
      const user = request.user;
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
      preValidation: async (request, reply) => {
        // zod 验证前先按原始 payload 文本大小拦截
        const raw = JSON.stringify(
          (request.body as { payload?: unknown } | undefined)?.payload,
        );
        if (raw !== undefined && raw.length > PAYLOAD_MAX_SIZE) {
          return reply.status(400).send({ error: '备份内容过大（上限 4KB）' });
        }
      },
      schema: {
        params: z.object({ name: backupNameSchema }),
        body: z.object({ payload: payloadSchema }),
        response: {
          200: z.object({ name: z.string(), updatedAt: z.string() }),
          409: errorResponseSchema,
          400: errorResponseSchema,
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const { name } = request.params;
      // zod 验证后 fastify 会用解析结果替换 request.body（未知键已被 strip），
      // 这里序列化的已是白名单内的干净对象
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
      const user = request.user;
      await deleteSettingBackup(user.name, request.params.name);
      return { message: '备份已删除' };
    },
  );
};
