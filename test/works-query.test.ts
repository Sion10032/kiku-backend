import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

// base 取 7 位数字：works_tester_{base} 保证测试用户名唯一
const base = 3000000 + Math.floor(Math.random() * 2000000);

const { buildApp } = await import('../src/app');

describe('GET /api/works query 参数校验', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 私有模式全局守卫需要 JWT，回查鉴权要求用户真实入库
    await createTestUser(`works_tester_${base}`);
    token = await signTokenFor(app, `works_tester_${base}`);
  });

  afterAll(async () => {
    await deleteTestUser(`works_tester_${base}`);
    await app.close();
  });

  it('page=1.5 返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/works?page=1.5',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>()).toHaveProperty('error');
  });

  it('page=-1 返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/works?page=-1',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>()).toHaveProperty('error');
  });

  it('page=abc 返回 400', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/works?page=abc',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(400);
    expect(res.json<Record<string, unknown>>()).toHaveProperty('error');
  });

  it('不带 page 返回 200 且含 works 与 pagination', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/works',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const body = res.json<{ works: unknown[]; pagination: object }>();
    expect(Array.isArray(body.works)).toBe(true);
    expect(typeof body.pagination).toBe('object');
  });
});
