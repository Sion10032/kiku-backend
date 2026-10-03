import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { blobExists, putBlob } from '../infra/db/blob/index.js';

setupTestEnvironment();

// 网络隔离：DLsite 抓取 mock。手动分支零网络——若作品标题来自此 mock（含
// 「DLsite 元数据」字样）即为实现错误，断言会失败。
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (workCode: string) => ({
    title: `DLsite 元数据 ${workCode}`,
    circle: '不应出现的社团',
    ageRating: 'all' as const,
    releaseDate: '2024-01-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: [],
  }),
}));

// 封面：下载绝不触网（手动分支只允许本地导入）；
// importLocalCover 按真实实现同构写入 blob 库（断言「UW00000001_main 存在」依赖）。
mock.module('../services/cover.service.js', () => ({
  listCoverKeys: () => new Set(),
  coverBlobKey: (id: string, type: string) => `${id}_${type}`,
  coverExists: (id: string, type: string = 'main') =>
    blobExists('cover', `${id}_${type}`),
  downloadCover: async () => true,
  deleteAllCovers: () => 0,
  importLocalCover: async (id: string, workDir: string) => {
    const entries = await readdir(workDir).catch(() => null);
    if (!entries) return false;
    const hit = entries.find((e) =>
      /^(cover|folder)\.(jpe?g|png|webp)$/i.test(e),
    );
    if (!hit) return false;
    const data = await readFile(join(workDir, hit)).catch(() => null);
    if (!data) return false;
    putBlob('cover', `${id}_main`, data, 'image/jpeg');
    return true;
  },
}));

const { performScan, performUpdate } = await import('./scanner.js');
const { refreshWorkMetadata } = await import('./workOps.js');
const { db } = await import('../infra/db/main/index.js');
const { works, rootFolders } = await import('../infra/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { getConfig, setConfigForTesting } = await import(
  '../infra/config/index.js'
);

const ROOT_FOLDER = 'manual-root';
const sine = readFileSync(
  join(import.meta.dir, '../../test/fixtures/audio/sine.wav'),
);

// 8 位编号 + 中文标题（复现简报示例）
const UW_ID = 'UW00000001';
const UW_DIR = `${UW_ID}_测试作品`;
// 6 位编号同样合法
const UW6_ID = 'UW123456';
const UW6_DIR = `${UW6_ID}_缩号`;
// 未配置前缀：不得被当作作品
const XX_DIR = 'XX00000001_未配置前缀';

let root: string;
let scanEvents: unknown[] = [];

beforeAll(async () => {
  // 同进程共享一个库：先清掉前序测试文件残留的作品/根目录，扫描结果只受本文件影响
  await db.delete(works);
  await db.delete(rootFolders);
  root = mkdtempSync(join(tmpdir(), 'kiku-manual-'));

  mkdirSync(join(root, UW_DIR), { recursive: true });
  writeFileSync(join(root, UW_DIR, 'sine.wav'), sine);
  writeFileSync(join(root, UW_DIR, 'cover.jpg'), 'fake-jpeg-data');

  mkdirSync(join(root, UW6_DIR), { recursive: true });
  writeFileSync(join(root, UW6_DIR, 'sine.wav'), sine);

  mkdirSync(join(root, XX_DIR), { recursive: true });
  writeFileSync(join(root, XX_DIR, 'sine.wav'), sine);

  await ensureRootFolder(ROOT_FOLDER, root);
});

afterAll(async () => {
  await db.delete(works).where(eq(works.circleId, 'unknown'));
  await db
    .delete(works)
    .where(eq(works.rootFolder, ROOT_FOLDER))
    .catch(() => {});
  await removeRootFolder(ROOT_FOLDER);
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

async function runScan(): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of performScan(
    getConfig(),
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
      results: { total: number; added: number };
    } => (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

function taskTitles(events: unknown[]): string[] {
  return events
    .filter(
      (e): e is { type: 'SCAN_TASK'; task: { title: string } } =>
        (e as { type: string }).type === 'SCAN_TASK',
    )
    .map((e) => e.task.title);
}

async function workRow(id: string) {
  return (await db.select().from(works).where(eq(works.id, id)).limit(1))[0] as
    | { id: string; title: string; circleId: string; deletedAt: string | null }
    | undefined;
}

describe('performScan（手动作品分支）', () => {
  it('UW 前缀文件夹导入为作品：本地标题、unknown 社团、本地封面入库', async () => {
    scanEvents = await runScan();

    const row = await workRow(UW_ID);
    expect(row).toBeDefined();
    // 标题来自 deriveManualTitle，而非 DLsite mock
    expect(row?.title).toBe('测试作品');
    expect(row?.circleId).toBe('unknown');
    expect(row?.deletedAt).toBeNull();

    // 本地封面已导入 blob 库
    expect(blobExists('cover', `${UW_ID}_main`)).toBe(true);
  });

  it('6 位编号 UW123456 同样入库', async () => {
    const row = await workRow(UW6_ID);
    expect(row).toBeDefined();
    expect(row?.title).toBe('缩号');
    expect(row?.circleId).toBe('unknown');
  });

  it('未配置前缀 XX 不产生作品与任务', async () => {
    expect(await workRow('XX00000001')).toBeUndefined();
    const titles = taskTitles(scanEvents).join('\n');
    expect(titles).not.toContain('XX');
    // 只有两个 UW 作品建了任务
    expect(resultsOf(scanEvents)?.total).toBe(2);
    expect(resultsOf(scanEvents)?.added).toBe(2);
  });

  it('performUpdate 跳过手动作品：不建任务', async () => {
    const events: unknown[] = [];
    for await (const ev of performUpdate(
      getConfig(),
      new AbortController().signal,
    )) {
      events.push(ev);
    }
    expect(taskTitles(events)).toHaveLength(0);
  });

  it('refreshWorkMetadata 拒绝手动作品且不触网', async () => {
    const result = await refreshWorkMetadata(UW_ID);
    expect(result).toEqual({ ok: false, reason: 'manual-work-no-remote' });
  });
});
