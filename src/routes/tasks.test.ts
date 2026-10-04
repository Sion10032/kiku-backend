import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { signTokenFor } from '@test/helpers/token';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/utils.js';
import { db } from '../infra/db/main/index.js';
import { circles, rootFolders, users, works } from '../infra/db/main/schema.js';
import {
  acquireIdentity,
  releaseIdentity,
  SCAN_ALL_IDENTITY,
} from '../scanner/orchestrators/scan.js';
import { metadataExecutor } from '../scanner/phases/metadata.js';
import { getTaskSystem } from '../scanner/taskSystem.js';

setupTestEnvironment();

const ADMIN = `tasks-admin-${Date.now().toString(36)}`;
const WORK_ID = `RJ${String(300000 + Math.floor(Math.random() * 90000))}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
const authHeader = (): { authorization: string } => ({
  authorization: `Bearer ${adminToken}`,
});

/** 挂住 metadata 执行体的 deferred（409 时序可控）。 */
let gate: { promise: Promise<unknown>; resolve: () => void } | null = null;

beforeAll(async () => {
  app = await buildApp();
  await db
    .insert(users)
    .values({
      name: ADMIN,
      password: hashPassword('test-password'),
      group: 'administrator',
    })
    .onConflictDoNothing();
  adminToken = await signTokenFor(app, ADMIN);
  await db
    .insert(rootFolders)
    .values({ name: 'tasks-root', path: '/tmp/kiku-tasks-root' })
    .onConflictDoNothing();
  await db
    .insert(circles)
    .values({ id: 'tasks-circle', name: 'tasks-circle' })
    .onConflictDoNothing();
  await db.insert(works).values({
    id: WORK_ID,
    title: 'T',
    circleId: 'tasks-circle',
    rootFolder: 'tasks-root',
    dir: WORK_ID,
  });
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK_ID));
  await db.delete(rootFolders).where(eq(rootFolders.name, 'tasks-root'));
  await db.delete(circles).where(eq(circles.id, 'tasks-circle'));
  await db.delete(users).where(eq(users.name, ADMIN));
  gate?.resolve();
  // 恢复真实 metadata executor（单例跨测试文件共享）
  getTaskSystem().registerExecutor('metadata', metadataExecutor);
});

import { eq } from 'drizzle-orm';

describe('任务中心路由', () => {
  it('GET /api/tasks 返回快照结构', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/tasks',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as {
      snapshot: { batches: unknown[]; pipelines: unknown[]; logs: unknown[] };
    };
    expect(Array.isArray(body.snapshot.batches)).toBe(true);
    expect(Array.isArray(body.snapshot.pipelines)).toBe(true);
    expect(Array.isArray(body.snapshot.logs)).toBe(true);
  });

  it('GET /api/tasks 需登录（私有模式全局守卫；快照与 works 数据同权限级）', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/tasks' });
    expect(res.statusCode).toBe(401);
  });

  it('DELETE /api/tasks/:id 未知 id → 404', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: '/api/tasks/nope-never',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/scanner/scan 返回 batchId；scan:all 占用时 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      headers: authHeader(),
      body: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { batchId: string };
    expect(body.batchId.startsWith('scan-')).toBe(true);

    // 等编排器跑完（空库空 root 快速收尾）再占住身份测 409
    for (let i = 0; i < 50; i++) {
      if (
        !getTaskSystem()
          .snapshot()
          .batches.some((b) => b.status === 'running')
      )
        break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true);
    const res409 = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      headers: authHeader(),
      body: {},
    });
    expect(res409.statusCode).toBe(409);
    releaseIdentity(SCAN_ALL_IDENTITY);
  });

  it('POST /api/scanner/kill 无活跃批次 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/kill',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/work/:id/refresh → 202 { workId }，在飞重复 → 409', async () => {
    // 挂住 metadata executor：第一次请求 running，第二次 409
    let resolveGate!: () => void;
    const promise = new Promise<void>((r) => {
      resolveGate = r;
    });
    gate = { promise, resolve: resolveGate };
    getTaskSystem().registerExecutor('metadata', () =>
      gate!.promise.then(() => ({})),
    );

    const res1 = await app.inject({
      method: 'POST',
      url: `/api/work/${WORK_ID}/refresh`,
      headers: authHeader(),
    });
    expect(res1.statusCode).toBe(202);
    expect((res1.json() as { workId: string }).workId).toBe(WORK_ID);

    const res2 = await app.inject({
      method: 'POST',
      url: `/api/work/${WORK_ID}/refresh`,
      headers: authHeader(),
    });
    expect(res2.statusCode).toBe(409);

    // 收尾：放行 executor，任务终态
    gate.resolve();
    await new Promise((r) => setTimeout(r, 30));
  });

  it('POST /api/work/:id/refresh 不存在的作品 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/work/RJ999999999/refresh',
      headers: authHeader(),
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/work/:id/sync-tracks → 202；analyze → 202', async () => {
    const res1 = await app.inject({
      method: 'POST',
      url: `/api/work/${WORK_ID}/sync-tracks`,
      headers: authHeader(),
    });
    expect(res1.statusCode).toBe(202);

    const res2 = await app.inject({
      method: 'POST',
      url: `/api/work/${WORK_ID}/analyze`,
      headers: authHeader(),
    });
    expect(res2.statusCode).toBe(202);
  });

  it('POST /api/analysis/start 返回 batchId', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      headers: authHeader(),
      body: {},
    });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { batchId: string };
    expect(body.batchId.startsWith('analysis-')).toBe(true);
  });

  it('手动操作端点未认证 → 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: `/api/work/${WORK_ID}/refresh`,
    });
    expect(res.statusCode).toBe(401);
  });
});
