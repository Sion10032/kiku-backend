import { describe, expect, it } from 'bun:test';
import type { ScanEvent, ScanTaskPayload } from '../src/filesystem/scanner.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// bun test 转译器不支持 await import 解构内的 inline type 修饰符，
// 故类型改用静态 import type（擦除后不影响动态导入时序）
const { applyScanEvent, emptySnapshot, SCAN_LOG_CAP } = await import(
  '../src/filesystem/scanner.js'
);

const taskEv = (task: ScanTaskPayload): ScanEvent => ({
  type: 'SCAN_TASK',
  task,
});

describe('applyScanEvent 快照归约', () => {
  it('pending/scanning upsert 到非终态列表', () => {
    let snap = emptySnapshot();
    snap = applyScanEvent(
      snap,
      taskEv({ id: 1, title: 'A', status: 'pending' }),
    );
    snap = applyScanEvent(
      snap,
      taskEv({ id: 2, title: 'B', status: 'pending' }),
    );
    snap = applyScanEvent(
      snap,
      taskEv({ id: 1, title: 'A', status: 'scanning' }),
    );
    expect(snap.tasks.map((t) => t.id)).toEqual([2, 1]);
    expect(snap.tasks[0]?.status).toBe('pending');
    expect(snap.tasks[1]?.status).toBe('scanning');
  });

  it('completed：移出列表并计数；failed：移出列表进失败列表', () => {
    let snap = emptySnapshot();
    snap = applyScanEvent(
      snap,
      taskEv({ id: 1, title: 'A', status: 'scanning' }),
    );
    snap = applyScanEvent(
      snap,
      taskEv({ id: 1, title: 'A', status: 'completed' }),
    );
    expect(snap.tasks).toHaveLength(0);
    expect(snap.completed).toBe(1);

    snap = applyScanEvent(
      snap,
      taskEv({ id: 2, title: 'B', status: 'failed', error: 'x' }),
    );
    expect(snap.tasks).toHaveLength(0);
    expect(snap.failedTasks).toHaveLength(1);
    expect(snap.failedTasks[0]?.error).toBe('x');
  });

  it('SCAN_LOG 追加，超过 SCAN_LOG_CAP 截断保留最新', () => {
    let snap = emptySnapshot();
    for (let i = 0; i < SCAN_LOG_CAP + 2; i++) {
      snap = applyScanEvent(snap, {
        type: 'SCAN_LOG',
        log: { level: 'info', message: String(i), timestamp: '' },
      });
    }
    expect(snap.logs).toHaveLength(SCAN_LOG_CAP);
    expect(snap.logs[0]?.message).toBe('2');
    expect(snap.logs.at(-1)?.message).toBe(String(SCAN_LOG_CAP + 1));
  });

  it('其他事件原样返回快照', () => {
    const snap = emptySnapshot();
    expect(applyScanEvent(snap, { type: 'SCAN_FINISHED', message: 'x' })).toBe(
      snap,
    );
  });
});
