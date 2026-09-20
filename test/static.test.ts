import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

const TEST_USER = 'static-assets-user';
const INDEX_HTML = '<!doctype html><html><body>kiku spa shell</body></html>';
const APP_JS = 'console.log("kiku");';

const tempRoots: string[] = [];

/** 造一个前端产物目录（index.html + assets/） */
function createStaticFixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'kiku-static-'));
  tempRoots.push(root);
  writeFileSync(join(root, 'index.html'), INDEX_HTML);
  mkdirSync(join(root, 'assets'), { recursive: true });
  writeFileSync(join(root, 'assets', 'app.js'), APP_JS);
  return root;
}

afterAll(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('静态资源 serve（静态目录存在）', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    await createTestUser(TEST_USER);
    app = await buildApp({ staticRoot: createStaticFixture() });
    await app.ready();
    token = await signTokenFor(app, TEST_USER);
  });

  afterAll(async () => {
    await app.close();
    await deleteTestUser(TEST_USER);
  });

  it('GET / 返回 index.html', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('text/html');
    expect(response.body).toBe(INDEX_HTML);
  });

  it('GET /assets/app.js 返回构建产物', async () => {
    const response = await app.inject({ method: 'GET', url: '/assets/app.js' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(APP_JS);
  });

  it('前端深链回落 index.html', async () => {
    const response = await app.inject({ method: 'GET', url: '/works/123' });

    expect(response.statusCode).toBe(200);
    expect(response.body).toBe(INDEX_HTML);
  });

  it('私有模式下静态资源不需要 token（登录页要能加载）', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(200);
  });

  it('私有模式下未鉴权的 /api 请求仍被拦截', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/definitely-not-a-route',
    });

    expect(response.statusCode).toBe(401);
    expect(response.body).not.toContain('kiku spa shell');
  });

  it('已鉴权但未命中的 /api 路由仍是 JSON 404，不回落 index.html', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/api/definitely-not-a-route',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(response.statusCode).toBe(404);
    expect(response.headers['content-type']).toContain('application/json');
    expect(response.json()).toMatchObject({
      statusCode: 404,
      error: 'Not Found',
    });
    expect(response.body).not.toContain('kiku spa shell');
  });

  it('非 GET 的未命中路径不回落 index.html', async () => {
    const response = await app.inject({ method: 'POST', url: '/works/123' });

    expect(response.statusCode).toBe(404);
    expect(response.body).not.toContain('kiku spa shell');
  });
});

describe('静态资源 serve（静态目录不存在）', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp({
      staticRoot: join(tmpdir(), 'kiku-static-missing-fixture'),
    });
    await app.ready();
  });

  afterAll(async () => {
    await app.close();
  });

  it('不注册静态路由，GET / 走默认 404', async () => {
    const response = await app.inject({ method: 'GET', url: '/' });

    expect(response.statusCode).toBe(404);
  });

  it('API 路由不受影响', async () => {
    const response = await app.inject({ method: 'GET', url: '/api/health' });

    expect(response.statusCode).toBe(200);
  });
});
