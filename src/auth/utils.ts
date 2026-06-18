import { createHash } from 'crypto';
import type { FastifyInstance } from 'fastify';

export function md5(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

export function signToken(fastify: FastifyInstance, payload: object): string {
  return fastify.jwt.sign(payload);
}
