import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

describe('Version Routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 回查鉴权要求用户真实入库（默认私有模式下需要鉴权）
    await createTestUser('version_tester');
    token = await signTokenFor(app, 'version_tester');
  });

  afterAll(async () => {
    await deleteTestUser('version_tester');
    await app.close();
  });

  describe('GET /api/version', () => {
    it('should return version info', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/version',
        headers: { authorization: `Bearer ${token}` },
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('current');
      expect(body).toHaveProperty('latest');
      expect(body).toHaveProperty('updateAvailable');
      expect(typeof body.current).toBe('string');
    });
  });
});
