import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fastifyJwt from '@fastify/jwt';
import { getConfig } from '../config/index.js';

declare module '@fastify/jwt' {
  interface FastifyJWT {
    payload: { name: string; group: string; };
  }
}

declare module 'fastify' {
  interface FastifyInstance {
    authenticate: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
    authenticateAdmin: (request: FastifyRequest, reply: FastifyReply) => Promise<void>;
  }
}

export interface JwtPayload {
  name: string;
  group: string;
}

export async function authPlugin(fastify: FastifyInstance) {
  const config = getConfig();

  await fastify.register(fastifyJwt, {
    secret: config.jwtsecret,
    sign: {
      expiresIn: config.expiresIn,
    },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    }
    catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });

  fastify.decorate('authenticateAdmin', async (request: FastifyRequest, reply: FastifyReply) => {
    try {
      const decoded = await request.jwtVerify<JwtPayload>();
      if (decoded.group !== 'administrator') {
        reply.status(403).send({ error: 'Forbidden' });
      }
    }
    catch {
      reply.status(401).send({ error: 'Unauthorized' });
    }
  });
}
