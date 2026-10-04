import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { getConfig } from '../../infra/config/index.js';
import { db } from '../../infra/db/main/index.js';
import { tracks, works } from '../../infra/db/main/schema.js';
import { TaskQueue } from '../../infra/taskQueue/index.js';
import { getPendingAnalysisWorkIds } from '../../services/track.service.js';
import { upsertWork } from '../../services/work.service.js';
import { TaskSystem } from '../taskSystem.js';
import { runAnalysisOrchestration } from './analysis.js';

setupTestEnvironment();

// ffmpeg mock：可用性可控；measure/extract 提供占位（executor 由 harness mock，不被真实调用）
let ffmpegAvailable = true;
let analyzeFailFor: string | null = null;
const analyzed: string[] = [];
mock.module('../../infra/audio/ffmpeg.js', () => ({
  checkFfmpegAvailable: async () => ffmpegAvailable,
  measureLoudness: async () => ({ lufs: -20, truePeakDb: -1, curve: [] }),
  measureLoudnessStream: async () => ({ lufs: -20, truePeakDb: -1, curve: [] }),
  extractToTemp: async () => {
    throw new Error('not used');
  },
}));

const config = getConfig();
const WORK_A = 'RJ800001';
const WORK_B = 'RJ800002';
const WORK_C = 'RJ800003';
const ALL = [WORK_A, WORK_B, WORK_C];

interface Harness {
  sys: TaskSystem;
  queue: TaskQueue;
  calls: string[];
}

function makeHarness(): Harness {
  const queue = new TaskQueue(
    { net: 2, cpu: 2 },
    { ttlMs: 60_000, intervalMs: 30_000 },
  );
  const sys = new TaskSystem(queue, { flushIntervalMs: 20 });
  const calls: string[] = [];
  sys.registerExecutor('analyze', (ctx) => {
    calls.push(ctx.workId);
    if (analyzeFailFor && ctx.workId.includes(analyzeFailFor)) {
      return Promise.reject(new Error('all tracks failed'));
    }
    return Promise.resolve({ detail: { analyzed: 2, failed: 1 } });
  });
  return { sys, queue, calls };
}

beforeAll(async () => {
  await ensureRootFolder('anaroot', '/tmp/kiku-ana-orch');
  for (const id of ALL) {
    await upsertWork({
      id,
      title: `T ${id}`,
      circleName: 'C',
      rootFolder: 'anaroot',
      dir: id,
    });
    await db.insert(tracks).values({
      workId: id,
      mediaIndex: 'a.wav',
      title: 'a',
      sizeBytes: 1,
      loudnessLufs: null,
    });
  }
});

afterAll(async () => {
  for (const id of ALL) {
    await db.delete(tracks).where(eq(tracks.workId, id));
    await db.delete(works).where(eq(works.id, id));
  }
  await removeRootFolder('anaroot');
});

beforeEach(async () => {
  ffmpegAvailable = true;
  analyzeFailFor = null;
  analyzed.length = 0;
  await db.delete(tracks).where(eq(tracks.workId, WORK_A));
  await db.delete(tracks).where(eq(tracks.workId, WORK_B));
  await db.delete(tracks).where(eq(tracks.workId, WORK_C));
});

async function seedNullTrack(workId: string): Promise<void> {
  await db.insert(tracks).values({
    workId,
    mediaIndex: 'a.wav',
    title: 'a',
    sizeBytes: 1,
    loudnessLufs: null,
  });
}

describe('runAnalysisOrchestration（analysis 编排器）', () => {
  test('ffmpeg 缺失 → 批次 failed、error 日志、返回 null、零注入', async () => {
    const h = makeHarness();
    try {
      ffmpegAvailable = false;
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        [WORK_A],
        'low',
        { sys: h.sys },
      );
      expect(summary).toBeNull();
      expect(h.calls).toEqual([]);
      const snap = h.sys.snapshot();
      const batch = snap.batches.at(-1);
      expect(batch?.status).toBe('failed');
      expect(
        snap.logs.some(
          (l) => l.level === 'error' && l.message.includes('ffmpeg not found'),
        ),
      ).toBe(true);
    } finally {
      h.queue.dispose();
    }
  });

  test('全量（DB pending）：注入全部待分析作品，SUMMARY 从 detail 累计', async () => {
    const h = makeHarness();
    try {
      await seedNullTrack(WORK_A);
      await seedNullTrack(WORK_B);
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        undefined,
        'low',
        { sys: h.sys },
      );
      // 第三作品无 NULL 轨 → 不在 pending
      expect(summary).toEqual({
        totalWorks: 2,
        analyzedTracks: 4, // 2 作品 × analyzed 2
        failedTracks: 2, // 2 作品 × failed 1
        failedWorks: 0,
      });
      expect(h.calls.sort()).toEqual([WORK_A, WORK_B].sort());
    } finally {
      h.queue.dispose();
    }
  });

  test('workIds 子集：只注入指定作品', async () => {
    const h = makeHarness();
    try {
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        [WORK_C],
        'high',
        { sys: h.sys },
      );
      expect(summary?.totalWorks).toBe(1);
      expect(h.calls).toEqual([WORK_C]);
    } finally {
      h.queue.dispose();
    }
  });

  test('作品全轨失败（executor 抛错）→ failedWorks 计数', async () => {
    const h = makeHarness();
    try {
      analyzeFailFor = WORK_A;
      await seedNullTrack(WORK_A);
      await seedNullTrack(WORK_B);
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        undefined,
        'low',
        { sys: h.sys },
      );
      expect(summary?.failedWorks).toBe(1);
      expect(summary?.analyzedTracks).toBe(2); // WORK_B 正常
      expect(summary?.failedTracks).toBe(1); // WORK_B 的 detail.failed
    } finally {
      h.queue.dispose();
    }
  });

  test('空待分析 → Nothing to analyze + 全零 SUMMARY', async () => {
    const h = makeHarness();
    try {
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        undefined,
        'low',
        { sys: h.sys },
      );
      expect(summary).toEqual({
        totalWorks: 0,
        analyzedTracks: 0,
        failedTracks: 0,
        failedWorks: 0,
      });
      expect(h.calls).toEqual([]);
    } finally {
      h.queue.dispose();
    }
  });

  test('abort → 返回 null（批次 cancelled）', async () => {
    const h = makeHarness();
    try {
      const controller = new AbortController();
      controller.abort();
      const summary = await runAnalysisOrchestration(
        config,
        controller.signal,
        [WORK_A],
        'high',
        { sys: h.sys },
      );
      expect(summary).toBeNull();
    } finally {
      h.queue.dispose();
    }
  });

  test('与 scan 并行：不占用 scan:all 互斥身份', async () => {
    const h = makeHarness();
    try {
      // scan:all 被 占用时 analysis 仍可运行
      const { acquireIdentity, SCAN_ALL_IDENTITY } = await import('./scan.js');
      expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true);
      await seedNullTrack(WORK_A);
      const summary = await runAnalysisOrchestration(
        config,
        new AbortController().signal,
        [WORK_A],
        'low',
        { sys: h.sys },
      );
      expect(summary?.totalWorks).toBe(1);
    } finally {
      h.queue.dispose();
    }
  });

  test('getPendingAnalysisWorkIds 与编排器口径一致（NULL 轨 + 未软删）', async () => {
    await seedNullTrack(WORK_A);
    const pending = await getPendingAnalysisWorkIds();
    expect(pending).toContain(WORK_A);
  });
});
