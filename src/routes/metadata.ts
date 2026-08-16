import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getWorkById,
  getWorksPaginated,
  searchWorks,
  getCircleById,
  getCircleWorks,
  getCircles,
  getTagById,
  getTagWorks,
  getTags,
  getVaById,
  getVaWorks,
  getVas,
  getWorkTracks,
} from '../services/work.service.js';
import { downloadCover, coverExists, getCoverFilePath, type CoverType } from '../services/cover.service.js';

const idParamsSchema = z.object({
  id: z.string(),
});

// VA 的 id 是 string（如 v1），与 number 类型的 circle/tag 区分（见 vaSchema）
const vaIdParamsSchema = z.object({
  id: z.string().min(1),
});

const keywordParamsSchema = z.object({
  keyword: z.string().min(1),
});

const worksQuerySchema = z.object({
  page: z.coerce.number().default(1),
  order: z.enum([ 'id', 'release', 'random', 'betterRandom' ]).default('release'),
  sort: z.enum([ 'asc', 'desc' ]).default('desc'),
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

const formattedWorkSchema = z.object({
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
  userRating: z.number().nullable(),
  language: z.string().nullable(),
  sourceId: z.string().nullable(),
});

const paginationSchema = z.object({
  currentPage: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
});

export const metadataRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get('/works', {
    schema: {
      querystring: worksQuerySchema,
      response: {
        200: z.object({
          works: z.array(formattedWorkSchema),
          pagination: paginationSchema,
        }),
      },
    },
  }, async (request) => {
    const { page, order, sort } = request.query;
    const user = (request.user as { name?: string; })?.name;

    return getWorksPaginated({
      page,
      orderBy: order,
      sortDir: sort,
      username: user,
    });
  });

  fastify.get('/work/:id', {
    schema: {
      params: idParamsSchema,
      response: {
        200: formattedWorkSchema,
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const user = (request.user as { name?: string; })?.name;

    try {
      return await getWorkById(id, user);
    }
    catch {
      return reply.status(404).send({ error: `Work ${id} not found` });
    }
  });

  fastify.get('/tracks/:id', {
    schema: {
      params: idParamsSchema,
      response: {
        200: z.array(z.union([
          z.object({
            type: z.literal('folder'),
            title: z.string(),
            children: z.lazy(() => z.array(z.any())),
          }),
          z.object({
            type: z.enum([ 'audio', 'text', 'image', 'other' ]),
            title: z.string(),
            hash: z.string(),
          }),
        ])),
        404: z.object({ error: z.string() }),
        500: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;

    try {
      const tracks = await getWorkTracks(id);
      return tracks;
    }
    catch (err) {
      const errorMessage = err instanceof Error ? err.message : String(err);

      if (errorMessage.includes('not found')) {
        return reply.status(404).send({ error: errorMessage });
      }

      return reply.status(500).send({ error: 'Failed to get track list' });
    }
  });

  fastify.get('/search/:keyword', {
    schema: {
      params: keywordParamsSchema,
      response: {
        200: z.object({
          works: z.array(formattedWorkSchema),
        }),
      },
    },
  }, async (request) => {
    const { keyword } = request.params;
    return searchWorks(keyword);
  });

  fastify.get('/cover/:id', {
    schema: {
      params: idParamsSchema,
      querystring: z.object({
        type: z.enum([ 'main', 'sam', '240x240', '360x360' ]).default('main'),
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
  }, async (request, reply) => {
    const { id } = request.params;
    const { type } = request.query as { type: CoverType; };

    // 检查作品是否存在
    let work;
    try {
      work = await getWorkById(id);
    }
    catch {
      return reply.status(404).send({ error: `Work ${id} not found` });
    }

    // 检查封面是否已存在
    const exists = coverExists(id, type);

    if (exists) {
      const filePath = getCoverFilePath(id, type);
      if (filePath) {
        // 返回本地文件路径
        return reply.send({
          url: `/api/cover/${id}/file?type=${type}`,
          type,
          exists: true,
        });
      }
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

    return reply.status(404).send({ error: `Cover for work ${id} not found` });
  });

  fastify.get('/cover/:id/file', {
    schema: {
      params: idParamsSchema,
      querystring: z.object({
        type: z.enum([ 'main', 'sam', '240x240', '360x360' ]).default('main'),
      }),
    },
  }, async (request, reply) => {
    const { id } = request.params;
    const { type } = request.query as { type: CoverType; };

    const filePath = getCoverFilePath(id, type);
    if (!filePath) {
      return reply.status(404).send({ error: `Cover for work ${id} not found` });
    }

    // 读取文件并返回
    const { readFileSync } = await import('fs');
    const fileBuffer = readFileSync(filePath);
    return reply.type('image/jpeg').send(fileBuffer);
  });

  fastify.get('/circles/', {
    schema: {
      response: {
        200: z.array(circleSchema),
      },
    },
  }, async () => {
    return getCircles();
  });

  fastify.get('/circles/:id', {
    schema: {
      params: idParamsSchema,
      response: {
        200: circleSchema,
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getCircleById(id);
    }
    catch {
      return reply.status(404).send({ error: `Circle ${id} not found` });
    }
  });

  fastify.get('/circles/:id/works', {
    schema: {
      params: idParamsSchema,
      response: {
        200: z.array(formattedWorkSchema),
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getCircleWorks(id);
    }
    catch {
      return reply.status(404).send({ error: `Circle ${id} not found` });
    }
  });

  fastify.get('/tags/', {
    schema: {
      response: {
        200: z.array(tagSchema),
      },
    },
  }, async () => {
    return getTags();
  });

  fastify.get('/tags/:id', {
    schema: {
      params: idParamsSchema,
      response: {
        200: tagSchema,
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getTagById(id);
    }
    catch {
      return reply.status(404).send({ error: `Tag ${id} not found` });
    }
  });

  fastify.get('/tags/:id/works', {
    schema: {
      params: idParamsSchema,
      response: {
        200: z.array(formattedWorkSchema),
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getTagWorks(id);
    }
    catch {
      return reply.status(404).send({ error: `Tag ${id} not found` });
    }
  });

  fastify.get('/vas/', {
    schema: {
      response: {
        200: z.array(vaSchema),
      },
    },
  }, async () => {
    return getVas();
  });

  fastify.get('/vas/:id', {
    schema: {
      params: vaIdParamsSchema,
      response: {
        200: vaSchema,
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getVaById(String(id));
    }
    catch {
      return reply.status(404).send({ error: `VA ${id} not found` });
    }
  });

  fastify.get('/vas/:id/works', {
    schema: {
      params: vaIdParamsSchema,
      response: {
        200: z.array(formattedWorkSchema),
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    try {
      return await getVaWorks(String(id));
    }
    catch {
      return reply.status(404).send({ error: `VA ${id} not found` });
    }
  });
};
