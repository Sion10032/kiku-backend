import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getUserByName,
  createUser,
  getUsers,
} from '../services/user.service.js';
import { verifyPassword, signToken, hashPassword } from '../auth/utils.js';
import { getConfig, updateConfig } from '../config/index.js';

const loginSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
});

const setupSchema = loginSchema.extend({
  instanceMode: z.enum(['private', 'public']),
  allowRegistration: z.boolean(),
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
      const user = await getUserByName(name);

      if (!user || !verifyPassword(password, user.password)) {
        return reply.status(401).send({ error: 'Invalid credentials' });
      }

      const token = signToken(fastify, { name: user.name, group: user.group });
      return { token, name: user.name, group: user.group };
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
      const user = request.user as { name: string; group: string };
      return { name: user.name, group: user.group };
    },
  );

  // Setup 状态：用户表是否为空（无需鉴权，白名单）
  fastify.get(
    '/setup',
    {
      schema: {
        response: {
          200: z.object({ needed: z.boolean() }),
        },
      },
    },
    async () => {
      const existing = await getUsers();
      return { needed: existing.length === 0 };
    },
  );

  // Setup 初始化：创建管理员 + 写入实例配置，返回登录态（白名单）
  fastify.post(
    '/setup',
    {
      schema: {
        body: setupSchema,
        response: {
          200: authResponseSchema,
          403: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const existing = await getUsers();
      if (existing.length > 0) {
        return reply.status(403).send({ error: 'Setup already completed' });
      }

      const { name, password, instanceMode, allowRegistration } = request.body;
      await createUser({
        name,
        password: hashPassword(password),
        group: 'administrator',
      });
      updateConfig({ instanceMode, allowRegistration });

      const token = signToken(fastify, { name, group: 'administrator' });
      return { token, name, group: 'administrator' };
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
      if (!getConfig().allowRegistration) {
        return reply.status(403).send({ error: 'Registration is not allowed' });
      }

      const { name, password } = request.body;
      if (await getUserByName(name)) {
        return reply.status(409).send({ error: 'Username already exists' });
      }

      await createUser({
        name,
        password: hashPassword(password),
        group: 'user',
      });

      const token = signToken(fastify, { name, group: 'user' });
      return { token, name, group: 'user' };
    },
  );
};
