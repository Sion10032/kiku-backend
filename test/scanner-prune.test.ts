import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { eq } from 'drizzle-orm';
import { buildZip } from './helpers/archive.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// 网络/封面隔离：先 mock 再动态 import 被测模块
mock.module('../src/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => ({
    title: `测试作品 ${rjCode}`,
    circle: '测试社团',
    nsfw: false,
    releaseDate: '2024-01-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: {},
  }),
}));
mock.module('../src/services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { performScan } = await import('../src/filesystem/scanner.js');
const { db } = await import('../src/db/main/index.js');
const { works } = await import('../src/db/main/schema.js');

let root: string;
const base = 400000 + Math.floor(Math.random() * 500000);
const id = `RJ${base}`;

function makeSource(): void {
  writeFileSync(
    join(root, `${id}.zip`),
    buildZip([{ path: `${id}/01.mp3`, data: 'audio' }]),
  );
}

async function runScan() {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../src/config/index.js')).getConfig(),
      rootFolders: [{ name: 'scanroot', path: root }],
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
      results: { removed: number; purged: number };
    } => (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kiku-prune-'));
  makeSource();
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db
    .delete(works)
    .where(eq(works.id, id))
    .catch(() => {});
});

describe('performScan 源缺失清理', () => {
  it('首次扫描入库；删除源后再次扫描 → 软删且 removed=1', async () => {
    await runScan();
    const before = (
      await db.select().from(works).where(eq(works.id, id)).limit(1)
    )[0];
    expect(before?.deletedAt).toBeNull();

    // 删除源文件
    rmSync(join(root, `${id}.zip`), { force: true });
    const events = await runScan();
    expect(resultsOf(events)?.removed).toBe(1);

    const after = (
      await db.select().from(works).where(eq(works.id, id)).limit(1)
    )[0];
    expect(after?.deletedAt).not.toBeNull();
  });

  it('源恢复后再次扫描 → 自动复活（deletedAt 清空，不新增记录）', async () => {
    makeSource();
    const events = await runScan();
    // 源在盘，不产生 removed
    expect(resultsOf(events)?.removed).toBe(0);

    const row = (
      await db.select().from(works).where(eq(works.id, id)).limit(1)
    )[0];
    expect(row?.deletedAt).toBeNull();
  });

  it('软删超期后扫描 → 物理清理（purged=1，记录消失）', async () => {
    // 删除源并伪造超期软删标记（31 天前）
    rmSync(join(root, `${id}.zip`), { force: true });
    await db
      .update(works)
      .set({
        deletedAt: new Date(
          Date.now() - 31 * 24 * 60 * 60 * 1000,
        ).toISOString(),
      })
      .where(eq(works.id, id));

    const events = await runScan();
    expect(resultsOf(events)?.purged).toBe(1);

    const row = (
      await db.select().from(works).where(eq(works.id, id)).limit(1)
    )[0];
    expect(row).toBeUndefined();
  });
});
