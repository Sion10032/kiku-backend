import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { getConfig, setConfigForTesting } from '../src/infra/config/index';
import { db } from '../src/infra/db/main/index';
import { tracks, works } from '../src/infra/db/main/schema';
import { analysisManager } from '../src/scanner/analysis';
import { scanner } from '../src/scanner/scanner';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

/**
 * Analysis 路由 + scan 后自动接力（app.inject 模式）。
 * 依赖空库（无待分析数据）：全量 start 立即结束，不真跑 ffmpeg 长分析。
 */

/** manager 私有态（测试直接戳，避免真跑分析） */
interface ManagerInternal {
  analyzing: boolean;
  priority: string[];
}

const internals = () => analysisManager as unknown as ManagerInternal;

/** 轮询等待 manager 空闲（空队列分析应秒级结束） */
const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

async function waitIdle(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (analysisManager.isAnalyzing) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('analysis did not finish in time');
    }
    await sleep(20);
  }
}

/** 轮询等待扫描结束（接力 startAnalysis 与 scanning=false 同步块内完成，无竞态） */
async function waitScanIdle(timeoutMs = 5000): Promise<void> {
  const start = Date.now();
  while (scanner.isScanning) {
    if (Date.now() - start > timeoutMs) {
      throw new Error('scan did not finish in time');
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
    analysisManager.killAnalysis();
    await deleteTestUser('admin_analysis_route');
    await app.close();
    // 清空 config 缓存，避免污染同进程后续测试文件
    setConfigForTesting();
  });

  it('GET /api/analysis/status 未分析过返回初始形状', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analysis/status',
      // 私有模式全局守卫要求 JWT；status 端点本身无 admin 限制
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ isAnalyzing: boolean; snapshot: unknown }>()).toEqual({
      isAnalyzing: false,
      snapshot: null,
    });
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

  it('POST /api/analysis/start {workId} 在跑时走优先队列返回 queued=true', async () => {
    const m = internals();
    m.analyzing = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/analysis/start',
        payload: { workId: 'RJ00000001' },
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ success: boolean; queued: boolean }>()).toEqual({
        success: true,
        queued: true,
      });
      expect(m.priority).toContain('RJ00000001');
    } finally {
      m.analyzing = false;
      m.priority = [];
    }
  });

  it('POST /api/analysis/start 已在跑且无 workId → queued=false', async () => {
    const m = internals();
    m.analyzing = true;
    try {
      const res = await app.inject({
        method: 'POST',
        url: '/api/analysis/start',
        payload: {},
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json<{ success: boolean; queued: boolean }>()).toEqual({
        success: true,
        queued: false,
      });
      expect(m.priority).toEqual([]);
    } finally {
      m.analyzing = false;
      m.priority = [];
    }
  });

  it('POST /api/analysis/stop 管理员调用返回 success（无分析时 no-op）', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/stop',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean }>()).toEqual({ success: true });
  });

  describe('scan → analysis 自动接力', () => {
    it('自动分析关闭时不接力（snapshot 保持 null）', async () => {
      setConfigForTesting({
        ...getConfig(),
        autoLoudnessAnalysis: false,
        rootFolders: [],
      });
      scanner.startScan(getConfig(), 'scan');
      await waitScanIdle();
      expect(scanner.isScanning).toBe(false);
      expect(analysisManager.getSnapshot()).toBeNull();
      expect(analysisManager.isAnalyzing).toBe(false);
    });

    it('配置开启且 scan 正常结束后启动分析（snapshot 已置）', async () => {
      setConfigForTesting({
        ...getConfig(),
        autoLoudnessAnalysis: true,
        rootFolders: [],
      });
      scanner.startScan(getConfig(), 'scan');
      await waitScanIdle();
      // startAnalysis 在 runScan 同步块内置空快照；观察到扫描结束即已接力
      expect(analysisManager.getSnapshot()).not.toBeNull();
      await waitIdle();
      expect(analysisManager.isAnalyzing).toBe(false);
    });
  });

  it('POST /api/analysis/start 空库全量触发启动并立即结束', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/analysis/start',
      payload: {},
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ success: boolean; queued: boolean }>()).toEqual({
      success: true,
      queued: false,
    });
    await waitIdle();
    expect(analysisManager.isAnalyzing).toBe(false);
  });

  it('GET /api/analysis/status 分析后返回快照形状', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/analysis/status',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json<{
      isAnalyzing: boolean;
      snapshot: {
        tasks: unknown[];
        failedTasks: unknown[];
        completed: number;
        logs: unknown[];
      } | null;
    }>();
    expect(body.isAnalyzing).toBe(false);
    expect(body.snapshot).not.toBeNull();
    expect(body.snapshot?.tasks).toEqual([]);
    expect(body.snapshot?.failedTasks).toEqual([]);
    expect(body.snapshot?.completed).toBe(0);
    expect(Array.isArray(body.snapshot?.logs)).toBe(true);
  });
});
