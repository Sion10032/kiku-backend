import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type CoverType,
  coverExists,
  downloadCover,
  getCoverData,
} from '../services/cover.service.js';
import { QueryParseError } from '../services/query/parser.js';
import {
  getCircles,
  getSeries,
  getTags,
  getVas,
  getWorkById,
  getWorkTracks,
  queryWorks,
} from '../services/work.service.js';

const idParamsSchema = z.object({
  id: z.string(),
});

const worksQuerySchema = z.object({
  /** LQL 查询文本（空/省略 = 全量）。语法：tag:催眠 -tag:百合 circle:"xx" va:x 裸词 */
  q: z.string().optional(),
  page: z.coerce.number().default(1),
  order: z
    .enum([
      'id',
      'release',
      'dl_count',
      'price',
      'rate_average_2dp',
      'review_count',
      'random',
      'betterRandom',
    ])
    .default('release'),
  sort: z.enum(['asc', 'desc']).default('desc'),
  seed: z.coerce.number().optional(),
});

const circleSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const tagSchema = z.object({
  id: z.number(),
  name: z.string(),
});

const vaSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const seriesSchema = z.object({
  id: z.string(),
  name: z.string(),
});

const userProgressSchema = z.object({
  mediaIndex: z.string(),
  trackTitle: z.string().nullable(),
  position: z.number(),
  duration: z.number().nullable(),
  listenedCount: z.number(),
  updatedAt: z.string(),
});

export const formattedWorkSchema = z.object({
  id: z.string(),
  rootFolder: z.string(),
  dir: z.string(),
  title: z.string(),
  circle: circleSchema,
  nsfw: z.boolean(),
  release: z.string().nullable(),
  dl_count: z.number().nullable(),
  price: z.number().nullable(),
  review_count: z.number().nullable(),
  rate_count: z.number().nullable(),
  rate_average_2dp: z.number().nullable(),
  rate_count_detail: z.record(z.string(), z.number()),
  rank: z.record(z.string(), z.number()).nullable(),
  tags: z.array(z.object({ id: z.number(), name: z.string() })),
  vas: z.array(z.object({ id: z.string(), name: z.string() })),
  series: seriesSchema.nullable(),
  userRating: z.number().nullable(),
  userProgress: userProgressSchema.nullable(),
  language: z.string().nullable(),
  sourceId: z.string().nullable(),
});

export const paginationSchema = z.object({
  currentPage: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
});

export const metadataRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // 可选鉴权：携带合法 token 则解析 request.user（works 列表/详情注入
  // userRating/userProgress）；匿名请求静默放行（公开浏览）。
  // 未验证时 request.user 为 undefined，各 handler 用 as { name?: string } 容错。
  fastify.addHook('onRequest', async (request) => {
    await request.jwtVerify().catch(() => {});
  });

  fastify.get(
    '/works',
    {
      schema: {
        querystring: worksQuerySchema,
        response: {
          200: z.object({
            works: z.array(formattedWorkSchema),
            pagination: paginationSchema,
          }),
          400: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { q, page, order, sort } = request.query;
      const user = (request.user as { name?: string })?.name;
      try {
        return await queryWorks(q, user, {
          page,
          orderBy: order,
          sortDir: sort,
        });
      } catch (err) {
        if (err instanceof QueryParseError) {
          return reply.status(400).send({ error: err.message });
        }
        throw err;
      }
    },
  );

  fastify.get(
    '/work/:id',
    {
      schema: {
        params: idParamsSchema,
        response: {
          200: formattedWorkSchema,
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const user = (request.user as { name?: string })?.name;

      try {
        return await getWorkById(id, user);
      } catch {
        return reply.status(404).send({ error: `Work ${id} not found` });
      }
    },
  );

  fastify.get(
    '/tracks/:id',
    {
      schema: {
        params: idParamsSchema,
        response: {
          200: z.array(
            z.union([
              z.object({
                type: z.literal('folder'),
                title: z.string(),
                children: z.lazy(() => z.array(z.any())),
              }),
              z.object({
                type: z.enum(['audio', 'text', 'image', 'other']),
                title: z.string(),
                hash: z.string(),
              }),
            ]),
          ),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;

      try {
        const tracks = await getWorkTracks(id);
        return tracks;
      } catch (err) {
        const errorMessage = err instanceof Error ? err.message : String(err);

        if (errorMessage.includes('not found')) {
          return reply.status(404).send({ error: errorMessage });
        }

        return reply.status(500).send({ error: 'Failed to get track list' });
      }
    },
  );

  fastify.get(
    '/cover/:id',
    {
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          type: z.enum(['main', 'sam', '240x240', '360x360']).default('main'),
        }),
        response: {
          200: z.object({
            url: z.string(),
            type: z.string(),
            exists: z.boolean(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { type } = request.query as { type: CoverType };

      // 检查作品是否存在
      const work = await getWorkById(id).catch(() => undefined);
      if (!work) {
        return reply.status(404).send({ error: `Work ${id} not found` });
      }

      // 检查封面是否已存在
      const exists = coverExists(id, type);

      if (exists) {
        return reply.send({
          url: `/api/cover/${id}/file?type=${type}`,
          type,
          exists: true,
        });
      }

      // 尝试下载封面（使用 sourceId 如果存在）
      const sourceId = work.sourceId || undefined;
      const downloadResult = await downloadCover(id, type, undefined, sourceId);

      if (downloadResult) {
        return reply.send({
          url: `/api/cover/${id}/file?type=${type}`,
          type,
          exists: true,
        });
      }

      return reply
        .status(404)
        .send({ error: `Cover for work ${id} not found` });
    },
  );

  fastify.get(
    '/cover/:id/file',
    {
      schema: {
        params: idParamsSchema,
        querystring: z.object({
          type: z.enum(['main', 'sam', '240x240', '360x360']).default('main'),
        }),
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { type } = request.query as { type: CoverType };

      // 部分作品没有 sam/240x240 等衍生封面（下载 404），
      // 此时回退到 main，避免前端列表缩略图整片占位
      const cover =
        getCoverData(id, type) ??
        (type !== 'main' ? getCoverData(id, 'main') : null);
      if (!cover) {
        return reply
          .status(404)
          .send({ error: `Cover for work ${id} not found` });
      }

      return reply.type(cover.mimeType ?? 'image/jpeg').send(cover.data);
    },
  );

  fastify.get(
    '/circles/',
    {
      schema: {
        response: {
          200: z.array(circleSchema),
        },
      },
    },
    async () => {
      return getCircles();
    },
  );

  fastify.get(
    '/tags/',
    {
      schema: {
        response: {
          200: z.array(tagSchema),
        },
      },
    },
    async () => {
      return getTags();
    },
  );

  fastify.get(
    '/vas/',
    {
      schema: {
        response: {
          200: z.array(vaSchema),
        },
      },
    },
    async () => {
      return getVas();
    },
  );

  fastify.get(
    '/series/',
    {
      schema: {
        response: {
          200: z.array(seriesSchema),
        },
      },
    },
    async () => {
      return getSeries();
    },
  );
};
