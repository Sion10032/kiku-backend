import { createHash } from 'node:crypto';
import type { FastifyInstance } from 'fastify';
import { getConfig } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';

export function md5(str: string): string {
  return createHash('md5').update(str).digest('hex');
}

export function hashPassword(password: string): string {
  const config = getConfig();
  return md5(password + config.md5secret);
}

export function verifyPassword(
  password: string,
  hashedPassword: string,
): boolean {
  return hashPassword(password) === hashedPassword;
}

/** 签发登录 token：回查用户行，附加 ver 声明（token 版本，改密即 bump） */
export async function signToken(
  fastify: FastifyInstance,
  payload: { name: string; group: string },
): Promise<string> {
  // 直查 db 而非 user.service：auth 层不得依赖 services 层（分层规则）
  const user = await db.query.users.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, payload.name) },
  });
  if (!user) {
    throw new Error(`signToken: user not found: ${payload.name}`);
  }
  return fastify.jwt.sign({ ...payload, ver: user.tokenVersion });
}
