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
} from '../services/work.service.js';

const idParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
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
  id: z.number(),
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
        501: z.object({ error: z.string() }),
      },
    },
  }, async (_request, reply) => {
    return reply.status(501).send({ error: 'Not implemented yet' });
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
      response: {
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id } = request.params;
    return reply.status(404).send({ error: `Cover for work ${id} not found` });
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
