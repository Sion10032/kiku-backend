// 任务系统装配层：把业务语义（workId/阶段 DAG/两池/合并策略/快照协议）装配到通用调度内核上。
// 阶段以 `${phase}:${workId}` 为 key；依赖：cover/track → metadata（队列级），analyze → track
// 由编排器 barrier 时序保证（track warn-continue 失败后 analyze 仍需接力，见行为对齐表）。
// 服务端快照为权威状态：submit/状态变化立即写入快照，TASK_DELTA/BATCH_LOG 经 250ms 节流合并发出。

import {
  type BatchOutcome,
  type CoreEvent,
  type CoreStatus,
  TaskQueue,
} from '../infra/taskQueue/index.js';
import {
  type AnalysisSummaryResults,
  applyTaskEvent,
  type BatchCounters,
  type BatchInfo,
  type BatchKind,
  type BatchLog,
  emptyTaskSnapshot,
  LOG_CAP,
  type Phase,
  type PhaseEntry,
  type PhaseStatus,
  type ScanSummaryResults,
  type TaskEvent,
  type TaskSnapshot,
} from './taskEvents.js';

export type PhaseResult = {
  created?: boolean;
  title?: string;
  detail?: { analyzed?: number; failed?: number };
};

/** scan 分流的物理位置（路径信息随 submit 传入，不入队列身份）。 */
export interface WorkLocation {
  rootFolder: string;
  relativePath: string;
  /** manual 分支标题推导用目录名。 */
  dirName?: string;
  /** manual 分支本地封面导入用绝对路径。 */
  absDir?: string;
}

export interface PhaseContext {
  workId: string;
  /** 仅 metadata 阶段有值：scan 分流的 moved 变体。 */
  variant: 'dlsite' | 'manual' | 'moved' | undefined;
  /** scan 分流的物理位置（metadata 阶段必需）。 */
  location: WorkLocation | undefined;
  signal: AbortSignal;
  log: (level: string, message: string) => void;
  force: boolean;
}

export type PhaseExecutor = (ctx: PhaseContext) => Promise<PhaseResult>;

interface PhaseConfig {
  resource: 'net' | 'cpu';
  failurePolicy: 'fail-pipeline' | 'warn-continue';
  deps: Phase[];
}

const PHASE_ORDER: readonly Phase[] = [
  'metadata',
  'cover',
  'track',
  'analyze',
] as const;

const PHASE_CONFIG: Record<Phase, PhaseConfig> = {
  metadata: { resource: 'net', failurePolicy: 'fail-pipeline', deps: [] },
  cover: {
    resource: 'net',
    failurePolicy: 'warn-continue',
    deps: ['metadata'],
  },
  track: {
    resource: 'net',
    failurePolicy: 'warn-continue',
    deps: ['metadata'],
  },
  // analyze 不设队列级 dep：track 属 warn-continue，失败不得阻断分析接力
  analyze: { resource: 'cpu', failurePolicy: 'fail-pipeline', deps: [] },
};

const PRIORITY_VALUE = { low: 0, high: 10 } as const;

export interface SubmitOptions {
  priority: 'low' | 'high';
  batchId?: string;
  mode?: 'if-needed' | 'force';
  /** workId → metadata 变体（scan 分流的 moved）。 */
  variants?: Record<string, 'moved'>;
  /** workId → 物理位置（metadata 阶段必需）。 */
  locations?: Record<string, WorkLocation>;
}

export interface SubmitReport {
  accepted: number;
  merged: number;
  rejected: Array<{ workId: string; phase: Phase; reason: 'running' }>;
}

export type FinishStatus = 'completed' | 'cancelled' | 'failed';

export interface TaskSystemOptions {
  /** TASK_DELTA/BATCH_LOG 节流窗口。默认 250ms。 */
  flushIntervalMs?: number;
}

export class TaskSystem {
  private readonly queue: TaskQueue;
  private readonly executors = new Map<Phase, PhaseExecutor>();
  private readonly listeners = new Set<(e: TaskEvent) => void>();
  private state: TaskSnapshot = emptyTaskSnapshot();
  private readonly dirtyEntries = new Map<string, PhaseEntry>();
  private readonly dirtyCounters = new Map<string, BatchCounters>();
  private readonly pendingLogs: BatchLog[] = [];
  private readonly keyBatches = new Map<string, string>();
  private readonly keyVariants = new Map<string, 'moved'>();
  private readonly keyLocations = new Map<string, WorkLocation>();
  private readonly resultsByBatch = new Map<string, Map<string, PhaseResult>>();
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushIntervalMs: number;

  constructor(queue: TaskQueue, options: TaskSystemOptions = {}) {
    this.queue = queue;
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
    queue.onEvent((e) => this.onQueueEvent(e));
  }

  registerExecutor(phase: Phase, exec: PhaseExecutor): void {
    this.executors.set(phase, exec);
  }

