import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { hashPassword, signToken } from '../../src/auth/utils.js';
import { db } from '../../src/infra/db/main/index.js';
import { users } from '../../src/infra/db/main/schema.js';
import { getUserByName } from '../../src/services/user.service.js';

/** 插入测试用户行（密码默认 'test-password'），供 token 签发与回查鉴权使用 */
export async function createTestUser(
  name: string,
  group: 'user' | 'administrator' | 'guest' = 'user',
  password = 'test-password',
): Promise<void> {
  await db.insert(users).values({
    name,
    password: hashPassword(password),
    group,
  });
}

export async function deleteTestUser(name: string): Promise<void> {
  await db.delete(users).where(eq(users.name, name));
}

/**
 * 按库内用户行签发测试 token：回查该行并带上 ver 声明，
 * 与登录接口签发的真实 token 等价（行不存在则抛错）。
 */
export async function signTokenFor(
  fastify: FastifyInstance,
  name: string,
): Promise<string> {
  const user = await getUserByName(name);
  if (!user) {
    throw new Error(`signTokenFor: 用户不存在：${name}`);
  }
  return signToken(fastify, { name: user.name, group: user.group });
}
