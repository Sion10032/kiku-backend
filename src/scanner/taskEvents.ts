// 统一任务事件协议与快照 reducer（spec §7）。
// 全部事件强制带时间戳：日志 timestamp、阶段变化 changedAt、批次 createdAt/completedAt。
// reducer 为纯函数：服务端装配层与前端 store 各自持有 TaskSnapshot，用同一套归并语义。

export type Phase = 'metadata' | 'cover' | 'track' | 'analyze';
export type PhaseStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'skipped';
export type BatchKind = 'scan' | 'update' | 'analysis';

export interface PhaseEntry {
  workId: string;
  phase: Phase;
  status: PhaseStatus;
  error?: string;
  batchId?: string;
  /** ISO 时间戳，全部事件强制带。 */
  changedAt: string;
}

export interface BatchCounters {
  batchId: string;
  kind: BatchKind;
  total: number;
  running: number;
  completed: number;
  failed: number;
}

export type BatchStatus = 'running' | 'completed' | 'cancelled' | 'failed';

export interface BatchInfo {
  batchId: string;
  kind: BatchKind;
  createdAt: string;
  counters: BatchCounters;
  status: BatchStatus;
  completedAt?: string;
  /** 批次收尾汇总（服务端直出），随 BATCH_SUMMARY 写入，重连补播可还原。 */
  results?: ScanSummaryResults | AnalysisSummaryResults;
  /**
   * 终态固化：收尾时该批次实际处理过的作品名单（去重）。
   * 活流水线按 workId 全局唯一、后续批次重跑会改写 phases[].batchId，
   * 历史批次卡靠这份名单渲染条目，归属不随新批次漂移。
   */
  workIds?: string[];
}

export interface BatchLog {
  level: string;
  message: string;
  timestamp: string;
  batchId?: string;
  workId?: string;
}

export interface WorkPipelineState {
  workId: string;
  phases: Partial<Record<Phase, PhaseEntry>>;
  updatedAt: string;
}

export interface TaskSnapshot {
  batches: BatchInfo[];
  pipelines: WorkPipelineState[];
  logs: BatchLog[];
}

export interface ScanSummaryResults {
  total: number;
  added: number;
  updated: number;
  failed: number;
  skipped: number;
  removed: number;
  purged: number;
}

export interface AnalysisSummaryResults {
  totalWorks: number;
  analyzedTracks: number;
  failedTracks: number;
  failedWorks: number;
}

export type TaskEvent =
  | { type: 'TASK_SNAPSHOT'; snapshot: TaskSnapshot }
  | { type: 'TASK_DELTA'; entries: PhaseEntry[]; counters: BatchCounters[] }
  | {
      type: 'BATCH_SUMMARY';
      batchId: string;
      kind: BatchKind;
      results: ScanSummaryResults | AnalysisSummaryResults;
      completedAt: string;
    }
  | { type: 'BATCH_LOG'; log: BatchLog };

export const LOG_CAP = 500;

export function emptyTaskSnapshot(): TaskSnapshot {
  return { batches: [], pipelines: [], logs: [] };
}

function upsertPipeline(state: TaskSnapshot, e: PhaseEntry): TaskSnapshot {
  const idx = state.pipelines.findIndex((p) => p.workId === e.workId);
  const pipelines = [...state.pipelines];
  if (idx < 0) {
    pipelines.push({
      workId: e.workId,
      phases: { [e.phase]: e },
      updatedAt: e.changedAt,
    });
  } else {
    const prev = pipelines[idx];
    if (!prev) return state;
    pipelines[idx] = {
      ...prev,
      phases: { ...prev.phases, [e.phase]: e },
      updatedAt: e.changedAt,
    };
  }
  return { ...state, pipelines };
}

function upsertBatch(
  state: TaskSnapshot,
  counters: BatchCounters,
): TaskSnapshot {
  const idx = state.batches.findIndex((b) => b.batchId === counters.batchId);
  const batches = [...state.batches];
  if (idx < 0) {
    // 防御性创建（正常流程 startBatch 先于任何 delta）
    batches.push({
      batchId: counters.batchId,
      kind: counters.kind,
      createdAt: '',
      counters,
      status: 'running',
    });
  } else {
    const prev = batches[idx];
    if (!prev) return state;
    batches[idx] = { ...prev, counters };
  }
  return { ...state, batches };
}

function markBatchCompleted(
  state: TaskSnapshot,
  batchId: string,
  kind: BatchKind,
  results: ScanSummaryResults | AnalysisSummaryResults,
  completedAt: string,
): TaskSnapshot {
  const idx = state.batches.findIndex((b) => b.batchId === batchId);
  const batches = [...state.batches];
  if (idx < 0) {
    batches.push({
      batchId,
      kind,
      createdAt: '',
      counters: {
        batchId,
        kind,
        total: 0,
        running: 0,
        completed: 0,
        failed: 0,
      },
      status: 'completed',
      completedAt,
      results,
    });
  } else {
    const prev = batches[idx];
    if (!prev) return state;
    batches[idx] = { ...prev, status: 'completed', completedAt, results };
  }
  return { ...state, batches };
}

export function applyTaskEvent(
  snapshot: TaskSnapshot,
  event: TaskEvent,
): TaskSnapshot {
  switch (event.type) {
    case 'TASK_SNAPSHOT':
      return event.snapshot;
    case 'TASK_DELTA': {
      let s = snapshot;
      for (const e of event.entries) s = upsertPipeline(s, e);
      for (const c of event.counters) s = upsertBatch(s, c);
      return s;
    }
    case 'BATCH_SUMMARY':
      return markBatchCompleted(
        snapshot,
        event.batchId,
        event.kind,
        event.results,
        event.completedAt,
      );
    case 'BATCH_LOG': {
      const logs = [...snapshot.logs, event.log];
      return {
        ...snapshot,
        logs: logs.length > LOG_CAP ? logs.slice(logs.length - LOG_CAP) : logs,
      };
    }
  }
}
