import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../../infra/db/main/index.js';
import { tracks, works } from '../../infra/db/main/schema.js';
import { getTrackRows } from '../../services/track.service.js';
import { upsertWork } from '../../services/work.service.js';
import { analyzeExecutor } from './analyze.js';
import type { PhaseContext } from './types.js';

setupTestEnvironment();

// 可控 mock：measure 按文件名子串失败；extractToTemp 记录调用（archive 分支）
let measureFailFor: string | null = null;
const measured: string[] = [];
const streamed: number[] = [];
mock.module('../../infra/audio/ffmpeg.js', () => ({
  measureLoudness: async (path: string) => {
    if (measureFailFor && path.includes(measureFailFor)) {
      throw new Error('ffmpeg exploded');
    }
    measured.push(path);
    return { lufs: -20, truePeakDb: -1, curve: [] };
  },
  measureLoudnessStream: async (input: { destroy?: () => void }) => {
    streamed.push(1);
    input.destroy?.(); // mock 不消费流，显式释放
    return { lufs: -20, truePeakDb: -1, curve: [] };
  },
  checkFfmpegAvailable: async () => true,
}));

// fs/source 不 mock：archive 用例走真实 openWorkSource（真实 zip fixture）

const WORK = 'RJ700001';
const WORK_ZIP = 'RJ700002'; // archive 流式作品（wav，可流式白名单内）
const WORK_ZIP_M4A = 'RJ700003'; // archive 不可流式作品（m4a，先跳过不分析）
const LIB_PATH = join(
  tmpdir(),
  `kiku-analyze-phase-${Date.now().toString(36)}`,
);

beforeAll(async () => {
  await ensureRootFolder('lib-analyze', LIB_PATH);
  mkdirSync(join(LIB_PATH, WORK), { recursive: true }); // folder 源只需目录存在（measure 为 mock 不读内容）
  const { buildZip } = await import('@test/helpers/archive.js');
  writeFileSync(
    join(LIB_PATH, `${WORK_ZIP}.zip`),
    buildZip([{ path: `${WORK_ZIP}/arc.wav`, data: 'zip-audio' }]),
  );
  writeFileSync(
    join(LIB_PATH, `${WORK_ZIP_M4A}.zip`),
    buildZip([{ path: `${WORK_ZIP_M4A}/arc.m4a`, data: 'zip-audio' }]),
  );
  await upsertWork({
    id: WORK,
    title: '分析作品',
    circleName: 'C',
    rootFolder: 'lib-analyze',
    dir: WORK,
  });
  await upsertWork({
    id: WORK_ZIP,
    title: '归档作品',
    circleName: 'C',
    rootFolder: 'lib-analyze',
    dir: `${WORK_ZIP}.zip`,
  });
  await upsertWork({
    id: WORK_ZIP_M4A,
    title: '归档 m4a 作品',
    circleName: 'C',
    rootFolder: 'lib-analyze',
    dir: `${WORK_ZIP_M4A}.zip`,
  });
});

afterAll(async () => {
  await db.delete(tracks).where(eq(tracks.workId, WORK));
  await db.delete(tracks).where(eq(tracks.workId, WORK_ZIP));
  await db.delete(tracks).where(eq(tracks.workId, WORK_ZIP_M4A));
  await db.delete(works).where(eq(works.id, WORK));
  await db.delete(works).where(eq(works.id, WORK_ZIP));
  await db.delete(works).where(eq(works.id, WORK_ZIP_M4A));
  await removeRootFolder('lib-analyze');
  rmSync(LIB_PATH, { recursive: true, force: true });
});

beforeEach(async () => {
  // 用例间隔离：清音轨行（works 共享 seed）
  await db.delete(tracks).where(eq(tracks.workId, WORK));
  await db.delete(tracks).where(eq(tracks.workId, WORK_ZIP));
  await db.delete(tracks).where(eq(tracks.workId, WORK_ZIP_M4A));
});

/** seed 音轨行：loudnessLufs 默认 null（待分析）。 */
async function seedTrack(
  mediaIndex: string,
  loudnessLufs: number | null = null,
): Promise<void> {
  await db
    .insert(tracks)
    .values({
      workId: WORK,
      mediaIndex,
      title: mediaIndex,
      sizeBytes: 1,
      loudnessLufs,
    })
    .onConflictDoNothing();
}