  /** 建批次卡片并发初始 counters。须先于该批次的 submit 调用。 */
  startBatch(kind: BatchKind, batchId: string): void {
    const counters: BatchCounters = {
      batchId,
      kind,
      total: 0,
      running: 0,
      completed: 0,
      failed: 0,
    };
    const batch: BatchInfo = {
      batchId,
      kind,
      createdAt: nowIso(),
      counters,
      status: 'running',
    };
    this.state = applyTaskEvent(this.state, {
      type: 'TASK_DELTA',
      entries: [],
      counters: [counters],
    });
    // applyTaskEvent 的防御性创建不含 createdAt/status 语义，这里用完整批次对象覆盖
    const idx = this.state.batches.findIndex((b) => b.batchId === batchId);
    const batches = [...this.state.batches];
    if (idx >= 0) batches[idx] = batch;
    this.state = { ...this.state, batches };
    this.markDirty();
  }

  submit(
    workIds: string[],
    phases: Phase[],
    opts: SubmitOptions,
  ): SubmitReport {
    const report: SubmitReport = { accepted: 0, merged: 0, rejected: [] };
    const mode = opts.mode ?? 'if-needed';
    const ordered = PHASE_ORDER.filter((p) => phases.includes(p));
    for (const workId of workIds) {
      for (const phase of ordered) {
        const key = taskKey(phase, workId);
        if (mode === 'if-needed' && this.queue.getState(key) === 'completed')
          continue;
        if (phase === 'metadata' && opts.variants?.[workId]) {
          this.keyVariants.set(key, opts.variants[workId]);
        }
        if (phase === 'metadata' && opts.locations?.[workId]) {
          this.keyLocations.set(key, opts.locations[workId]);
        }
        if (opts.batchId) this.keyBatches.set(key, opts.batchId);
        const outcome = this.queue.submit({
          key,
          resource: PHASE_CONFIG[phase].resource,
          priority: PRIORITY_VALUE[opts.priority],
          deps: PHASE_CONFIG[phase].deps.map((d) => taskKey(d, workId)),
          batchId: opts.batchId,
          run: async (signal) => {
            await this.runPhase(
              phase,
              workId,
              key,
              opts.batchId,
              mode === 'force',
              signal,
            );
          },
        });
        if (outcome === 'rejected-running') {
          report.rejected.push({ workId, phase, reason: 'running' });
        } else if (outcome === 'merged') {
          report.merged++;
        } else {
          report.accepted++;
        }
      }
    }
    return report;
  }

  barrier(batchId: string): Promise<BatchOutcome> {
    return this.queue.barrier(batchId);
  }

  /**
   * 收尾批次：写 status/completedAt/results（快照），completed 时发 BATCH_SUMMARY。
   * 编排器顺序：barrier → batchResults() → finishBatch(summary)。
   */
  finishBatch(
    batchId: string,
    status: FinishStatus,
    results?: ScanSummaryResults | AnalysisSummaryResults,
  ): void {
    const idx = this.state.batches.findIndex((b) => b.batchId === batchId);
    if (idx < 0) return;
    const prev = this.state.batches[idx];
    if (!prev) return;
    const completedAt = nowIso();
    const updated: BatchInfo = {
      ...prev,
      status,
      completedAt,
      ...(results ? { results } : {}),
    };
    const batches = [...this.state.batches];
    batches[idx] = updated;
    this.state = { ...this.state, batches };
    if (status === 'completed' && results) {
      this.emitEvent({
        type: 'BATCH_SUMMARY',
        batchId,
        kind: prev.kind,
        results,
        completedAt,
      });
    }
    for (const [key, b] of this.keyBatches) {
      if (b === batchId) this.keyBatches.delete(key);
    }
    this.resultsByBatch.delete(batchId);
  }

  /** 批次内各任务的阶段结果（key = `${phase}:${workId}`）。须在 finishBatch 之前取。 */
  batchResults(batchId: string): Map<string, PhaseResult> {
    return this.resultsByBatch.get(batchId) ?? new Map<string, PhaseResult>();
  }

  cancelBatch(batchId: string): void {
    this.queue.cancelBatch(batchId);
  }

  cancelWork(workId: string): void {
    for (const phase of PHASE_ORDER) this.queue.cancel(taskKey(phase, workId));
  }

  /** 权威快照（含节流窗口内未发出的状态）。 */
  snapshot(): TaskSnapshot {
    return {
      batches: [...this.state.batches],
      pipelines: [...this.state.pipelines],
      logs: [...this.state.logs],
    };
  }

