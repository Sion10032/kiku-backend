import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getUserByName } from '../services/user.service.js';
import { verifyPassword, signToken } from '../auth/utils.js';

const loginSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
});

export const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post('/me', {
    schema: {
      body: loginSchema,
      response: {
        200: z.object({
          token: z.string(),
          name: z.string(),
          group: z.string(),
        }),
        401: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { name, password } = request.body;
    const user = await getUserByName(name);

    if (!user || !verifyPassword(password, user.password)) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = signToken(fastify, { name: user.name, group: user.group });
    return { token, name: user.name, group: user.group };
  });

  fastify.get('/me', {
    preHandler: [ fastify.authenticate ],
    schema: {
      response: {
        200: z.object({
          name: z.string(),
          group: z.string(),
        }),
      },
    },
  }, async (request) => {
    const user = request.user as { name: string; group: string; };
    return { name: user.name, group: user.group };
  });
};
