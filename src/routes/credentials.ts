import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  getUsers,
  createUser,
  updateUserPassword,
  deleteUser,
  getUserByName,
} from '../services/user.service.js';
import { hashPassword } from '../auth/utils.js';

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
      const existing = await getUserByName(name);
      if (existing) {
        return reply.status(409).send({ error: 'User already exists' });
      }

      const hashedPassword = hashPassword(password);
      const user = await createUser({ name, password: hashedPassword, group });

      if (!user) {
        return reply.status(500).send({ error: 'Failed to create user' });
      }

      return { name: user.name, group: user.group };
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
      const user = await getUserByName(name);
      if (!user) {
        return reply.status(404).send({ error: 'User not found' });
      }

      const hashedPassword = hashPassword(newPassword);
      await updateUserPassword(name, hashedPassword);

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
        },
      },
    },
    async (request) => {
      const { users: usersToDelete } = request.body;
      for (const { name } of usersToDelete) {
        await deleteUser(name);
      }

      return { message: 'Users deleted' };
    },
  );
};
