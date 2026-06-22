import type { FastifyInstance } from 'fastify';
import { loginSchema } from '../config/schema.js';
import { getUserByName } from '../services/user.service.js';
import { verifyPassword, signToken } from '../auth/utils.js';

export async function authRoutes(fastify: FastifyInstance) {
  fastify.post('/me', async (request, reply) => {
    const parsed = loginSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { name, password } = parsed.data;
    const user = await getUserByName(name);

    if (!user || !verifyPassword(password, user.password)) {
      return reply.status(401).send({ error: 'Invalid credentials' });
    }

    const token = signToken(fastify, { name: user.name, group: user.group });
    return { token, name: user.name, group: user.group };
  });

  fastify.get('/me', {
    preHandler: [ fastify.authenticate ],
  }, async (request) => {
    const user = request.user as { name: string; group: string; };
    return { name: user.name, group: user.group };
  });
}
