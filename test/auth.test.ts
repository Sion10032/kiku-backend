import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/utils.js';
import { getConfig, updateConfig } from '../src/infra/config/index.js';
import { db } from '../src/infra/db/main/index.js';
import { users } from '../src/infra/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

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

    await db.insert(users).values({
      name: TEST_USER,
      password: hashPassword('test-password'),
      group: 'user',
    });
    token = await signTokenFor(app, TEST_USER);
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

  describe('POST /api/auth/register', () => {
    let app: FastifyInstance;
    let savedAllowRegistration: boolean;
    const created: string[] = [];

    beforeAll(async () => {
      savedAllowRegistration = getConfig().allowRegistration;
      updateConfig({ allowRegistration: true });
      app = await buildApp();
      await app.ready();
    });

    afterAll(async () => {
      await db.delete(users).where(inArray(users.name, created));
      updateConfig({ allowRegistration: savedAllowRegistration });
      await app.close();
    });

    it('should register a new user and return token/name/group', async () => {
      const name = `auth_reg_ok_${RUN}`;
      created.push(name);

      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name, password: 'reg-pass-123' },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body.name).toBe(name);
      expect(body.group).toBe('user');
      expect(typeof body.token).toBe('string');
    });

    it('should reject a duplicate name with 409', async () => {
      const name = `auth_reg_dup_${RUN}`;
      created.push(name);

      const first = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name, password: 'reg-pass-123' },
      });
      expect(first.statusCode).toBe(200);

      const duplicate = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: { name, password: 'reg-pass-123' },
      });
      expect(duplicate.statusCode).toBe(409);
    });

    it('should map a concurrent same-name registration to 409, never 500', async () => {
      const name = `auth_reg_race_${RUN}`;
      created.push(name);
      const payload = { name, password: 'reg-pass-123' };

      const [a, b] = await Promise.all([
        app.inject({ method: 'POST', url: '/api/auth/register', payload }),
        app.inject({ method: 'POST', url: '/api/auth/register', payload }),
      ]);

      const statuses = [a.statusCode, b.statusCode].sort((x, y) => x - y);
      expect(statuses).toEqual([200, 409]);
      expect(statuses).not.toContain(500);
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
