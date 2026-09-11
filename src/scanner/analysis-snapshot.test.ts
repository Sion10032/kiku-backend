import { describe, expect, it } from 'bun:test';
import {
  applyAnalysisEvent,
  emptyAnalysisSnapshot,
  SCAN_LOG_CAP,
} from './analysis.js';

describe('applyAnalysisEvent', () => {
  it('completed 任务移出活跃列表并计数', () => {
    let s = emptyAnalysisSnapshot();
    s = applyAnalysisEvent(s, {
      type: 'ANALYSIS_TASK',
      task: {
        workId: 'RJ1',
        title: 'T',
        status: 'scanning',
        analyzed: 0,
        total: 2,
      },
    });
    s = applyAnalysisEvent(s, {
      type: 'ANALYSIS_TASK',
      task: {
        workId: 'RJ1',
        title: 'T',
        status: 'completed',
        analyzed: 2,
        total: 2,
      },
    });
    expect(s.tasks).toEqual([]);
    expect(s.completed).toBe(1);
  });

  it('failed 任务进 failedTasks；日志封顶 SCAN_LOG_CAP', () => {
    let s = emptyAnalysisSnapshot();
    s = applyAnalysisEvent(s, {
      type: 'ANALYSIS_TASK',
      task: {
        workId: 'RJ1',
        title: 'T',
        status: 'failed',
        analyzed: 0,
        total: 1,
        error: 'x',
      },
    });
    expect(s.failedTasks).toHaveLength(1);
    for (let i = 0; i < SCAN_LOG_CAP + 10; i++) {
      s = applyAnalysisEvent(s, {
        type: 'ANALYSIS_LOG',
        log: { level: 'info', message: String(i), timestamp: '' },
      });
    }
    expect(s.logs).toHaveLength(SCAN_LOG_CAP);
  });

  it('scanning 进度更新原任务（按 workId upsert）', () => {
    let s = emptyAnalysisSnapshot();
    s = applyAnalysisEvent(s, {
      type: 'ANALYSIS_TASK',
      task: {
        workId: 'RJ1',
        title: 'T',
        status: 'scanning',
        analyzed: 1,
        total: 3,
      },
    });
    s = applyAnalysisEvent(s, {
      type: 'ANALYSIS_TASK',
      task: {
        workId: 'RJ1',
        title: 'T',
        status: 'scanning',
        analyzed: 2,
        total: 3,
      },
    });
    expect(s.tasks[0]?.analyzed).toBe(2);
  });
});
