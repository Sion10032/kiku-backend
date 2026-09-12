import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '@test/helpers/archive.js';
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
const { works } = await import('../infra/db/main/schema.js');
const { upsertWork } = await import('../services/work.service.js');

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

async function runScanRoots(rootFolders: { name: string; path: string }[]) {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../infra/config/index.js')).getConfig(),
      rootFolders,
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

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kiku-rootfail-'));
  makeSource();
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db
    .delete(works)
    .where(eq(works.id, id))
    .catch(() => {});
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

describe('performScan（同名 root 部分枚举失败）', () => {
  // config schema 不校验 rootFolders 名称唯一：同名双 root、其一枚举失败时，
  // DB 作品按 root 名归属（getWorksByRootFolder）无法按 path 区分，
  // 该名下作品必须整名排除出 prune，否则失败 root 的作品会被同名成功 root
  // 的 prune 轮误软删（P1-2 灾难在同名配置下复现）。
  const dualName = 'dualroot';
  // 独立 940000–948999 号段：与 workOps.test.ts 的 320000–919999 完全错开
  const dualBase = 940000 + Math.floor(Math.random() * 9000);
  const idA = `RJ${dualBase}`; // 归属 A 的缺失作品（源已删除）
  const idB = `RJ${dualBase + 1}`; // 归属 B（枚举失败）的作品
  let rootA: string;
  let rootB: string;

  async function rowOfById(workId: string) {
    return (
      await db.select().from(works).where(eq(works.id, workId)).limit(1)
    )[0] as { deletedAt: string | null } | undefined;
  }

  beforeAll(async () => {
    rootA = mkdtempSync(join(tmpdir(), 'kiku-dual-a-'));
    rootB = join(tmpdir(), `kiku-dual-b-${dualBase}-missing`); // 不存在 → readdir 失败
    // 直接入库：DB 只有 root 名归属，无法表达「属于同名双 root 中的哪一个 path」
    await upsertWork({
      id: idA,
      rootFolder: dualName,
      dir: `${idA}.zip`,
      title: 'A-missing',
      circleName: 'C',
    });
    await upsertWork({
      id: idB,
      rootFolder: dualName,
      dir: `${idB}.zip`,
      title: 'B-unreachable',
      circleName: 'C',
    });
  });

  afterAll(async () => {
    rmSync(rootA, { recursive: true, force: true });
    for (const workId of [idA, idB]) {
      await db
        .delete(works)
        .where(eq(works.id, workId))
        .catch(() => {});
    }
  });

  it('A 成功 B 失败 → 该名下作品整名不动（B 的作品不得经 A 的 prune 轮被软删）', async () => {
    const events = await runScanRoots([
      { name: dualName, path: rootA },
      { name: dualName, path: rootB },
    ]);

    // 修复前（按名记录「成功」）：A 成功即让该名参与 prune，
    // idA 与 idB 都会被软删（removed=2）——B 的作品被误删即本回归要锁定的灾难
    expect(resultsOf(events)?.removed).toBe(0);
    expect((await rowOfById(idA))?.deletedAt).toBeNull();
    expect((await rowOfById(idB))?.deletedAt).toBeNull();

    // 失败仍可感知：error 日志含失败路径
    const errorLogs = events.filter(
      (e): e is { type: 'SCAN_LOG'; log: { message: string } } =>
        (e as { type: string }).type === 'SCAN_LOG' &&
        (e as { log?: { level?: string } }).log?.level === 'error',
    );
    expect(errorLogs.map((e) => e.log.message).join('\n')).toContain(rootB);
  });
});
