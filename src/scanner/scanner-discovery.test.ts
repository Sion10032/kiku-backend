import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { extname, join } from 'node:path';
import { buildZip } from '@test/helpers/archive.js';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';

setupTestEnvironment();

// 网络/封面隔离：先 mock 再动态 import 被测模块
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => ({
    title: `测试作品 ${rjCode}`,
    circle: '测试社团',
    ageRating: 'all' as const,
    releaseDate: '2024-01-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: [],
  }),
}));
mock.module('../services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  importLocalCover: async () => true,
  deleteAllCovers: () => 0,
}));

// openWorkSource 计数包装：断言已知作品跳过路径不再打开源目录。
// 注意 Bun mock.module 是活绑定替换，不能捕获 source/index.js 自身做委托
// （会无限递归）；这里用未被 mock 的叶子模块重组等价分发逻辑。
const folderMod = await import('../infra/fs/source/folder.js');
const zipMod = await import('../infra/fs/source/zip.js');
const tarMod = await import('../infra/fs/source/tar.js');
const typesMod = await import('../infra/fs/source/types.js');
let sourceOpenCount = 0;
mock.module('../infra/fs/source/index.js', () => ({
  openWorkSource: async (rootFolderPath: string, workDir: string) => {
    sourceOpenCount++;
    const fullPath = join(rootFolderPath, workDir);
    let isDir: boolean;
    try {
      isDir = statSync(fullPath).isDirectory();
    } catch {
      throw new Error(`work path not found: ${workDir}`);
    }
    if (isDir) return folderMod.createFolderSource(fullPath);
    const ext = extname(fullPath).toLowerCase();
    if (ext === '.tar') return await tarMod.createTarSource(fullPath);
    if (ext === '.zip') return await zipMod.createZipSource(fullPath);
    throw new typesMod.UnsupportedArchiveError(
      workDir,
      '不是 tar / stored zip 格式的作品包',
    );
  },
}));

const { performScan } = await import('./scanner.js');
const { db } = await import('../infra/db/main/index.js');
const { works, rootFolders } = await import('../infra/db/main/schema.js');

let root: string;
const base = 700000 + Math.floor(Math.random() * 100000);

async function runScan() {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../infra/config/index.js')).getConfig(),
      scannerMaxRecursionDepth: 2,
    },
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

function resultsOf(events: unknown[]) {
  return events.find(
    (
      e,
    ): e is {
      type: 'SCAN_RESULTS';
      results: { total: number; added: number; skipped: number };
    } => (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

function taskEvents(events: unknown[]) {
  return events.filter(
    (e): e is { type: string; task: { status: string } } =>
      (e as { type: string }).type === 'SCAN_TASK',
  );
}

function logMessages(events: unknown[]): string[] {
  return events
    .filter(
      (e): e is { type: 'SCAN_LOG'; log: { message: string } } =>
        (e as { type: string }).type === 'SCAN_LOG',
    )
    .map((e) => e.log.message);
}

function mentions(events: unknown[], id: string): boolean {
  return taskEvents(events).some((e) => JSON.stringify(e).includes(id));
}

beforeAll(async () => {
  // 同进程共享一个库：先清掉前序测试文件残留的作品/根目录
  await db.delete(works);
  await db.delete(rootFolders);
  root = mkdtempSync(join(tmpdir(), 'kiku-discovery-'));
  await ensureRootFolder('discroot', root);
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db.delete(works).catch(() => {});
  await removeRootFolder('discroot');
});

describe('performScan 发现阶段（已知作品跳过）', () => {
  const zipId = `RJ${base}`;

  it('首次扫描：zip 作品入库（任务处理需打开源）', async () => {
    writeFileSync(
      join(root, `${zipId}.zip`),
      buildZip([{ path: `${zipId}/01.mp3`, data: 'audio' }]),
    );
    const events = await runScan();
    expect(resultsOf(events)?.added).toBe(1);
    expect(sourceOpenCount).toBeGreaterThan(0);

    const row = (
      await db.select().from(works).where(eq(works.id, zipId)).limit(1)
    )[0];
    expect(row?.deletedAt).toBeNull();
  });

  it('重扫：路径未变 → 不打开源目录、无任务事件、计入 skipped', async () => {
    sourceOpenCount = 0;
    const events = await runScan();
    expect(sourceOpenCount).toBe(0);
    expect(resultsOf(events)?.skipped).toBe(1);
    expect(resultsOf(events)?.total).toBe(0);
    expect(taskEvents(events)).toHaveLength(0);
  });
});

describe('performScan 发现阶段（文件夹作品音频校验口径）', () => {
  it('顶层音频 → 入库', async () => {
    const id = `RJ${base + 1}`;
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, '01.mp3'), 'audio');
    const events = await runScan();
    expect(resultsOf(events)?.added).toBe(1);
  });

  it('子目录音频 → 入库（递归校验）', async () => {
    const id = `RJ${base + 2}`;
    mkdirSync(join(root, id, 'sub'), { recursive: true });
    writeFileSync(join(root, id, 'sub', '02.flac'), 'audio');
    const events = await runScan();
    expect(resultsOf(events)?.added).toBe(1);
  });

  it('脏目录名（sanitize 拒绝）下的音频不算 → 不建任务', async () => {
    const id = `RJ${base + 3}`;
    mkdirSync(join(root, id, '2:30'), { recursive: true });
    writeFileSync(join(root, id, '2:30', '03.mp3'), 'audio');
    const events = await runScan();
    expect(mentions(events, id)).toBe(false);
  });

  it('脏文件名（sanitize 拒绝）不算 → 不建任务', async () => {
    const id = `RJ${base + 4}`;
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'au:dio.mp3'), 'audio');
    const events = await runScan();
    expect(mentions(events, id)).toBe(false);
  });

  it('无音频（仅 txt）→ 不建任务', async () => {
    const id = `RJ${base + 5}`;
    mkdirSync(join(root, id));
    writeFileSync(join(root, id, 'readme.txt'), 'text');
    const events = await runScan();
    expect(mentions(events, id)).toBe(false);
  });

  it('已知作品音频被清空 → 仍按已扫描跳过（不再校验音频、不复活）', async () => {
    const id = `RJ${base + 1}`;
    rmSync(join(root, id, '01.mp3'));
    const events = await runScan();
    expect(mentions(events, id)).toBe(false);
    expect(resultsOf(events)?.skipped).toBeGreaterThanOrEqual(1);

    const row = (
      await db.select().from(works).where(eq(works.id, id)).limit(1)
    )[0];
    expect(row).toBeDefined();
    expect(row?.deletedAt).toBeNull();
  });
});

describe('performScan 发现阶段（进度可观测）', () => {
  it('每个 root 输出枚举/待处理/跳过计数日志，跳过数与扫描结果一致', async () => {
    const events = await runScan();
    const msg = logMessages(events).find((m) => /work entries/.test(m));
    expect(msg).toBeDefined();

    const total = Number(/Enumerated (\d+) work entries/.exec(msg ?? '')?.[1]);
    const toProcess = Number(/(\d+) to process/.exec(msg ?? '')?.[1]);
    const scanned = Number(/(\d+) already scanned/.exec(msg ?? '')?.[1]);
    expect(Number.isNaN(total)).toBe(false);
    expect(Number.isNaN(toProcess)).toBe(false);
    expect(Number.isNaN(scanned)).toBe(false);

    // 自洽：待处理 + 已跳过 = 枚举总数；跳过数与 SCAN_RESULTS.skipped 一致
    expect(toProcess + scanned).toBe(total);
    expect(resultsOf(events)?.skipped).toBe(scanned);
  });
});
