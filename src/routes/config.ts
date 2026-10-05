import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig, updateConfig } from '../infra/config/index.js';
import { applyPoolWidths } from '../scanner/taskSystem.js';
import { type Config, configSchema } from '../infra/config/schema.js';

// 部分更新 body：全字段 optional 且去除 default。
// 不能用 configSchema.partial()：zod 4 中 default 在 optional 之下仍生效，
// parse 会把未提交字段填成默认值（如 maxParallelism: 16），经合并覆盖真实配置。
const updateConfigSchema: z.ZodType<Partial<Config>> = z.object(
  Object.fromEntries(
    Object.entries(configSchema.shape).map(([key, field]) => [
      key,
      field instanceof z.ZodDefault
        ? field.unwrap().optional()
        : field.optional(),
    ]),
  ),
);

export const configRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/admin',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: configSchema,
        },
      },
    },
    async () => {
      return getConfig();
    },
  );

  fastify.put(
    '/admin',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: updateConfigSchema,
        response: {
          200: configSchema,
        },
      },
    },
    async (request) => {
      const next = updateConfig(request.body);
      // 池宽热更新：配置页改并发后立即生效（此前需重启后端，队列池宽在
      // 单例创建时固化）
      if (request.body.maxParallelism !== undefined) {
        applyPoolWidths(next.maxParallelism, next.analysisParallelism);
      } else if (request.body.analysisParallelism !== undefined) {
        applyPoolWidths(next.maxParallelism, next.analysisParallelism);
      }
      return next;
    },
  );
};
