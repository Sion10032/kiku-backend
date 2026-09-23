import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const ID = `RJ${String(43600000 + Math.floor(Math.random() * 49999)).padStart(8, '0')}_${RUN}`;
const CIRCLE = '路由测试社团';

// 网络隔离：不用 mock.module（test/ 目录下 mock.module 会污染同进程其他测试
// 文件的模块注册表，波及 cover.test.ts / dlsite.test.ts），改为拦截
// globalThis.fetch——与 src/infra/scraper/dlsite.test.ts 的 mockWorkPage 同模式。
const WORK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="路由测试作品 ${ID} [${CIRCLE}] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/${ID}_img_main.jpg" />
</head>
<body>
  <span class="maker_name"><a href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG00000001.html">${CIRCLE}</a></span>
  <table id="work_outline">
    <tr><th>年齢指定</th><td><a href="https://www.dlsite.com/maniax/info/=/adult/1">R18</a></td></tr>
    <tr><th>販売日</th><td>2024年04月01日 0時</td></tr>
    <tr><th>声優</th><td><a href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG00000001.html">佐倉綾音</a></td></tr>
  </table>
</body>
</html>`;
const IMG_BYTES = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const realFetch = globalThis.fetch;
const fetchMock = mock(async (input: string | URL | Request) => {
  const url = input instanceof Request ? input.url : String(input);
  if (url.includes('/product/info/ajax')) {
    return new Response(
      JSON.stringify({
        [ID]: {
          dl_count: 100,
          price: 1548,
          review_count: 30,
          rate_count: 50,
          rate_average_2dp: 4.5,
          rate_count_detail: [],
          rank: [],
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  }
  if (url.includes('img.dlsite.jp')) {
    return new Response(IMG_BYTES, {
      status: 200,
      headers: { 'content-type': 'image/jpeg' },
    });
  }
  return new Response(WORK_PAGE_HTML, {
    status: 200,
    headers: { 'content-type': 'text/html' },
  });
}) as unknown as typeof fetch;

const { buildApp } = await import('../src/app');
const { db } = await import('../src/infra/db/main/index.js');
const { circles, works } = await import('../src/infra/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { getConfig, setConfigForTesting } = await import(
  '../src/infra/config/index.js'
);
const { upsertWork } = await import('../src/services/work.service.js');

const ROOT_FOLDER = 'workadmin-root';
const sine = readFileSync(join(import.meta.dir, 'fixtures/audio/sine.wav'));

let app: FastifyInstance;
let adminToken: string;
let userToken: string;
let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-workadmin-'));
  mkdirSync(join(root, ID), { recursive: true });
  writeFileSync(join(root, ID, 'sine.wav'), sine);
  setConfigForTesting({
    ...getConfig(),
    rootFolders: [{ name: ROOT_FOLDER, path: root }],
  });
  const seeded = await upsertWork({
    id: ID,
    rootFolder: ROOT_FOLDER,
    dir: ID,
    title: '路由测试初始标题',
    circleName: CIRCLE,
  });
  expect(seeded.success).toBe(true);

  app = await buildApp();
  await app.ready();
  // 回查鉴权要求用户真实入库；admin/user group 由库行决定
  await createTestUser(`admin_${RUN}`, 'administrator');
  await createTestUser(`user_${RUN}`);
  adminToken = await signTokenFor(app, `admin_${RUN}`);
  userToken = await signTokenFor(app, `user_${RUN}`);
  globalThis.fetch = fetchMock;
});

afterAll(async () => {
  globalThis.fetch = realFetch;
  await app.close();
  await deleteTestUser(`admin_${RUN}`);
  await deleteTestUser(`user_${RUN}`);
  await db.delete(works).where(eq(works.id, ID));
  const circle = await db.query.circles.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, CIRCLE) },
  });
  if (circle) {
    await db.delete(works).where(eq(works.circleId, circle.id));
    await db.delete(circles).where(eq(circles.id, circle.id));
  }
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting();
});

describe('管理员单作品端点', () => {
  it('非管理员 token → 403 / 匿名 → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/work/${ID}/refresh`,
      headers: { authorization: `Bearer ${userToken}` },
    });
    // authenticateAdmin 修正后：非管理员不再是 401，而是明确的 403
    expect(res.statusCode).toBe(403);

    const anon = await app.inject({
      method: 'DELETE',
      url: `/api/work/${ID}`,
    });
    expect(anon.statusCode).toBe(401);
  });

  it('POST /refresh：200，标题更新 + 音轨时长回填', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/work/${ID}/refresh`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.title).toBe(`路由测试作品 ${ID}`);
    expect(body.tracks.added).toBe(1);

    // 端到端钉住 circle_id 链路：seed 只给了 circleName（占位 id = 社团名），
    // 而 fixture 的 maker_name 链接是 maker_id/RG00000001。只有
    // scraper 提取 maker_id → syncWorkMetadata 透传 → upsertWork 透传给
    // resolveCircle → 占位行原地升级 这条链完整存在，circleId 才会变成
    // RG00000001；任一环退回 undefined 都会落回占位 id 而在此失败。
    const [refreshed] = await db.select().from(works).where(eq(works.id, ID));
    expect(refreshed?.circleId).toBe('RG00000001');
  });

  it('POST /refresh：作品不存在 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/work/RJ99999999/refresh',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /sync-tracks：200 返回同步统计（size 未变 → 全 0）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/work/${ID}/sync-tracks`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().tracks).toEqual({ added: 0, updated: 0, removed: 0 });
  });

  it('DELETE：软删后详情立即 404；重复删除幂等 success', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/work/${ID}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().success).toBe(true);

    // 读路径过滤 deletedAt IS NULL → 详情 404
    const detail = await app.inject({
      method: 'GET',
      url: `/api/work/${ID}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(detail.statusCode).toBe(404);

    const again = await app.inject({
      method: 'DELETE',
      url: `/api/work/${ID}`,
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(again.statusCode).toBe(200);
  });

  it('DELETE：从未入库的 id → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/work/RJ99999999',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });
});
