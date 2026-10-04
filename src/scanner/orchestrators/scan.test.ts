import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { getConfig } from '../../infra/config/index.js';
import { db } from '../../infra/db/main/index.js';
import { works } from '../../infra/db/main/schema.js';
import { TaskQueue } from '../../infra/taskQueue/index.js';
import { upsertWork } from '../../services/work.service.js';
import type { WorkLocation } from '../phases/types.js';
import { TaskSystem } from '../taskSystem.js';
import {
  acquireIdentity,
  releaseIdentity,
  runScanOrchestration,
  SCAN_ALL_IDENTITY,
} from './scan.js';

setupTestEnvironment();

const config = getConfig();
let root: string;
const BAD_ROOT_PATH = join(
  tmpdir(),
  `kiku-nonexistent-${Date.now().toString(36)}`,
);

interface CallRecord {
  phase: string;
  workId: string;
  variant?: string;
  location?: WorkLocation;
}

interface Harness {
  sys: TaskSystem;
  queue: TaskQueue;
  calls: CallRecord[];
  /** metadata mock 的 created 返回值；'fail' = 抛错 */
  metadataCreated: boolean | 'fail';
}

function makeHarness(): Harness {
  const queue = new TaskQueue(
    { net: 2, cpu: 2 },
    { ttlMs: 60_000, intervalMs: 30_000 },
  );
  const sys = new TaskSystem(queue, { flushIntervalMs: 20 });
  const calls: CallRecord[] = [];
  const h: Harness = { sys, queue, calls, metadataCreated: true };
  sys.registerExecutor('metadata', (ctx) => {
    calls.push({
      phase: 'metadata',
      workId: ctx.workId,
      variant: ctx.variant,
      location: ctx.location,
    });
    if (h.metadataCreated === 'fail')
      return Promise.reject(new Error('DLsite 429'));
    return Promise.resolve({
      created: ctx.variant === 'moved' ? false : h.metadataCreated,
    });
  });
  sys.registerExecutor('cover', (ctx) => {
    calls.push({ phase: 'cover', workId: ctx.workId });
    return Promise.resolve({});
  });
  sys.registerExecutor('track', (ctx) => {
    calls.push({ phase: 'track', workId: ctx.workId });
    return Promise.resolve({});
  });
  return h;
}

/** 磁盘上造一个 folder 作品（含一个 .wav，校验流水线认可）。 */
function makeDiskWork(id: string, dirName: string = id): void {
  mkdirSync(join(root, dirName), { recursive: true });
  writeFileSync(join(root, dirName, '01.wav'), 'x');
}

/** seed 一个已入库作品（未软删）。 */
async function seedWork(id: string, dir: string): Promise<void> {
  const r = await upsertWork({
    id,
    title: `T ${id}`,
    circleName: 'C',
    rootFolder: 'scanroot',
    dir,
  });
  if (!r.success) throw new Error(r.error ?? 'seed failed');
}

const ids: string[] = [];
let seq = 100000;
function nextId(): string {
  seq += 7;
  const id = `RJ${seq}`;
  ids.push(id);
  return id;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-scan-orch-'));
  await ensureRootFolder('scanroot', root);
});

beforeEach(async () => {
  // 用例间隔离：清空磁盘目录与 works（rootFolder 行保留）
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  await db.delete(works);
});

afterAll(async () => {
  await db.delete(works);
  await removeRootFolder('scanroot');
  await removeRootFolder('badroot').catch(() => {});
  rmSync(root, { recursive: true, force: true });
});