  subscribe(cb: (e: TaskEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.listeners.clear();
  }

  // ---------- 内部 ----------

  private async runPhase(
    phase: Phase,
    workId: string,
    key: string,
    batchId: string | undefined,
    force: boolean,
    signal: AbortSignal,
  ): Promise<PhaseResult> {
    const exec = this.executors.get(phase);
    if (!exec) throw new Error(`no executor registered for phase ${phase}`);
    const variant =
      phase === 'metadata' ? this.keyVariants.get(key) : undefined;
    this.keyVariants.delete(key);
    const location =
      phase === 'metadata' ? this.keyLocations.get(key) : undefined;
    this.keyLocations.delete(key);
    const result = await exec({
      workId,
      variant,
      location,
      signal,
      log: (level, message) => this.addLog(level, message, batchId, workId),
      force,
    });
    if (batchId) {
      let results = this.resultsByBatch.get(batchId);
      if (!results) {
        results = new Map<string, PhaseResult>();
        this.resultsByBatch.set(batchId, results);
      }
      results.set(key, result);
    }
    return result;
  }

  private onQueueEvent(e: CoreEvent): void {
    if (e.type === 'batch-count') {
      const batch = this.state.batches.find((b) => b.batchId === e.batchId);
      if (!batch) return;
      const counters: BatchCounters = {
        batchId: e.batchId,
        kind: batch.kind,
        total: e.total,
        running: e.running,
        completed: e.completed,
        failed: e.failed,
      };
      this.state = applyTaskEvent(this.state, {
        type: 'TASK_DELTA',
        entries: [],
        counters: [counters],
      });
      this.dirtyCounters.set(e.batchId, counters);
      this.markDirty();
      return;
    }

    const { phase, workId } = parseTaskKey(e.key);
    if (!phase) return;
    const entry: PhaseEntry = {
      workId,
      phase,
      status: toPhaseStatus(e.status),
      changedAt: nowIso(),
      batchId: this.keyBatches.get(e.key),
      ...(e.error ? { error: e.error } : {}),
    };
    this.state = applyTaskEvent(this.state, {
      type: 'TASK_DELTA',
      entries: [entry],
      counters: [],
    });
    this.dirtyEntries.set(e.key, entry);
    if (
      e.status === 'failed' &&
      PHASE_CONFIG[phase].failurePolicy === 'fail-pipeline'
    ) {
      this.cancelPendingDependents(phase, workId);
    }
    this.markDirty();
  }

  /** fail-pipeline 阶段失败后，取消同批次中仍 pending 的后续阶段（不动 running，不跨批次）。 */
  private cancelPendingDependents(failedPhase: Phase, workId: string): void {
    const batchId = this.keyBatches.get(taskKey(failedPhase, workId));
    const startIdx = PHASE_ORDER.indexOf(failedPhase) + 1;
    for (let i = startIdx; i < PHASE_ORDER.length; i++) {
      const phase = PHASE_ORDER[i];
      if (!phase) continue;
      const key = taskKey(phase, workId);
      if (batchId !== undefined && this.keyBatches.get(key) !== batchId)
        continue;
      if (this.queue.getState(key) === 'pending') this.queue.cancel(key);
    }
  }

  private addLog(
    level: string,
    message: string,
    batchId?: string,
    workId?: string,
  ): void {
    const log: BatchLog = {
      level,
      message,
      timestamp: nowIso(),
      ...(batchId ? { batchId } : {}),
      ...(workId ? { workId } : {}),
    };
    this.state = {
      ...this.state,
      logs: capLogs([...this.state.logs, log]),
    };
    this.pendingLogs.push(log);
    this.markDirty();
  }

  private markDirty(): void {
    if (this.flushTimer) return;
    this.flushTimer = setTimeout(() => this.flush(), this.flushIntervalMs);
    this.flushTimer.unref?.();
  }

  private flush(): void {
    this.flushTimer = undefined;
    if (
      this.dirtyEntries.size === 0 &&
      this.dirtyCounters.size === 0 &&
      this.pendingLogs.length === 0
    ) {
      return;
    }
    this.emitEvent({
      type: 'TASK_DELTA',
      entries: [...this.dirtyEntries.values()],
      counters: [...this.dirtyCounters.values()],
    });
    for (const log of this.pendingLogs)
      this.emitEvent({ type: 'BATCH_LOG', log });
    this.dirtyEntries.clear();
    this.dirtyCounters.clear();
    this.pendingLogs.length = 0;
  }

  private emitEvent(e: TaskEvent): void {
    for (const cb of this.listeners) cb(e);
  }
}

function taskKey(phase: Phase, workId: string): string {
  return `${phase}:${workId}`;
}

function parseTaskKey(key: string): { phase?: Phase; workId: string } {
  const i = key.indexOf(':');
  if (i < 0) return { workId: key };
  const phase = key.slice(0, i);
  if (!(PHASE_ORDER as readonly string[]).includes(phase))
    return { workId: key };
  return { phase: phase as Phase, workId: key.slice(i + 1) };
}

function toPhaseStatus(status: CoreStatus): PhaseStatus {
  return status === 'cancelled' ? 'skipped' : status;
}

function nowIso(): string {
  return new Date().toISOString();
}

function capLogs(logs: BatchLog[]): BatchLog[] {
  return logs.length > LOG_CAP ? logs.slice(logs.length - LOG_CAP) : logs;
}

export type {
  AnalysisSummaryResults,
  BatchCounters,
  BatchInfo,
  BatchKind,
  BatchLog,
  BatchOutcome,
  CoreEvent,
  CoreStatus,
  Phase,
  PhaseEntry,
  PhaseStatus,
  ScanSummaryResults,
  TaskEvent,
  TaskSnapshot,
};
// re-export 供编排器/路由使用，避免散落 import
export { TaskQueue };
