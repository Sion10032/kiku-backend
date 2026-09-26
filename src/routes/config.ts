import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig, updateConfig } from '../infra/config/index.js';
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
      return updateConfig(request.body);
    },
  );
};
