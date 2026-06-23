import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';
import fp from 'fastify-plugin';
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

async function plugin(fastify: FastifyInstance) {
  const config = getConfig();

  await fastify.register(fastifyJwt, {
    secret: config.jwtsecret,
    sign: {
      expiresIn: config.expiresIn,
    },
  });

  fastify.decorate('authenticate', async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      await request.jwtVerify();
    }
    catch {
      throw fastify.httpErrors.unauthorized();
    }
  });

  fastify.decorate('authenticateAdmin', async (request: FastifyRequest, _reply: FastifyReply) => {
    try {
      const decoded = await request.jwtVerify<JwtPayload>();
      if (decoded.group !== 'administrator') {
        throw fastify.httpErrors.forbidden();
      }
    }
    catch {
      throw fastify.httpErrors.unauthorized();
    }
  });
}

export const authPlugin = fp(plugin, { name: 'auth' });
