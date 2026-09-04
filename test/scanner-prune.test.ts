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
    ageRating: 'all' as const,
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
const { db } = await import('../src/infra/db/main/index.js');
const { works } = await import('../src/infra/db/main/schema.js');
const { softDeleteWork } = await import('../src/services/work.service.js');

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
      ...(await import('../src/infra/config/index.js')).getConfig(),
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
      results: {
        total: number;
        skipped: number;
        removed: number;
        purged: number;
      };
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

    // 唯一作品的全量状态转移序列：pending → scanning → completed
    const statuses = events
      .filter(
        (e): e is { type: 'SCAN_TASK'; task: { status: string } } =>
          (e as { type: string }).type === 'SCAN_TASK',
      )
      .map((e) => e.task.status);
    expect(statuses).toEqual(['pending', 'scanning', 'completed']);

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

describe('performScan（已扫描作品过滤）', () => {
  const id2 = `RJ${base + 100}`;

  beforeAll(() => {
    writeFileSync(
      join(root, `${id2}.zip`),
      buildZip([{ path: `${id2}/01.mp3`, data: 'audio' }]),
    );
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.id, id2));
  });

  function taskEvents(events: unknown[]) {
    return events.filter(
      (e): e is { type: string; task: { status: string } } =>
        (e as { type: string }).type === 'SCAN_TASK',
    );
  }

  it('首次扫描建任务；重扫描（路径未变、未软删）无任何任务事件且计入 skipped', async () => {
    // 注：前面的既有用例结束时已删除 id 的源文件并物理清理其 DB 行，
    // 故本 describe 运行时盘上只有 id2.zip
    const first = await runScan();
    expect(taskEvents(first).length).toBeGreaterThan(0);

    const second = await runScan();
    expect(
      taskEvents(second).filter(
        (e) =>
          JSON.stringify(e).includes(id2) || JSON.stringify(e).includes(id),
      ),
    ).toHaveLength(0);
    expect(resultsOf(second)?.skipped).toBe(1);
    expect(resultsOf(second)?.total).toBe(0);

    // 作品仍在库且未被误软删/清理
    const row = (
      await db.select().from(works).where(eq(works.id, id2)).limit(1)
    )[0];
    expect(row).toBeDefined();
    expect(row?.deletedAt).toBeNull();
  });

  it('软删后源恢复 → 重新建任务并清除软删标记', async () => {
    await softDeleteWork(id2);
    const events = await runScan();
    const statuses = taskEvents(events)
      .filter((e) => JSON.stringify(e).includes(id2))
      .map((e) => (e as { task: { status: string } }).task.status);
    expect(statuses).toEqual(['pending', 'scanning', 'completed']);
    const row = (
      await db.select().from(works).where(eq(works.id, id2)).limit(1)
    )[0];
    expect(row?.deletedAt).toBeNull();
  });

  it('dir 漂移（路径变化）→ 重新建任务并修正 dir', async () => {
    await db.update(works).set({ dir: 'wrong/path' }).where(eq(works.id, id2));
    const events = await runScan();
    expect(
      taskEvents(events).some((e) => JSON.stringify(e).includes(id2)),
    ).toBe(true);
    const row = (
      await db.select().from(works).where(eq(works.id, id2)).limit(1)
    )[0];
    expect(row?.dir).toBe(`${id2}.zip`);
  });
});
