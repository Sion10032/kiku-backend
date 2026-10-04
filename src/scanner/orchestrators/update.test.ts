import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  test,
} from 'bun:test';
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
import { TaskSystem } from '../taskSystem.js';
import { acquireIdentity, releaseIdentity, SCAN_ALL_IDENTITY } from './scan.js';
import { runUpdateOrchestration } from './update.js';

setupTestEnvironment();

const config = getConfig();

interface CallRecord {
  phase: string;
  workId: string;
  force?: boolean;
}

interface Harness {
  sys: TaskSystem;
  queue: TaskQueue;
  calls: CallRecord[];
  failMetadataFor: string | null;
}

function makeHarness(): Harness {
  const queue = new TaskQueue(
    { net: 2, cpu: 2 },
    { ttlMs: 60_000, intervalMs: 30_000 },
  );
  const sys = new TaskSystem(queue, { flushIntervalMs: 20 });
  const calls: CallRecord[] = [];
  const h: Harness = { sys, queue, calls, failMetadataFor: null };
  sys.registerExecutor('metadata', (ctx) => {
    calls.push({ phase: 'metadata', workId: ctx.workId, force: ctx.force });
    if (h.failMetadataFor && ctx.workId.includes(h.failMetadataFor)) {
      return Promise.reject(new Error('DLsite 429'));
    }
    return Promise.resolve({ created: false }); // update 重抓已有作品 → updated
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

let seq = 200000;
function nextId(): string {
  seq += 11;
  return `RJ${seq}`;
}

async function seedWork(id: string): Promise<void> {
  const r = await upsertWork({
    id,
    title: `T ${id}`,
    circleName: 'C',
    rootFolder: 'updroot',
    dir: id,
  });
  if (!r.success) throw new Error(r.error ?? 'seed failed');
}

beforeAll(async () => {
  await ensureRootFolder('updroot', '/tmp/kiku-upd-orch');
});

afterAll(async () => {
  await db.delete(works);
  await removeRootFolder('updroot');
});

beforeEach(async () => {
  await db.delete(works);
});

describe('runUpdateOrchestration（update 编排器）', () => {
  test('全量 update：DLsite 作品注入三阶段（force），计数归 updated', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await seedWork(id);
      const summary = await runUpdateOrchestration(
        config,
        new AbortController().signal,
        undefined,
        {
          sys: h.sys,
        },
      );
      expect(summary).toEqual({
        total: 1,
        added: 0,
        updated: 1,
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
      expect(h.calls[0]?.force).toBe(true); // update 是显式重抓意图
    } finally {
      h.queue.dispose();
    }
  });

  test('manual 作品跳过：skipped 计数、零注入', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await seedWork(id);
      await db.update(works).set({ id: 'UW00000009' }).where(eq(works.id, id));
      const summary = await runUpdateOrchestration(
        config,
        new AbortController().signal,
        undefined,
        {
          sys: h.sys,
        },
      );
      expect(summary?.skipped).toBe(1);
      expect(summary?.total).toBe(1);
      expect(h.calls).toEqual([]);
    } finally {
      h.queue.dispose();
    }
  });

  test('workIds 子集：只注入指定作品', async () => {
    const h = makeHarness();
    try {
      const a = nextId();
      const b = nextId();
      await seedWork(a);
      await seedWork(b);
      const summary = await runUpdateOrchestration(
        config,
        new AbortController().signal,
        [a],
        {
          sys: h.sys,
        },
      );
      expect(summary?.total).toBe(1);
      expect(
        h.calls.filter((c) => c.phase === 'metadata').map((c) => c.workId),
      ).toEqual([a]);
    } finally {
      h.queue.dispose();
    }
  });

  test('与 scan 共用 scan:all 互斥：占用期间 update 返回 null', async () => {
    const h = makeHarness();
    try {
      expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true);
      const summary = await runUpdateOrchestration(
        config,
        new AbortController().signal,
        undefined,
        {
          sys: h.sys,
        },
      );
      expect(summary).toBeNull();
      releaseIdentity(SCAN_ALL_IDENTITY);
    } finally {
      h.queue.dispose();
    }
  });

  test('metadata 失败 → failed 计数进 SUMMARY', async () => {
    const h = makeHarness();
    try {
      const id = nextId();
      await seedWork(id);
      h.failMetadataFor = id;
      const summary = await runUpdateOrchestration(
        config,
        new AbortController().signal,
        undefined,
        {
          sys: h.sys,
        },
      );
      expect(summary?.failed).toBe(1);
      expect(summary?.updated).toBe(0);
    } finally {
      h.queue.dispose();
    }
  });

  test('abort：返回 null（批次 cancelled）', async () => {
    const h = makeHarness();
    try {
      const controller = new AbortController();
      controller.abort();
      const summary = await runUpdateOrchestration(
        config,
        controller.signal,
        undefined,
        {
          sys: h.sys,
        },
      );
      expect(summary).toBeNull();
      expect(acquireIdentity(SCAN_ALL_IDENTITY)).toBe(true); // 身份已释放
      releaseIdentity(SCAN_ALL_IDENTITY);
    } finally {
      h.queue.dispose();
    }
  });
});
