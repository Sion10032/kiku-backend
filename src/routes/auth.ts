import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { signToken } from '../auth/utils.js';
import { login, register } from '../services/auth.service.js';

const loginSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
});

const authResponseSchema = z.object({
  token: z.string(),
  name: z.string(),
  group: z.string(),
});

export const authRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.post(
    '/login',
    {
      schema: {
        body: loginSchema,
        response: {
          200: authResponseSchema,
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { name, password } = request.body;
      const user = await login(name, password);
      if (!user)
        return reply.status(401).send({ error: 'Invalid credentials' });
      return { token: signToken(fastify, user), ...user };
    },
  );

  fastify.get(
    '/me',
    {
      preHandler: [fastify.authenticate],
      schema: {
        response: {
          200: z.object({
            name: z.string(),
            group: z.string(),
          }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      return { name: user.name, group: user.group };
    },
  );

  // 注册（白名单，由 allowRegistration 开关控制，独立于实例模式）
  fastify.post(
    '/register',
    {
      schema: {
        body: loginSchema,
        response: {
          200: authResponseSchema,
          403: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const result = await register(request.body.name, request.body.password);
      if (!result.ok) {
        const status = result.reason === 'registration-disabled' ? 403 : 409;
        const error =
          result.reason === 'registration-disabled'
            ? 'Registration is not allowed'
            : 'Username already exists';
        return reply.status(status).send({ error });
      }
      return { token: signToken(fastify, result.user), ...result.user };
    },
  );
};
