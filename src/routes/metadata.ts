import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getOverride,
  OVERRIDE_FIELDS,
  OverrideNotFoundError,
  resetField,
  saveOverride,
} from '../services/metadataOverride.service.js';

const idParamsSchema = z.object({ id: z.string() });

const saveBodySchema = z
  .object({
    title: z.string().min(1).max(500).nullable().optional(),
    circleName: z.string().min(1).max(200).nullable().optional(),
    seriesName: z.string().min(1).max(300).nullable().optional(),
    ageRating: z.enum(['all', 'r15', 'r18']).nullable().optional(),
    tagsCleared: z.boolean().optional(),
    vasCleared: z.boolean().optional(),
    addTags: z.array(z.string().min(1).max(100)).max(100).optional(),
    removeTagIds: z.array(z.number().int()).max(200).optional(),
    addVas: z
      .array(
        z.object({
          id: z.string().max(100).optional(),
          name: z.string().min(1).max(200),
        }),
      )
      .max(100)
      .optional(),
    removeVaIds: z.array(z.string()).max(200).optional(),
  })
  .refine((v) => Object.keys(v).length > 0, { message: '空覆盖请求' });

const fieldParamsSchema = z.object({
  id: z.string(),
  field: z.enum(OVERRIDE_FIELDS),
});

const circleEntitySchema = z.object({ id: z.number(), name: z.string() });
const seriesEntitySchema = z.object({ id: z.string(), name: z.string() });
const tagEntitySchema = z.object({ id: z.number(), name: z.string() });
const vaEntitySchema = z.object({ id: z.string(), name: z.string() });
const tagActionSchema = tagEntitySchema.extend({
  action: z.enum(['add', 'remove']),
});
const vaActionSchema = vaEntitySchema.extend({
  action: z.enum(['add', 'remove']),
});

/** original / effective 共用形状 */
const detailShape = {
  title: z.string(),
  circle: circleEntitySchema.nullable(),
  series: seriesEntitySchema.nullable(),
  ageRating: z.string(),
  tags: z.array(tagEntitySchema),
  vas: z.array(vaEntitySchema),
};

const overrideDetailSchema = z.object({
  original: z.object(detailShape),
  effective: z.object(detailShape),
  override: z.object({
    title: z.string().nullable(),
    circle: circleEntitySchema.nullable(),
    series: seriesEntitySchema.nullable(),
    ageRating: z.string().nullable(),
    tagsCleared: z.boolean(),
    vasCleared: z.boolean(),
    tagActions: z.array(tagActionSchema),
    vaActions: z.array(vaActionSchema),
    updatedBy: z.string().nullable(),
    updatedAt: z.string().nullable(),
  }),
  overriddenFields: z.array(z.enum(OVERRIDE_FIELDS)),
});

/**
 * 元数据覆盖（管理员专用）。与 works.ts 公开浏览端点相对，同 workAdmin.ts 模式。
 */
export const metadataRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // PATCH /api/work/:id/metadata — 保存覆盖（标量为最终值；tags/vas 为动作列表）
  fastify.patch(
    '/work/:id/metadata',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        body: saveBodySchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      try {
        await saveOverride(request.params.id, {
          ...request.body,
          updatedBy: request.user?.name,
        });
        return { success: true };
      } catch (err) {
        if (err instanceof OverrideNotFoundError) {
          return reply.status(404).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  // GET /api/work/:id/metadata/override — 编辑回显（原始 + 覆盖状态 + 生效）
  fastify.get(
    '/work/:id/metadata/override',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          200: overrideDetailSchema,
          401: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const detail = await getOverride(request.params.id);
      if (!detail) {
        return reply
          .status(404)
          .send({ error: `Work ${request.params.id} not found` });
      }
      return detail;
    },
  );

  // DELETE /api/work/:id/metadata/:field — 单字段恢复原始
  fastify.delete(
    '/work/:id/metadata/:field',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: fieldParamsSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.string() }),
          403: z.object({ error: z.string() }),
        },
      },
    },
    async (request) => {
      await resetField(request.params.id, request.params.field);
      return { success: true };
    },
  );
};
