import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { getConfig, setConfigForTesting } from '../src/infra/config/index';
import { db } from '../src/infra/db/main/index';
import { tracks, works } from '../src/infra/db/main/schema';
import { getTaskSystem } from '../src/scanner/taskSystem';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

/**
 * Analysis 路由（新契约：start 返回 batchId，进度走 /api/tasks/events）
 * + scan → analysis 自动接力（旧 ScannerManager 路径，Task 11 随旧外壳一并清理）。
 * 依赖空库（无待分析数据）：全量 start 立即结束，不真跑 ffmpeg 长分析。
 */

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 轮询等待指定 analysis 批次终态 */
async function waitBatchDone(batchId: string, timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  for (;;) {
    const batch = getTaskSystem()
      .snapshot()
      .batches.find((b) => b.batchId === batchId);
    if (batch && batch.status !== 'running') return;
    if (Date.now() - start > timeoutMs) {
      throw new Error('analysis batch did not finish in time');
    }
    await sleep(20);
  }
}

describe('Analysis Routes', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 回查鉴权要求管理员真实入库，group 以库行为准
    await createTestUser('admin_analysis_route', 'administrator');
    adminToken = await signTokenFor(app, 'admin_analysis_route');
    // 空库防御：无论文件执行顺序如何，保证无待分析数据
    await db.delete(tracks);
    await db.delete(works);
  });

  afterAll(async () => {
    await deleteTestUser('admin_analysis_route');
    await app.close();
    // 清空 config 缓存，避免污染同进程后续测试文件
    setConfigForTesting();
  });

  it('POST /api/analysis/start 未认证 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: {},
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/analysis/stop 未认证 401', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/stop',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST /api/analysis/start {workIds, priority:high} → batchId，批次入任务中心', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: { workIds: ['RJ00000001'], priority: 'high' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; batchId: string }>();
    expect(body.success).toBe(true);
    expect(body.batchId.startsWith('analysis-')).toBe(true);
    await waitBatchDone(body.batchId);
  });

  it('POST /api/analysis/start 旧 workId 字段已废弃：strip 后按全量请求', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: { workId: 'RJ00000001' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; batchId: string }>();
    expect(body.batchId.startsWith('analysis-')).toBe(true);
    await waitBatchDone(body.batchId);
  });

  it('POST /api/analysis/start {workIds:[]} 空数组拒绝 400（空数组无子集语义）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: { workIds: [] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/analysis/start 非法 priority → 400', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: { workIds: ['RJ00000001'], priority: 'urgent' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(400);
  });

  it('POST /api/analysis/stop 无活跃 analysis 批次 → 404', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/stop',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(404);
  });

  it('POST /api/analysis/start 空库全量触发启动并立即结束（SUMMARY 全零）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; batchId: string }>();
    expect(body.success).toBe(true);
    await waitBatchDone(body.batchId);
    const batch = getTaskSystem()
      .snapshot()
      .batches.find((b) => b.batchId === body.batchId);
    expect(batch?.status).toBe('completed');
    expect(batch?.results).toEqual({
      totalWorks: 0,
      analyzedTracks: 0,
      failedTracks: 0,
      failedWorks: 0,
    });
  });

  it('POST /api/analysis/start {workIds} 子集启动（空库立即结束）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: { workIds: ['RJ99999999'] },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{ success: boolean; batchId: string }>();
    expect(body.batchId.startsWith('analysis-')).toBe(true);
    await waitBatchDone(body.batchId);
  });

  describe('scan → analysis 自动接力（autoLoudnessAnalysis）', () => {
    it('配置开启且 scan 正常收尾后自动触发 analysis 批次', async () => {
      setConfigForTesting({
        ...getConfig(),
        autoLoudnessAnalysis: true,
      });
      const scanRes = await app.inject({
        method: 'POST',
        url: '/api/scanner/scan',
        payload: {},
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(scanRes.statusCode).toBe(200);
      // scan 编排器收尾后 fire-and-forget 接力；轮询任务中心出现 analysis 批次
      const deadline = Date.now() + 5000;
      let analysisBatch = false;
      while (Date.now() < deadline) {
        const snap = getTaskSystem().snapshot();
        if (snap.batches.some((b) => b.kind === 'analysis')) {
          analysisBatch = true;
          break;
        }
        await sleep(50);
      }
      expect(analysisBatch).toBe(true);
    });
  });
});
