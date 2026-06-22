import type { FastifyInstance } from 'fastify';
import { worksQuerySchema } from '../config/schema.js';
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

export async function metadataRoutes(fastify: FastifyInstance) {
  fastify.get('/works', async (request) => {
    const parsed = worksQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      return { works: [], pagination: { currentPage: 1, pageSize: 12, totalCount: 0 } };
    }

    const { page, order, sort } = parsed.data;
    const user = (request.user as { name?: string; })?.name;

    return getWorksPaginated({
      page,
      orderBy: order,
      sortDir: sort,
      username: user,
    });
  });

  fastify.get('/work/:id', async (request, reply) => {
    const { id } = request.params as { id: string; };
    const user = (request.user as { name?: string; })?.name;

    try {
      return await getWorkById(Number(id), user);
    }
    catch {
      return reply.status(404).send({ error: `Work ${id} not found` });
    }
  });

  fastify.get('/tracks/:id', async (_request, reply) => {
    return reply.status(501).send({ error: 'Not implemented yet' });
  });

  fastify.get('/search/:keyword', async (request) => {
    const { keyword } = request.params as { keyword: string; };
    return searchWorks(keyword);
  });

  fastify.get('/cover/:id', async (request, reply) => {
    const { id } = request.params as { id: string; };
    return reply.status(404).send({ error: `Cover for work ${id} not found` });
  });

  fastify.get('/circles/', async () => {
    return getCircles();
  });

  fastify.get('/circles/:id', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getCircleById(Number(id));
    }
    catch {
      return reply.status(404).send({ error: `Circle ${id} not found` });
    }
  });

  fastify.get('/circles/:id/works', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getCircleWorks(Number(id));
    }
    catch {
      return reply.status(404).send({ error: `Circle ${id} not found` });
    }
  });

  fastify.get('/tags/', async () => {
    return getTags();
  });

  fastify.get('/tags/:id', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getTagById(Number(id));
    }
    catch {
      return reply.status(404).send({ error: `Tag ${id} not found` });
    }
  });

  fastify.get('/tags/:id/works', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getTagWorks(Number(id));
    }
    catch {
      return reply.status(404).send({ error: `Tag ${id} not found` });
    }
  });

  fastify.get('/vas/', async () => {
    return getVas();
  });

  fastify.get('/vas/:id', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getVaById(id);
    }
    catch {
      return reply.status(404).send({ error: `VA ${id} not found` });
    }
  });

  fastify.get('/vas/:id/works', async (request, reply) => {
    const { id } = request.params as { id: string; };
    try {
      return await getVaWorks(id);
    }
    catch {
      return reply.status(404).send({ error: `VA ${id} not found` });
    }
  });
}
