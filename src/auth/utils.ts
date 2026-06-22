import { createHash } from 'crypto';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../config/index.js';

export function md5(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

export function hashPassword(password: string): string {
  const config = getConfig();
  return md5(password + config.md5secret);
}

export function verifyPassword(password: string, hashedPassword: string): boolean {
  return hashPassword(password) === hashedPassword;
}

export function signToken(fastify: FastifyInstance, payload: { name: string; group: string; }): string {
  return fastify.jwt.sign(payload);
}
