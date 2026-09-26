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
  deleteAllCovers: () => 0,
}));

const { performScan } = await import('./scanner.js');
const { db } = await import('../infra/db/main/index.js');
const { works, rootFolders } = await import('../infra/db/main/schema.js');

let root: string;
// RJ 后恰好 6 位数字；取 950000+ 段避开其他测试文件的随机号段
const base = 950000 + Math.floor(Math.random() * 49000);
const id = `RJ${base}`;
const ROOT_NAME = 'deadroot';

function makeSource(): void {
  writeFileSync(
    join(root, `${id}.zip`),
    buildZip([{ path: `${id}/01.mp3`, data: 'audio' }]),
  );
}

async function runScanRoots(roots: { name: string; path: string }[]) {
  for (const { name, path } of roots) {
    await ensureRootFolder(name, path);
  }
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

function runScan(rootPath: string) {
  return runScanRoots([{ name: ROOT_NAME, path: rootPath }]);
}

function resultsOf(events: unknown[]) {
  return events.find(
    (
      e,
    ): e is {
      type: 'SCAN_RESULTS';
      results: { total: number; removed: number; purged: number };
    } => (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

async function rowOf() {
  return (await db.select().from(works).where(eq(works.id, id)).limit(1))[0] as
    | { deletedAt: string | null }
    | undefined;
}

beforeAll(async () => {
  // 同进程共享一个库：先清掉前序测试文件残留的作品/根目录，扫描结果只受本文件影响
  await db.delete(works);
  await db.delete(rootFolders);
  root = mkdtempSync(join(tmpdir(), 'kiku-rootfail-'));
  makeSource();
  // 根目录行只建一次：后续用例会把目录整个删掉以模拟 readdir 失败，
  // 但行必须保留（path 指向那个被删目录）——fail-safe 依赖枚举失败可感知。
  await ensureRootFolder(ROOT_NAME, root);
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db
    .delete(works)
    .where(eq(works.id, id))
    .catch(() => {});
  await removeRootFolder(ROOT_NAME);
});

describe('performScan（root 枚举失败 fail-safe）', () => {
  it('入库后 root 目录整个消失 → 枚举失败：不 prune 该 root，且错误可感知', async () => {
    await runScan(root); // 首次扫描入库
    expect((await rowOf())?.deletedAt).toBeNull();

    // 整个 root 目录消失（模拟 NAS 未挂载 / 权限丢失 → readdir 失败）
    rmSync(root, { recursive: true, force: true });
    const events = await runScan(root);

    // 枚举失败 ≠ 目录为空：该 root 不参与 prune，作品不得被软删
    expect(resultsOf(events)?.removed).toBe(0);
    expect((await rowOf())?.deletedAt).toBeNull();

    // 失败可感知：error 级扫描日志
    const errorLogs = events.filter(
      (e): e is { type: 'SCAN_LOG'; log: { message: string } } =>
        (e as { type: string }).type === 'SCAN_LOG' &&
        (e as { log?: { level?: string } }).log?.level === 'error',
    );
    expect(errorLogs.map((e) => e.log.message).join('\n')).toContain(ROOT_NAME);

    // 失败可感知：失败任务事件
    const failedTasks = events.filter(
      (
        e,
      ): e is { type: 'SCAN_TASK'; task: { status: string; title: string } } =>
        (e as { type: string }).type === 'SCAN_TASK' &&
        (e as { task?: { status?: string } }).task?.status === 'failed',
    );
    expect(failedTasks.map((t) => t.task.title).join('\n')).toContain(
      ROOT_NAME,
    );
  });

  it('root 恢复为可枚举（空目录）→ prune 恢复执行（源缺失照常软删）', async () => {
    // 控制组：目录存在但为空（可枚举）→ 差集 prune 照常，不受 fail-safe 影响
    mkdirSync(root, { recursive: true });
    const events = await runScan(root);
    expect(resultsOf(events)?.removed).toBe(1);
    expect((await rowOf())?.deletedAt).not.toBeNull();
  });
});
