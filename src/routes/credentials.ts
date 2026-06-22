import type { FastifyInstance } from 'fastify';
import { createUserSchema, updatePasswordSchema, deleteUsersSchema } from '../config/schema.js';
import { getUsers, createUser, updateUserPassword, deleteUser, getUserByName } from '../services/user.service.js';
import { hashPassword } from '../auth/utils.js';

export async function credentialsRoutes(fastify: FastifyInstance) {
  fastify.get('/users', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async () => {
    return getUsers();
  });

  fastify.post('/user', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async (request, reply) => {
    const parsed = createUserSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { name, password, group } = parsed.data;
    const existing = await getUserByName(name);
    if (existing) {
      return reply.status(409).send({ error: 'User already exists' });
    }

    const hashedPassword = hashPassword(password);
    const user = await createUser({ name, password: hashedPassword, group });

    return { name: user?.name, group: user?.group };
  });

  fastify.put('/user', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async (request, reply) => {
    const parsed = updatePasswordSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { name, newPassword } = parsed.data;
    const user = await getUserByName(name);
    if (!user) {
      return reply.status(404).send({ error: 'User not found' });
    }

    const hashedPassword = hashPassword(newPassword);
    await updateUserPassword(name, hashedPassword);

    return { message: 'Password updated' };
  });

  fastify.delete('/user', {
    preHandler: [ fastify.authenticateAdmin ],
  }, async (request, reply) => {
    const parsed = deleteUsersSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({ error: parsed.error.message });
    }

    const { users: usersToDelete } = parsed.data;
    for (const { name } of usersToDelete) {
      await deleteUser(name);
    }

    return { message: 'Users deleted' };
  });
}
