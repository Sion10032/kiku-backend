import { describe, expect, test } from 'bun:test';
import {
  applyTaskEvent,
  type BatchLog,
  emptyTaskSnapshot,
  type PhaseEntry,
  type TaskSnapshot,
} from './taskEvents.js';

function entry(
  partial: Partial<PhaseEntry> & { workId: string; phase: PhaseEntry['phase'] },
): PhaseEntry {
  return {
    status: 'running',
    changedAt: '2026-10-04T00:00:00.000Z',
    ...partial,
  };
}

function log(n: number): BatchLog {
  return {
    level: 'info',
    message: `log-${n}`,
    timestamp: '2026-10-04T00:00:00.000Z',
  };
}

describe('applyTaskEvent', () => {
  test('TASK_DELTA 按 workId+phase upsert 流水线状态', () => {
    let s: TaskSnapshot = emptyTaskSnapshot();
    s = applyTaskEvent(s, {
      type: 'TASK_DELTA',
      entries: [entry({ workId: 'RJ1', phase: 'metadata' })],
      counters: [
        {
          batchId: 'b1',
          kind: 'scan',
          total: 1,
          running: 1,
          completed: 0,
          failed: 0,
        },
      ],
    });
    expect(s.pipelines).toHaveLength(1);
    expect(s.pipelines[0]?.phases.metadata?.status).toBe('running');

    s = applyTaskEvent(s, {
      type: 'TASK_DELTA',
      entries: [
        entry({ workId: 'RJ1', phase: 'metadata', status: 'completed' }),
      ],
      counters: [
        {
          batchId: 'b1',
          kind: 'scan',
          total: 1,
          running: 0,
          completed: 1,
          failed: 0,
        },
      ],
    });
    expect(s.pipelines).toHaveLength(1); // 同一作品同阶段是更新不是新增
    expect(s.pipelines[0]?.phases.metadata?.status).toBe('completed');
    expect(s.pipelines[0]?.phases.cover).toBeUndefined(); // 其他阶段不受影响

    // 另一阶段追加到同一作品流水线
    s = applyTaskEvent(s, {
      type: 'TASK_DELTA',
      entries: [entry({ workId: 'RJ1', phase: 'track', status: 'pending' })],
      counters: [],
    });
    expect(s.pipelines).toHaveLength(1);
    expect(s.pipelines[0]?.phases.track?.status).toBe('pending');
  });

  test('TASK_DELTA 的 counters 防御性创建未知批次', () => {
    const s = applyTaskEvent(emptyTaskSnapshot(), {
      type: 'TASK_DELTA',
      entries: [],
      counters: [
        {
          batchId: 'bx',
          kind: 'analysis',
          total: 3,
          running: 2,
          completed: 1,
          failed: 0,
        },
      ],
    });
    expect(s.batches).toHaveLength(1);
    expect(s.batches[0]?.batchId).toBe('bx');
    expect(s.batches[0]?.kind).toBe('analysis');
    expect(s.batches[0]?.status).toBe('running');
    expect(s.batches[0]?.counters.completed).toBe(1);
  });

  test('BATCH_LOG 追加且封顶 500 条', () => {
    let s: TaskSnapshot = emptyTaskSnapshot();
    for (let n = 0; n < 505; n++) {
      s = applyTaskEvent(s, { type: 'BATCH_LOG', log: log(n) });
    }
    expect(s.logs).toHaveLength(500);
    expect(s.logs[0]?.message).toBe('log-5'); // 最旧的 5 条被丢弃
    expect(s.logs.at(-1)?.message).toBe('log-504');
  });

  test('BATCH_SUMMARY 将批次标记 completed 并写入 results', () => {
    let s: TaskSnapshot = emptyTaskSnapshot();
    s = applyTaskEvent(s, {
      type: 'TASK_DELTA',
      entries: [],
      counters: [
        {
          batchId: 'b1',
          kind: 'scan',
          total: 10,
          running: 2,
          completed: 8,
          failed: 0,
        },
      ],
    });
    s = applyTaskEvent(s, {
      type: 'BATCH_SUMMARY',
      batchId: 'b1',
      kind: 'scan',
      results: {
        total: 10,
        added: 3,
        updated: 5,
        failed: 0,
        skipped: 2,
        removed: 1,
        purged: 0,
      },
      completedAt: '2026-10-04T01:00:00.000Z',
      workIds: ['RJ1', 'RJ2'],
    });
    const batch = s.batches.find((b) => b.batchId === 'b1');
    expect(batch?.status).toBe('completed');
    expect(batch?.completedAt).toBe('2026-10-04T01:00:00.000Z');
    expect(batch?.workIds).toEqual(['RJ1', 'RJ2']);
    expect(batch?.results).toEqual({
      total: 10,
      added: 3,
      updated: 5,
      failed: 0,
      skipped: 2,
      removed: 1,
      purged: 0,
    });
  });

  test('TASK_SNAPSHOT 整体替换快照', () => {
    const replaced: TaskSnapshot = {
      batches: [],
      pipelines: [
        { workId: 'RJ9', phases: {}, updatedAt: '2026-10-04T02:00:00.000Z' },
      ],
      logs: [log(1)],
    };
    const s = applyTaskEvent(emptyTaskSnapshot(), {
      type: 'TASK_SNAPSHOT',
      snapshot: replaced,
    });
    expect(s).toEqual(replaced);
  });
});
