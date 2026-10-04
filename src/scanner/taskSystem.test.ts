import { describe, expect, test } from 'bun:test';
import { TaskQueue } from '../infra/taskQueue/index.js';
import type { TaskEvent } from './taskEvents.js';
import { TaskSystem } from './taskSystem.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

interface Harness {
  sys: TaskSystem;
  queue: TaskQueue;
  calls: string[];
  events: TaskEvent[];
}

function makeHarness(
  pools: Record<string, number> = { net: 1, cpu: 1 },
): Harness {
  const queue = new TaskQueue(pools, { ttlMs: 60_000, intervalMs: 30_000 });
  const sys = new TaskSystem(queue, { flushIntervalMs: 20 });
  const calls: string[] = [];
  const events: TaskEvent[] = [];
  sys.subscribe((e) => events.push(e));
  for (const phase of ['metadata', 'cover', 'track', 'analyze'] as const) {
    sys.registerExecutor(phase, (ctx) => {
      calls.push(`${phase}:${ctx.workId}`);
      return Promise.resolve({});
    });
  }
  return { sys, queue, calls, events };
}

describe('TaskSystem', () => {
  test('submit 构建流水线：key 命名与 deps 行为（metadata 挂住时 cover/track 不跑）', async () => {
    const h = makeHarness();
    try {
      const gate = deferred();
      h.sys.registerExecutor('metadata', () => {
        h.calls.push('metadata:RJ1');
        return gate.promise.then(() => ({}));
      });
      h.sys.startBatch('scan', 'b1');
      const report = h.sys.submit(
        ['RJ1'],
        ['metadata', 'cover', 'track', 'analyze'],
        {
          priority: 'low',
          batchId: 'b1',
        },
      );
      expect(report.accepted).toBe(4);
      expect(report.rejected).toEqual([]);
      await sleep(10);
      // metadata running 占住 net，cover/track 因 dep 未就绪不执行；analyze 无 dep、在 cpu 池独立执行
      expect(h.calls).toEqual(['metadata:RJ1', 'analyze:RJ1']);
      gate.resolve();
      await sleep(30);
      expect(h.calls).toEqual([
        'metadata:RJ1',
        'analyze:RJ1',
        'cover:RJ1',
        'track:RJ1',
      ]);
    } finally {
      h.queue.dispose();
    }
  });

  test('手动高优在队列中先于批量低优执行', async () => {
    const h = makeHarness();
    try {
      const gate = deferred();
      h.sys.registerExecutor('metadata', (ctx) =>
        ctx.workId === 'workA'
          ? gate.promise.then(() => ({}))
          : Promise.resolve({}),
      );
      h.sys.registerExecutor('track', (ctx) => {
        h.calls.push(`track:${ctx.workId}`);
        return Promise.resolve({});
      });
      h.sys.startBatch('scan', 'b');
      // 批量 low：workA 占住 net；workB track 排队
      h.sys.submit(['workA'], ['metadata'], { priority: 'low', batchId: 'b' });
      h.sys.submit(['workB'], ['track'], { priority: 'low', batchId: 'b' });
      await sleep(5);
      // 手动 high：workC track 插队
      h.sys.submit(['workC'], ['track'], { priority: 'high' });
      gate.resolve();
      await sleep(30);
      expect(h.calls.indexOf('track:workC')).toBeLessThan(
        h.calls.indexOf('track:workB'),
      );
    } finally {
      h.queue.dispose();
    }
  });

  test('cancelBatch 唤醒 barrier 且快照置 skipped', async () => {
    const h = makeHarness();
    try {
      const gate = deferred();
      h.sys.registerExecutor('metadata', () => gate.promise.then(() => ({})));
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1', 'RJ2'], ['metadata'], {
        priority: 'low',
        batchId: 'b1',
      });
      await sleep(5);
      const barrierPromise = h.sys.barrier('b1');
      h.sys.cancelBatch('b1');
      gate.resolve();
      const outcome = await barrierPromise;
      expect(outcome.cancelled).toBe(2);
      const snap = h.sys.snapshot();
      for (const p of snap.pipelines) {
        expect(p.phases.metadata?.status).toBe('skipped');
      }
    } finally {
      h.queue.dispose();
    }
  });

  test('快照即时权威：节流未 flush 时 snapshot 已是最新，flush 后 delta 才发出', async () => {
    const h = makeHarness({ net: 2, cpu: 2 });
    try {
      const gate = deferred();
      h.sys.registerExecutor('metadata', () => gate.promise.then(() => ({})));
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1'], ['metadata'], { priority: 'low', batchId: 'b1' });
      await sleep(5); // 进入 running，但 flush 间隔 20ms 未到
      const beforeDelta = h.events.filter((e) => e.type === 'TASK_DELTA');
      const snap = h.sys.snapshot();
      expect(snap.pipelines[0]?.phases.metadata?.status).toBe('running'); // 快照权威
      expect(beforeDelta).toHaveLength(0); // delta 还没发
      gate.resolve();
      await sleep(40);
      const afterDelta = h.events.filter((e) => e.type === 'TASK_DELTA');
      expect(afterDelta.length).toBeGreaterThan(0);
      const last = afterDelta.at(-1);
      if (last?.type !== 'TASK_DELTA') throw new Error('unreachable');
      const statuses = last.entries
        .filter((e) => e.workId === 'RJ1')
        .map((e) => e.status);
      expect(statuses).toContain('completed');
    } finally {
      h.queue.dispose();
    }
  });

  test('if-needed 跳过已完成阶段，force 重跑', async () => {
    const h = makeHarness();
    try {
      let count = 0;
      h.sys.registerExecutor('metadata', () => {
        count++;
        return Promise.resolve({ created: true });
      });
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1'], ['metadata'], { priority: 'low', batchId: 'b1' });
      await h.sys.barrier('b1');
      expect(count).toBe(1);
      // if-needed：已完成 → 跳过
      h.sys.submit(['RJ1'], ['metadata'], {
        priority: 'low',
        mode: 'if-needed',
      });
      await sleep(10);
      expect(count).toBe(1);
      // force：重跑
      h.sys.submit(['RJ1'], ['metadata'], { priority: 'high', mode: 'force' });
      await sleep(20);
      expect(count).toBe(2);
    } finally {
      h.queue.dispose();
    }
  });

  test('metadata 失败级联取消同批次 pending 阶段（fail-pipeline），流水线仍可收尾', async () => {
    const h = makeHarness();
    try {
      h.sys.registerExecutor('metadata', () =>
        Promise.reject(new Error('DLsite 429')),
      );
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1'], ['metadata', 'cover', 'track'], {
        priority: 'low',
        batchId: 'b1',
      });
      const outcome = await h.sys.barrier('b1');
      expect(outcome.failed).toBe(1);
      expect(outcome.cancelled).toBe(2);
      const snap = h.sys.snapshot();
      const pipeline = snap.pipelines.find((p) => p.workId === 'RJ1');
      expect(pipeline?.phases.metadata?.status).toBe('failed');
      expect(pipeline?.phases.metadata?.error).toBe('DLsite 429');
      expect(pipeline?.phases.cover?.status).toBe('skipped');
      expect(pipeline?.phases.track?.status).toBe('skipped');
    } finally {
      h.queue.dispose();
    }
  });

  test('cover/track 失败仅记 warning（warn-continue），不级联取消', async () => {
    const h = makeHarness({ net: 2, cpu: 2 });
    try {
      h.sys.registerExecutor('metadata', () => Promise.resolve({}));
      h.sys.registerExecutor('track', () =>
        Promise.reject(new Error('no tracks')),
      );
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1'], ['metadata', 'cover', 'track'], {
        priority: 'low',
        batchId: 'b1',
      });
      const outcome = await h.sys.barrier('b1');
      expect(outcome.failed).toBe(1);
      expect(outcome.cancelled).toBe(0);
      expect(outcome.completed).toBe(2);
      const snap = h.sys.snapshot();
      const pipeline = snap.pipelines.find((p) => p.workId === 'RJ1');
      expect(pipeline?.phases.track?.status).toBe('failed');
      expect(pipeline?.phases.cover?.status).toBe('completed');
    } finally {
      h.queue.dispose();
    }
  });

  test('executor 日志进入快照并经节流发出 BATCH_LOG（带时间戳与 workId）', async () => {
    const h = makeHarness();
    try {
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1'], ['metadata'], {
        priority: 'low',
        batchId: 'b1',
      });
      // 注册的默认 executor 不打日志；改用自定义验证 log 通道
      h.sys.registerExecutor('metadata', (ctx) => {
        ctx.log('info', `fetching ${ctx.workId}`);
        return Promise.resolve({});
      });
      h.sys.submit(['RJ2'], ['metadata'], { priority: 'low', batchId: 'b1' });
      await h.sys.barrier('b1');
      await sleep(40);
      const snap = h.sys.snapshot();
      const fetched = snap.logs.find((l) => l.message === 'fetching RJ2');
      expect(fetched?.level).toBe('info');
      expect(fetched?.workId).toBe('RJ2');
      expect(fetched?.timestamp).toBeTruthy();
      const logEvents = h.events.filter((e) => e.type === 'BATCH_LOG');
      expect(
        logEvents.some(
          (e) => e.type === 'BATCH_LOG' && e.log.message === 'fetching RJ2',
        ),
      ).toBe(true);
    } finally {
      h.queue.dispose();
    }
  });

  test('finishBatch 写入 results 并发出 BATCH_SUMMARY；batchResults 供编排器收尾', async () => {
    const h = makeHarness();
    try {
      h.sys.registerExecutor('metadata', () =>
        Promise.resolve({ created: true }),
      );
      h.sys.startBatch('scan', 'b1');
      h.sys.submit(['RJ1', 'RJ2'], ['metadata'], {
        priority: 'low',
        batchId: 'b1',
      });
      await h.sys.barrier('b1');
      const results = h.sys.batchResults('b1');
      expect(results.get('metadata:RJ1')).toEqual({ created: true });
      expect(results.get('metadata:RJ2')).toEqual({ created: true });
      const summary = {
        total: 2,
        added: 2,
        updated: 0,
        failed: 0,
        skipped: 0,
        removed: 0,
        purged: 0,
      };
      h.sys.finishBatch('b1', 'completed', summary);
      await sleep(0);
      const summaryEvents = h.events.filter((e) => e.type === 'BATCH_SUMMARY');
      expect(summaryEvents).toHaveLength(1);
      const ev = summaryEvents[0];
      if (ev?.type !== 'BATCH_SUMMARY') throw new Error('unreachable');
      expect(ev.batchId).toBe('b1');
      expect(ev.kind).toBe('scan');
      expect(ev.results).toEqual(summary);
      expect(ev.completedAt).toBeTruthy();
      const batch = h.sys.snapshot().batches.find((b) => b.batchId === 'b1');
      expect(batch?.status).toBe('completed');
      expect(batch?.results).toEqual(summary);
    } finally {
      h.queue.dispose();
    }
  });

  test('running 中的阶段被手动重复提交时返回 rejected', async () => {
    const h = makeHarness();
    try {
      const gate = deferred();
      h.sys.registerExecutor('metadata', () => gate.promise.then(() => ({})));
      h.sys.submit(['RJ1'], ['metadata'], { priority: 'high' });
      await sleep(5);
      const report = h.sys.submit(['RJ1'], ['metadata'], {
        priority: 'high',
        mode: 'force',
      });
      expect(report.rejected).toEqual([
        { workId: 'RJ1', phase: 'metadata', reason: 'running' },
      ]);
      gate.resolve();
      await sleep(10);
    } finally {
      h.queue.dispose();
    }
  });
});