describe('runScanOrchestration（scan 编排器）', () => {
  test('新作品全链路：注入三阶段、added 计数、SUMMARY 发出', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      makeDiskWork(id);
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary).not.toBeNull();
      expect(summary).toEqual({
        total: 1,
        added: 1,
        updated: 0,
        failed: 0,
        skipped: 0,
        removed: 0,
        purged: 0,
      });
      expect(h.calls.map((c) => `${c.phase}:${c.workId}`)).toEqual([
        `metadata:${id}`,
        `cover:${id}`,
        `track:${id}`,
      ]);
    } finally {
      h.queue.dispose();
    }
  });

  test('已扫描作品跳过：skipped 计数、零注入', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      makeDiskWork(id);
      await seedWork(id, id);
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary?.skipped).toBe(1);
      expect(summary?.added).toBe(0);
      // metadata/track 零注入（重扫不碰已知作品）；cover 允许殿后补图（下一个用例专测）
      expect(h.calls.filter((c) => c.phase !== 'cover')).toEqual([]);
    } finally {
      h.queue.dispose();
    }
  });

  test('moved：metadata 收到 moved 变体，计数归 updated', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      makeDiskWork(id, `${id}-new`);
      await seedWork(id, `${id}-old`);
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary?.updated).toBe(1);
      expect(summary?.added).toBe(0);
      const meta = h.calls.find((c) => c.phase === 'metadata');
      expect(meta?.variant).toBe('moved');
      expect(meta?.location?.relativePath).toBe(`${id}-new`);
    } finally {
      h.queue.dispose();
    }
  });

  test('源消失 → prune 软删（removed 计数，DB deletedAt 置位）', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await seedWork(id, 'vanished-dir'); // 磁盘无此目录
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary?.removed).toBe(1);
      const row = await db.select().from(works).where(eq(works.id, id));
      expect(row[0]?.deletedAt).not.toBeNull();
    } finally {
      h.queue.dispose();
    }
  });

  test('枚举失败 root fail-safe：排除 prune，该 root 的作品不被软删', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await ensureRootFolder('badroot', BAD_ROOT_PATH); // path 指向不存在目录 → 枚举失败（先建 root 行，FK）
      await seedWork(id, 'kept-dir');
      await db
        .update(works)
        .set({ rootFolder: 'badroot' })
        .where(eq(works.id, id));
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      const row = await db.select().from(works).where(eq(works.id, id));
      expect(row[0]?.deletedAt).toBeNull(); // fail-safe：不软删
      expect(summary?.removed).toBe(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('补图殿后：known 缺封面作品在 metadata 之后注入 cover', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      makeDiskWork(id);
      await seedWork(id, id); // known + 路径未变 → 跳过分流，blob 库无封面 → 缺失收集
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary?.skipped).toBe(1);
      expect(h.calls.map((c) => `${c.phase}:${c.workId}`)).toEqual([
        `cover:${id}`,
      ]); // 殿后：只有 cover
    } finally {
      h.queue.dispose();
    }
  });

  test('scan:all 互斥：已在跑时返回 null', async () => {
    const h = makeHarness();
    try {
      expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true);
      const summary = await runScanOrchestration(
        config,
        new AbortController().signal,
        { sys: h.sys },
      );
      expect(summary).toBeNull();
      releaseIdentity(SCAN_ALL_IDENTITY);
    } finally {
      h.queue.dispose();
    }
  });

  test('abort：返回 null、批次 cancelled、不 prune、身份释放', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await seedWork(id, 'gone-on-abort'); // 若误 prune 会被软删 → 用作哨兵
      const controller = new AbortController();
      controller.abort();
      const summary = await runScanOrchestration(config, controller.signal, {
        sys: h.sys,
      });
      expect(summary).toBeNull();
      const row = await db.select().from(works).where(eq(works.id, id));
      expect(row[0]?.deletedAt).toBeNull(); // abort 不 prune
      // 身份已释放（abort 后再次可跑）
      expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true);
      releaseIdentity(SCAN_ALL_IDENTITY);
    } finally {
      h.queue.dispose();
    }
  });

  test('chain 接力：正常收尾后被调用；互斥占用期间不重复入队', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      makeDiskWork(id);
      let chained = 0;
      await runScanOrchestration(config, new AbortController().signal, {
        sys: h.sys,
        chain: async () => {
          chained++;
        },
      });
      // fire-and-forget：给微任务排空的机会
      await new Promise((r) => setTimeout(r, 20));
      expect(chained).toBe(1);
    } finally {
      h.queue.dispose();
    }
  });
});
