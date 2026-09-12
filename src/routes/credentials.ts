import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  changePassword,
  createUserAccount,
  deleteUsers,
  getUsers,
} from '../services/user.service.js';

const createUserSchema = z.object({
  name: z.string().min(4),
  password: z.string().min(5),
  group: z.enum(['user', 'guest']),
});

const updatePasswordSchema = z.object({
  name: z.string().min(5),
  newPassword: z.string().min(5),
});

const deleteUsersSchema = z.object({
  users: z.array(z.object({ name: z.string() })),
});

const userSchema = z.object({
  name: z.string(),
  group: z.string(),
});

export const credentialsRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/users',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: z.array(userSchema),
        },
      },
    },
    async () => {
      return getUsers();
    },
  );

  fastify.post(
    '/user',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: createUserSchema,
        response: {
          200: z.object({
            name: z.string(),
            group: z.string(),
          }),
          409: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { name, password, group } = request.body;
      const result = await createUserAccount(name, password, group);
      if (!result.ok) {
        if (result.reason === 'conflict') {
          return reply.fail(409, 'errors.user.exists');
        }
        return reply.fail(500, 'errors.user.create-failed');
      }

      return { name: result.user.name, group: result.user.group };
    },
  );

  fastify.put(
    '/user',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: updatePasswordSchema,
        response: {
          200: z.object({ message: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { name, newPassword } = request.body;
      const result = await changePassword(name, newPassword);
      if (result === 'not-found') {
        return reply.fail(404, 'errors.user.not-found');
      }

      return { message: 'Password updated' };
    },
  );

  fastify.delete(
    '/user',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: deleteUsersSchema,
        response: {
          200: z.object({ message: z.string() }),
          400: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { users: usersToDelete } = request.body;
      // 删除批次含自己：整批拒绝（调用方上下文规则，只有 route 知道请求者）
      if (usersToDelete.some((u) => u.name === request.user.name)) {
        return reply.fail(400, 'errors.user.cannot-delete-self');
      }
      const result = await deleteUsers(usersToDelete.map(({ name }) => name));
      if (!result.ok) {
        return reply.fail(409, 'errors.user.last-administrator');
      }

      return { message: 'Users deleted' };
    },
  );
};
