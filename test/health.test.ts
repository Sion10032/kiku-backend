import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';
import { buildApp } from '../src/app';
import type { FastifyInstance } from 'fastify';

setupTestEnvironment();

describe('Health Routes', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  describe('GET /api/health', () => {
    it('should return health status', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/health',
      });

      expect(response.statusCode).toBe(200);
      expect(response.json()).toMatchObject({ status: 'ok' });
    });
  });
});