function makeCtx(workId: string): {
  ctx: PhaseContext;
  logs: Array<{ level: string; message: string }>;
} {
  const logs: Array<{ level: string; message: string }> = [];
  return {
    logs,
    ctx: {
      workId,
      variant: undefined,
      location: undefined,
      signal: new AbortController().signal,
      log: (level, message) => logs.push({ level, message }),
      force: false,
    },
  };
}

describe('analyzeExecutor', () => {
  test('NULL 轨被测量并写行，返回 detail 计数', async () => {
    await seedTrack('a.wav');
    await seedTrack('b.wav');
    measured.length = 0;
    const { ctx } = makeCtx(WORK);
    const result = await analyzeExecutor(ctx);
    expect(result.detail).toEqual({ analyzed: 2, failed: 0, skipped: 0 });
    expect(measured).toHaveLength(2);
    expect(measured[0]).toContain('a.wav');
    const rows = await getTrackRows(WORK);
    for (const r of rows) expect(r.loudnessLufs).toBe(-20);
  });

  test('已有响度的行跳过（只补 NULL 轨）', async () => {
    await seedTrack('done.wav', -15);
    await seedTrack('todo.wav');
    measured.length = 0;
    const { ctx } = makeCtx(WORK);
    await analyzeExecutor(ctx);
    expect(measured).toHaveLength(1);
    expect(measured[0]).toContain('todo.wav');
  });

  test('单轨测量失败：写 analyzeError、其余照常、error 日志', async () => {
    await seedTrack('a.wav');
    await seedTrack('b.wav');
    measured.length = 0;
    measureFailFor = 'a.wav';
    const { ctx, logs } = makeCtx(WORK);
    const result = await analyzeExecutor(ctx);
    measureFailFor = null;
    expect(result.detail).toEqual({ analyzed: 1, failed: 1, skipped: 0 });
    const rows = await getTrackRows(WORK);
    const failedRow = rows.find((r) => r.analyzeError);
    expect(failedRow?.analyzeError).toBe('ffmpeg exploded');
    expect(
      logs.some(
        (l) => l.level === 'error' && l.message.includes('Track failed'),
      ),
    ).toBe(true);
  });

  test('全部轨失败 → 阶段抛错（可重试：NULL 轨续跑）', async () => {
    await seedTrack('only.wav');
    measureFailFor = 'only.wav';
    const { ctx } = makeCtx(WORK);
    await expect(analyzeExecutor(ctx)).rejects.toThrow('1 tracks failed');
    measureFailFor = null;
  });

  test('作品不在库 → 抛错', async () => {
    const { ctx } = makeCtx('RJ799999');
    await expect(analyzeExecutor(ctx)).rejects.toThrow('not found');
  });

  test('archive 源 wav 轨走流式测量（不经临时文件）', async () => {
    await db
      .insert(tracks)
      .values({
        workId: WORK_ZIP,
        mediaIndex: 'arc.wav', // zip 源 hash 经 stripCommonTopDir，不带顶层目录
        title: 'arc.wav',
        sizeBytes: 1,
        loudnessLufs: null,
      })
      .onConflictDoNothing();
    streamed.length = 0;
    const { ctx } = makeCtx(WORK_ZIP);
    const result = await analyzeExecutor(ctx);
    expect(streamed).toHaveLength(1); // 流式测量被调
    expect(result.detail).toEqual({ analyzed: 1, failed: 0, skipped: 0 });
  });

  test('archive 源不可流式格式（m4a）跳过不分析，行保持 NULL', async () => {
    await db
      .insert(tracks)
      .values({
        workId: WORK_ZIP_M4A,
        mediaIndex: 'arc.m4a', // zip 源 hash 不带顶层目录
        title: 'arc.m4a',
        sizeBytes: 1,
        loudnessLufs: null,
      })
      .onConflictDoNothing();
    streamed.length = 0;
    const { ctx, logs } = makeCtx(WORK_ZIP_M4A);
    const result = await analyzeExecutor(ctx);
    expect(streamed).toHaveLength(0); // 不进 ffmpeg
    expect(result.detail).toEqual({ analyzed: 0, failed: 0, skipped: 1 });
    const rows = await getTrackRows(WORK_ZIP_M4A);
    expect(rows[0]?.loudnessLufs).toBeNull();
    expect(
      logs.some(
        (l) => l.level === 'warning' && l.message.includes('not streamable'),
      ),
    ).toBe(true);
  });
});
