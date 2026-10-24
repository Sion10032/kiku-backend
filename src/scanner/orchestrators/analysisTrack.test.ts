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
import { getConfig, setConfigForTesting } from '../../infra/config/index.js';
import { db } from '../../infra/db/main/index.js';
import { tracks, works } from '../../infra/db/main/schema.js';
import { TaskQueue } from '../../infra/taskQueue/index.js';
import { upsertWork } from '../../services/work.service.js';
import { TaskSystem } from '../taskSystem.js';
import {
  maybeEnqueueTrackAnalysis,
  resetTrackAnalysisFfmpegCacheForTesting,
} from './analysisTrack.js';

setupTestEnvironment();

// ffmpeg 可用性可控（measure 不被真实调用：harness 的 analyze executor 为 mock）
let ffmpegAvailable = true;
mock.module('../../infra/audio/ffmpeg.js', () => ({
  checkFfmpegAvailable: async () => ffmpegAvailable,
}));

const WORK = 'RJ810001';
const originalConfig = getConfig();

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  sys: TaskSystem;
  queue: TaskQueue;
  runs: Array<{ workId: string; mediaIndex: string | undefined }>;
}

function makeHarness(): Harness {
  const queue = new TaskQueue(
    { net: 1, cpu: 1 },
    { ttlMs: 60_000, intervalMs: 30_000 },
  );
  const sys = new TaskSystem(queue, { flushIntervalMs: 20 });
  const runs: Array<{ workId: string; mediaIndex: string | undefined }> = [];
  sys.registerExecutor('analyze', (ctx) => {
    runs.push({ workId: ctx.workId, mediaIndex: ctx.mediaIndex });
    return Promise.resolve({});
  });
  return { sys, queue, runs };
}

/** seed 音轨行：默认待分析（loudness NULL、无错误记录）。 */
async function seedTrack(
  mediaIndex: string,
  opts: { lufs?: number | null; error?: string } = {},
): Promise<void> {
  const lufs = opts.lufs ?? null;
  const error = opts.error ?? null;
  await db
    .insert(tracks)
    .values({
      workId: WORK,
      mediaIndex,
      title: mediaIndex,
      sizeBytes: 1,
      loudnessLufs: lufs,
      analyzeError: error,
    })
    .onConflictDoUpdate({
      target: [tracks.workId, tracks.mediaIndex],
      set: { loudnessLufs: lufs, analyzeError: error },
    });
}

beforeAll(async () => {
  await ensureRootFolder('anaroot-onplay', '/tmp/kiku-onplay');
  await upsertWork({
    id: WORK,
    title: 'T',
    circleName: 'C',
    rootFolder: 'anaroot-onplay',
    dir: WORK,
  });
});

afterAll(async () => {
  await db.delete(tracks).where(eq(tracks.workId, WORK));
  await db.delete(works).where(eq(works.id, WORK));
  await removeRootFolder('anaroot-onplay');
  setConfigForTesting(originalConfig);
});

beforeEach(async () => {
  await db.delete(tracks).where(eq(tracks.workId, WORK));
  await db.update(works).set({ deletedAt: null }).where(eq(works.id, WORK));
  setConfigForTesting({ ...getConfig(), loudnessAnalysisOnPlay: true });
  ffmpegAvailable = true;
  resetTrackAnalysisFfmpegCacheForTesting();
});

describe('maybeEnqueueTrackAnalysis（播放触发单轨分析钩子）', () => {
  test('开关关闭 → 不入队', async () => {
    setConfigForTesting({ ...getConfig(), loudnessAnalysisOnPlay: false });
    await seedTrack('a.wav');
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'a.wav', { sys: h.sys });
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('未分析轨 + ffmpeg 可用 → 入队并执行（executor 收到 mediaIndex）', async () => {
    await seedTrack('a.wav');
    await seedTrack('done.wav', { lufs: -15 }); // 已分析轨不构成干扰
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'a.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toEqual([{ workId: WORK, mediaIndex: 'a.wav' }]);
    } finally {
      h.queue.dispose();
    }
  });

  test('已有响度 → 不入队（不重复扫）', async () => {
    await seedTrack('done.wav', { lufs: -15 });
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'done.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('失败过的轨（analyzeError）→ 不自动重扫，留给手动/整库分析', async () => {
    await seedTrack('bad.wav', { error: 'ffmpeg exited 1' });
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'bad.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('作品已软删 → 不入队', async () => {
    await db
      .update(works)
      .set({ deletedAt: new Date().toISOString() })
      .where(eq(works.id, WORK));
    await seedTrack('a.wav');
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'a.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('轨不存在（上报后未扫描的新文件）→ 不入队不抛错', async () => {
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'ghost.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('ffmpeg 缺失 → 不入队', async () => {
    ffmpegAvailable = false;
    await seedTrack('a.wav');
    const h = makeHarness();
    try {
      await maybeEnqueueTrackAnalysis(WORK, 'a.wav', { sys: h.sys });
      await sleep(20);
      expect(h.runs).toHaveLength(0);
    } finally {
      h.queue.dispose();
    }
  });
});
