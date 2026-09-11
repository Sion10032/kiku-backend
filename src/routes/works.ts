import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  type CoverType,
  getCover,
  getCoverWithFallback,
} from '../services/cover.service.js';
import { QueryParseError } from '../services/query/parser.js';
import { getTrackRows } from '../services/track.service.js';
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
          return reply.fail(400, err.key, err.params);
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
        return reply.fail(404, 'errors.work.not-found', { id });
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
                // 整合响度（LUFS）；未分析为 null（与 durationSec 同构）
                loudnessLufs: z.number().nullable().optional(),
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
          if (result.reason === 'work-not-found') {
            return reply.fail(404, 'errors.work.not-found', { id });
          }
          return reply.fail(404, 'errors.work.root-folder-not-found', {
            folder: result.rootFolder ?? '',
          });
        }
        return result.tracks;
      } catch {
        return reply.fail(500, 'errors.work.track-list-failed');
      }
    },
  );

  // 响度曲线按需返回（单条响应可达数十 KB，不进 /work 与 /tracks 树）；
  // mediaIndex 含子目录路径，用 query 而非路径参数
  fastify.get(
    '/work/:id/loudness-curve',
    {
      schema: {
        params: idParamsSchema,
        querystring: z.object({ mediaIndex: z.string() }),
        response: {
          200: z.object({
            mediaIndex: z.string(),
            intervalSec: z.literal(1),
            curve: z.array(z.number().nullable()).nullable(),
          }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const { mediaIndex } = request.query;
      const row = (await getTrackRows(id)).find(
        (r) => r.mediaIndex === mediaIndex,
      );
      if (!row) {
        return reply.fail(404, 'errors.work.track-not-found', { mediaIndex });
      }
      return {
        mediaIndex,
        intervalSec: 1 as const,
        curve: row.loudnessCurve
          ? (JSON.parse(row.loudnessCurve) as Array<number | null>)
          : null,
      };
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
        if (result.status === 'work-not-found') {
          return reply.fail(404, 'errors.work.not-found', { id });
        }
        return reply.fail(404, 'errors.media.cover-not-found', { id });
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
        return reply.fail(404, 'errors.media.cover-not-found', { id });
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
