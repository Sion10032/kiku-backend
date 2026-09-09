import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type CoverType,
  getCover,
  getCoverWithFallback,
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
import {
  circleSchema,
  formattedWorkSchema,
  paginationSchema,
  seriesSchema,
  tagSchema,
  vaSchema,
} from './schemas/work.js';

const idParamsSchema = z.object({
  id: z.string(),
});

const worksQuerySchema = z.object({
  /** LQL 查询文本（空/省略 = 全量）。语法：tag:催眠 -tag:百合 circle:"xx" va:x age:r18 裸词 */
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

export const worksRoutes: FastifyPluginAsyncZod = async (fastify) => {
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
      // onRequest 匿名放行，运行时 user 可为 undefined，可选链必需
      const user = request.user?.name;
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
      // onRequest 匿名放行，运行时 user 可为 undefined，可选链必需
      const user = request.user?.name;

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
                type: z.literal('audio'),
                title: z.string(),
                hash: z.string(),
                lyrics: z
                  .object({
                    hash: z.string(),
                    type: z.enum(['lrc', 'vtt']),
                  })
                  .optional(),
                // 播放时长（秒）；未知/探测失败为 null（service 层总会带键）
                durationSec: z.number().nullable().optional(),
              }),
              z.object({
                type: z.enum(['text', 'image', 'other']),
                title: z.string(),
                hash: z.string(),
                lyrics: z
                  .object({
                    hash: z.string(),
                    type: z.enum(['lrc', 'vtt']),
                  })
                  .optional(),
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
        const result = await getWorkTracks(id);
        if (!result.ok) {
          const error =
            result.reason === 'work-not-found'
              ? `Work ${id} not found`
              : `Root folder "${result.rootFolder}" not found`;
          return reply.status(404).send({ error });
        }
        return result.tracks;
      } catch {
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
      const result = await getCover(id, type);
      if (
        result.status === 'work-not-found' ||
        result.status === 'cover-not-found'
      ) {
        return reply.status(404).send({
          error:
            result.status === 'work-not-found'
              ? `Work ${id} not found`
              : `Cover for work ${id} not found`,
        });
      }
      return reply.send({ url: result.url, type: result.type, exists: true });
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
      const cover = getCoverWithFallback(id, type);
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
