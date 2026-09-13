import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const ID = `RJ${String(43550000 + Math.floor(Math.random() * 49999)).padStart(8, '0')}_${RUN}`;

const MAIN_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x01]);
const SAM_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x02]);

// blob 库操作与 app 构建在 mock 外正常加载
const { putBlob, deleteBlob } = await import('../src/infra/db/blob/index');
const { buildApp } = await import('../src/app');

describe('GET /api/cover/:id/file 封面回退', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 私有模式全局守卫需要 JWT，回查鉴权要求用户真实入库
    await createTestUser(`cover_tester_${RUN}`);
    token = await signTokenFor(app, `cover_tester_${RUN}`);
  });

  afterAll(async () => {
    deleteBlob('cover', `${ID}_main`);
    deleteBlob('cover', `${ID}_sam`);
    await deleteTestUser(`cover_tester_${RUN}`);
    await app.close();
  });

  it('只有 main 时，请求 sam 应回退到 main 内容', async () => {
    putBlob('cover', `${ID}_main`, MAIN_BYTES, 'image/jpeg');

    const res = await app.inject({
      method: 'GET',
      url: `/api/cover/${ID}/file?type=sam`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(MAIN_BYTES)).toBe(true);
  });

  it('sam 存在时优先返回 sam，不回退', async () => {
    putBlob('cover', `${ID}_sam`, SAM_BYTES, 'image/jpeg');

    const res = await app.inject({
      method: 'GET',
      url: `/api/cover/${ID}/file?type=sam`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    expect(Buffer.from(res.rawPayload).equals(SAM_BYTES)).toBe(true);
  });

  it('main 也不存在时仍返回 404', async () => {
    deleteBlob('cover', `${ID}_main`);
    deleteBlob('cover', `${ID}_sam`);

    const res = await app.inject({
      method: 'GET',
      url: `/api/cover/${ID}/file?type=sam`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(404);
  });
});
