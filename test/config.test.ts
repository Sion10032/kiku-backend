import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';
import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

setupTestEnvironment();

describe('Config Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/config/shared', () => {
    it('should return shared config', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/config/shared',
      });

      expect(response.statusCode).toBe(200);
      const body = response.json();
      expect(body).toHaveProperty('instanceMode');
      expect(body).toHaveProperty('allowRegistration');
      expect(body).toHaveProperty('pageSize');
      expect(body).toHaveProperty('tagLanguage');
      expect(body).toHaveProperty('enableGzip');
    });
  });

  describe('GET /api/config/admin', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/config/admin',
      });

      expect(response.statusCode).toBe(401);
    });
  });
});
