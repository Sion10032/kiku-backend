import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { setConfigForTesting } from '../src/infra/config/index';
import { db } from '../src/infra/db/main/index';
import { works } from '../src/infra/db/main/schema';
import { scanner } from '../src/scanner/scanner';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

/**
 * Scanner 路由（app.inject 模式）。
 * workIds 子集只测 schema 校验与启动通道：传未命中 ID 使 update 空跑，
 * 不真抓 DLsite；mode=scan + workIds 应被 schema 拒绝。
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitScanIdle(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (scanner.isScanning) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('scan did not finish in time');
    }
    await sleep(20);
  }
}

describe('Scanner Routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await createTestUser('admin_scanner_route', 'administrator');
    adminToken = await signTokenFor(app, 'admin_scanner_route');
    // update 遍历库内作品（getAllWorkRefs），清空避免真抓远端
    await db.delete(works);
  });

  afterAll(async () => {
    await deleteTestUser('admin_scanner_route');
    await app.close();
    setConfigForTesting();
  });

  it('POST /api/scanner/scan 未认证 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      payload: { mode: 'update' },
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/scanner/scan {mode:update, workIds} 接受子集并触发扫描', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      payload: { mode: 'update', workIds: ['RJ99999999'] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; batchId: string }>();
    expect(body.success).toBe(true);
    expect(body.batchId.startsWith('update-')).toBe(true);
  });

  it('POST /api/scanner/scan {mode:update} 不带 workIds 保持旧形态', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      payload: { mode: 'update' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    await waitScanIdle();
  });

  it('POST /api/scanner/scan {mode:scan, workIds} 被 schema 拒绝 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      payload: { mode: 'scan', workIds: ['RJ99999999'] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/scanner/scan {workIds:[]} 空数组拒绝 400（空数组无子集语义）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/scanner/scan',
      payload: { mode: 'update', workIds: [] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });
});
