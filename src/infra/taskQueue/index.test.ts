import { describe, expect, test } from 'bun:test';
import { type CoreEvent, type CoreTask, TaskQueue } from './index.js';

const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

/** 可控完成/失败的 run 实现。 */
function deferredRun() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  const run = () => promise;
  return { run, resolve, reject };
}

/** 记录执行顺序的 run。 */
function trackedRun(order: string[], name: string) {
  return () => {
    order.push(name);
    return Promise.resolve();
  };
}

function taskOf(
  partial: Partial<CoreTask> & { key: string; run: CoreTask['run'] },
): CoreTask {
  return { resource: 'net', priority: 0, ...partial };
}

describe('TaskQueue', () => {
  test('running 同 key 二次 submit 被拒绝', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const a = deferredRun();
      q.submit(taskOf({ key: 'p:RJ1', run: a.run }));
      await sleep(0); // 让 a 进入 running
      expect(
        q.submit(taskOf({ key: 'p:RJ1', run: () => Promise.resolve() })),
      ).toBe('rejected-running');
      a.resolve();
      await sleep(0);
    } finally {
      q.dispose();
    }
  });

  test('pending 同 key 合并且优先级取高', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const order: string[] = [];
      const a = deferredRun();
      q.submit(taskOf({ key: 'a', run: a.run }));
      q.submit(
        taskOf({ key: 'k1', priority: 0, run: trackedRun(order, 'low') }),
      );
      expect(
        q.submit(
          taskOf({
            key: 'k2',
            priority: 0,
            run: trackedRun(order, 'merged-0'),
          }),
        ),
      ).toBe('accepted');
      // 同 key 升优合并：执行体取新、只跑一次、先于独立低优任务
      expect(
        q.submit(
          taskOf({
            key: 'k2',
            priority: 10,
            run: trackedRun(order, 'merged-10'),
          }),
        ),
      ).toBe('merged');
      a.resolve();
      await sleep(10);
      expect(order).toEqual(['merged-10', 'low']);
    } finally {
      q.dispose();
    }
  });

  test('同池内优先级保序（高先出）', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const order: string[] = [];
      const a = deferredRun();
      q.submit(taskOf({ key: 'a', run: a.run }));
      q.submit(taskOf({ key: 'c', priority: 0, run: trackedRun(order, 'c') }));
      q.submit(taskOf({ key: 'b', priority: 10, run: trackedRun(order, 'b') }));
      a.resolve();
      await sleep(10);
      expect(order).toEqual(['b', 'c']);
    } finally {
      q.dispose();
    }
  });

  test('net 池满不阻塞 cpu 池调度（无队头阻塞）', async () => {
    const q = new TaskQueue({ net: 1, cpu: 1 });
    try {
      const order: string[] = [];
      const netBusy = deferredRun();
      q.submit(taskOf({ key: 'net-busy', resource: 'net', run: netBusy.run }));
      q.submit(
        taskOf({
          key: 'cpu-job',
          resource: 'cpu',
          run: trackedRun(order, 'cpu'),
        }),
      );
      await sleep(10);
      expect(order).toEqual(['cpu']);
      netBusy.resolve();
      await sleep(0);
    } finally {
      q.dispose();
    }
  });

  test('deps 未完成时阻塞，完成后放行', async () => {
    const q = new TaskQueue({ net: 2 });
    try {
      const order: string[] = [];
      const a = deferredRun();
      q.submit(taskOf({ key: 'a', run: a.run }));
      q.submit(taskOf({ key: 'b', deps: ['a'], run: trackedRun(order, 'b') }));
      await sleep(5);
      expect(order).toEqual([]); // a running → b 阻塞
      a.resolve();
      await sleep(10);
      expect(order).toEqual(['b']);
    } finally {
      q.dispose();
    }
  });

  test('deps 查无记录视为已满足', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const order: string[] = [];
      q.submit(
        taskOf({
          key: 'b',
          deps: ['never-submitted'],
          run: trackedRun(order, 'b'),
        }),
      );
      await sleep(5);
      expect(order).toEqual(['b']);
    } finally {
      q.dispose();
    }
  });

  test('任务失败同样 resolve barrier', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const fail = () => Promise.reject(new Error('boom'));
      q.submit(taskOf({ key: 'a', batchId: 'x', run: fail }));
      const outcome = await q.barrier('x');
      expect(outcome).toEqual({
        total: 1,
        completed: 0,
        failed: 1,
        cancelled: 0,
      });
      expect(q.getState('a')).toBe('failed');
    } finally {
      q.dispose();
    }
  });

  test('批次不存在时 barrier 立即返回全零', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      expect(await q.barrier('nope')).toEqual({
        total: 0,
        completed: 0,
        failed: 0,
        cancelled: 0,
      });
    } finally {
      q.dispose();
    }
  });

  test('TTL 清理终态记录后同 key 可重新入队', async () => {
    const q = new TaskQueue({ net: 1 }, { ttlMs: 20, intervalMs: 5 });
    try {
      q.submit(taskOf({ key: 'a', run: () => Promise.resolve() }));
      await sleep(5);
      expect(q.getState('a')).toBe('completed');
      await sleep(60);
      expect(q.getState('a')).toBeUndefined();
      expect(q.submit(taskOf({ key: 'a', run: () => Promise.resolve() }))).toBe(
        'accepted',
      );
      await sleep(5);
      expect(q.getState('a')).toBe('completed');
    } finally {
      q.dispose();
    }
  });

  test('cancelBatch 移除 pending、abort running', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const order: string[] = [];
      const a = deferredRun();
      let aborted = false;
      q.submit(
        taskOf({
          key: 'a',
          batchId: 'batch',
          run: (signal) => {
            signal.addEventListener('abort', () => {
              aborted = true;
            });
            return a.run();
          },
        }),
      );
      q.submit(
        taskOf({ key: 'b', batchId: 'batch', run: trackedRun(order, 'b') }),
      );
      await sleep(0);
      q.cancelBatch('batch');
      a.resolve();
      const outcome = await q.barrier('batch');
      expect(aborted).toBe(true);
      expect(order).toEqual([]); // b 从未执行
      expect(outcome).toEqual({
        total: 2,
        completed: 0,
        failed: 0,
        cancelled: 2,
      });
      expect(q.getState('a')).toBe('cancelled');
      expect(q.getState('b')).toBe('cancelled');
    } finally {
      q.dispose();
    }
  });

  test('onEvent 反映生命周期 pending→running→completed 与组计数', async () => {
    const q = new TaskQueue({ net: 1 });
    try {
      const events: CoreEvent[] = [];
      q.onEvent((e) => events.push(e));
      q.submit(
        taskOf({ key: 'a', batchId: 'g', run: () => Promise.resolve() }),
      );
      await sleep(10);
      const taskEvents = events.filter(
        (e) => e.type === 'task' && e.key === 'a',
      );
      expect(
        taskEvents.map((e) => (e.type === 'task' ? e.status : '')),
      ).toEqual(['pending', 'running', 'completed']);
      const lastCount = [...events]
        .reverse()
        .find((e) => e.type === 'batch-count');
      expect(lastCount).toEqual({
        type: 'batch-count',
        batchId: 'g',
        total: 1,
        running: 0,
        completed: 1,
        failed: 0,
      });
    } finally {
      q.dispose();
    }
  });
});
