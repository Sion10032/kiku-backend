import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';
import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

setupTestEnvironment();

describe('Auth Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('POST /api/auth/me', () => {
    it('should validate request body', async () => {
      const response = await app.inject({
        method: 'POST',
        url: '/api/auth/me',
        payload: {
          name: 'ab',  // Too short
          password: '1234',
        },
      });

      expect(response.statusCode).toBe(400);
    });
  });

  describe('GET /api/auth/me', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
      });

      expect(response.statusCode).toBe(401);
      expect(response.json()).toMatchObject({ error: 'Unauthorized', statusCode: 401 });
    });
  });
});
