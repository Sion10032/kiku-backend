import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '@test/helpers/archive.js';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';

setupTestEnvironment();

// fetchDLsiteWorkInfo 计数：moved 任务不得重抓元数据
let fetchCount = 0;
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => {
    fetchCount++;
    return {
      title: `测试作品 ${rjCode}`,
      circle: '测试社团',
      ageRating: 'all' as const,
      releaseDate: '2024-01-01',
      tags: [],
      vas: [],
      rateCountDetail: {},
      rank: [],
    };
  },
}));
// 封面：exists=false 触发下载路径，downloadCover 计数验证 moved 补封面
let coverDownloadCount = 0;
mock.module('../services/cover.service.js', () => ({
  listCoverKeys: () => new Set(),
  coverBlobKey: (id: string, type: string) => `${id}_${type}`,
  coverExists: () => false,
  downloadCover: async () => {
    coverDownloadCount++;
    return true;
  },
  importLocalCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { performScan } = await import('./scanner.js');
const { db } = await import('../infra/db/main/index.js');
const { works, rootFolders } = await import('../infra/db/main/schema.js');

let root: string;
const base = 850000 + Math.floor(Math.random() * 100000);
const movedId = `RJ${base}`;
const manualId = `UW${base + 1}`;

async function runScan() {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../infra/config/index.js')).getConfig(),
      scannerMaxRecursionDepth: 2,
      maxParallelism: 2,
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
      results: { total: number; added: number; updated: number };
    } => (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

async function rowOf(id: string) {
  return (await db.select().from(works).where(eq(works.id, id)).limit(1))[0];
}

beforeAll(async () => {
  await db.delete(works);
  await db.delete(rootFolders);
  root = mkdtempSync(join(tmpdir(), 'kiku-moved-'));
  await ensureRootFolder('moveroot', root);
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db.delete(works).catch(() => {});
  await removeRootFolder('moveroot');
});

describe('performScan moved（仅路径变更）', () => {
  it('首次扫描：文件夹作品入库（重抓元数据）', async () => {
    const before = fetchCount;
    mkdirSync(join(root, movedId));
    writeFileSync(join(root, movedId, '01.mp3'), 'audio');
    mkdirSync(join(root, manualId));
    writeFileSync(join(root, manualId, '01.mp3'), 'audio');

    const events = await runScan();
    expect(resultsOf(events)?.added).toBe(2);
    expect(fetchCount).toBe(before + 1); // 仅 DLsite 作品抓取，manual 不触网

    const row = await rowOf(movedId);
    expect(row?.dir).toBe(movedId);
  });

  it('打包成 zip 后重扫：moved 不重抓元数据，仅更新路径 + 补封面', async () => {
    // 文件夹 → zip（同 ID，路径形态变化）
    rmSync(join(root, movedId), { recursive: true });
    writeFileSync(
      join(root, `${movedId}.zip`),
      buildZip([{ path: `${movedId}/01.mp3`, data: 'audio' }]),
    );
    const fetchBefore = fetchCount;
    coverDownloadCount = 0;

    const events = await runScan();
    expect(resultsOf(events)?.updated).toBeGreaterThanOrEqual(1);
    expect(resultsOf(events)?.added).toBe(0);
    // moved 核心：不重抓 DLsite 元数据
    expect(fetchCount).toBe(fetchBefore);
    // 吸收"校验封面"：moved 任务按需补缺失封面
    expect(coverDownloadCount).toBeGreaterThanOrEqual(1);

    const row = await rowOf(movedId);
    expect(row?.dir).toBe(`${movedId}.zip`);
    expect(row?.deletedAt).toBeNull();
    // 元数据未被覆盖（保持首次抓取结果）
    expect(row?.title).toBe(`测试作品 ${movedId}`);
  });

  it('manual 作品路径变更：走 manual 分支更新路径且不触网', async () => {
    rmSync(join(root, manualId), { recursive: true });
    writeFileSync(
      join(root, `${manualId}.zip`),
      buildZip([{ path: `${manualId}/01.mp3`, data: 'audio' }]),
    );
    const fetchBefore = fetchCount;

    const events = await runScan();
    expect(resultsOf(events)?.updated).toBeGreaterThanOrEqual(1);
    expect(fetchCount).toBe(fetchBefore);

    const row = await rowOf(manualId);
    expect(row?.dir).toBe(`${manualId}.zip`);
  });

  it('再次扫描：路径一致 → 恢复已扫描跳过', async () => {
    const events = await runScan();
    expect(resultsOf(events)?.total).toBe(0);
    const row = await rowOf(movedId);
    expect(row?.deletedAt).toBeNull();
  });
});
