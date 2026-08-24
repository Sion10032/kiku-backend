import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';
import { buildApp } from '../src/app';
import { db } from '../src/db/main/index.js';
import { users } from '../src/db/main/schema.js';
import { hashPassword } from '../src/auth/utils.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const TEST_USER = `auth_tester_${RUN}`;

describe('Auth Routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db.insert(users).values({ name: TEST_USER, password: hashPassword('test-password'), group: 'user' });
    token = app.jwt.sign({ name: TEST_USER, group: 'user' });
  });

  afterAll(async () => {
    await db.delete(users).where(eq(users.name, TEST_USER));
    await app.close();
  });

  describe('POST /api/auth/login', () => {
    it('should validate request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: {
          name: 'ab', // Too short
          password: '1234',
        },
      });

      expect(response.statusCode).toBe(400);
    });

    it('should reject invalid credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: TEST_USER, password: 'wrong-password' },
      });

      expect(response.statusCode).toBe(401);
    });

    it('should login with valid credentials', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: TEST_USER, password: 'test-password' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe(TEST_USER);
      expect(typeof body.token).toBe('string');
    });
  });

  describe('old POST /api/auth/me (login) removed', () => {
    it('should return 404', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/me',
        payload: { name: TEST_USER, password: 'test-password' },
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(404);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(response.statusCode).toBe(401);
    });

    it('should return current user with token', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ name: TEST_USER, group: 'user' });
    });
  });
});
