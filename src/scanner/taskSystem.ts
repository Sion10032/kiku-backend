// 任务系统装配层：把业务语义（workId/阶段 DAG/两池/合并策略）装配到通用调度内核上。
// 阶段以 `${phase}:${workId}` 为 key；cover/track → metadata 为队列级依赖，analyze 的
// 先后由编排器 barrier 时序保证（track warn-continue 失败不得阻断接力，见行为对齐表）。
// 快照为权威状态：状态变化立即写入（SnapshotHub），TASK_DELTA/BATCH_LOG 经节流合并发出。

import { getConfig } from '../infra/config/index.js';
import {
  type BatchOutcome,
  type CoreEvent,
  type CoreStatus,
  TaskQueue,
} from '../infra/taskQueue/index.js';
import { analyzeExecutor } from './phases/analyze.js';
import { coverExecutor } from './phases/cover.js';
import { metadataExecutor } from './phases/metadata.js';
import {
  PHASE_CONFIG,
  PHASE_ORDER,
  PRIORITY_VALUE,
  parseTaskKey,
  taskKey,
} from './phases/phaseConfig.js';
import { trackExecutor } from './phases/track.js';
import type {
  PhaseExecutor,
  PhaseResult,
  WorkLocation,
} from './phases/types.js';
import type {
  AnalysisSummaryResults,
  BatchCounters,
  BatchKind,
  BatchLog,
  Phase,
  PhaseEntry,
  PhaseStatus,
  ScanSummaryResults,
  TaskEvent,
} from './taskEvents.js';
import { SnapshotHub } from './taskSnapshotHub.js';

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
  private readonly hub: SnapshotHub;
  private readonly executors = new Map<Phase, PhaseExecutor>();
  private readonly keyBatches = new Map<string, string>();
  private readonly keyVariants = new Map<string, 'moved'>();
  private readonly keyLocations = new Map<string, WorkLocation>();
  private readonly resultsByBatch = new Map<string, Map<string, PhaseResult>>();

  constructor(queue: TaskQueue, options: TaskSystemOptions = {}) {
    this.queue = queue;
    this.hub = new SnapshotHub(options);
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
    this.hub.upsertBatch({
      batchId,
      kind,
      createdAt: nowIso(),
      counters,
      status: 'running',
    });
    this.hub.markCounters(counters);
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
        if (mode === 'if-needed' && this.queue.getState(key) === 'completed') {
          // 跳过也要清理 per-key 附件，否则 keyVariants/keyLocations 随跳过累积泄漏
          this.keyVariants.delete(key);
          this.keyLocations.delete(key);
          continue;
        }
        if (phase === 'metadata' && opts.variants?.[workId]) {
          this.keyVariants.set(key, opts.variants[workId]);
        }
        // location 存到每个 phase key：cover（manual 本地封面 absDir）与
        // track（rootFolder/relativePath）同样需要，此前只存/取 metadata 导致
        // scan/update 的 track 阶段永远拿到 undefined 而抛 requires location
        if (opts.locations?.[workId]) {
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
          // 未入队：附件不会被 run 清理，就地删防泄漏
          this.keyVariants.delete(key);
          this.keyLocations.delete(key);
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
    const prev = this.hub.findBatch(batchId);
    if (!prev) return;
    const completedAt = nowIso();
    // 终态固化：该批次实际处理过的作品名单（去重），历史批次卡渲染不受
    // 后续批次重跑同作品时活流水线 batchId 漂移的影响
    const workIds = [
      ...new Set(
        [...this.batchResults(batchId).keys()].map(
          (key) => key.split(':')[1] ?? '',
        ),
      ),
    ].filter(Boolean);
    this.hub.upsertBatch({
      ...prev,
      status,
      completedAt,
      ...(results ? { results } : {}),
      workIds,
    });
    if (status === 'completed' && results) {
      this.hub.emitNow({
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

  /** 编排器叙述性日志（BATCH_LOG 通道，立即入快照 + 节流发出）。 */
  log(level: string, message: string, batchId?: string, workId?: string): void {
    this.addLog(level, message, batchId, workId);
  }

  /** 权威快照（含节流窗口内未发出的状态）。 */
  snapshot() {
    return this.hub.snapshot();
  }

  subscribe(cb: (e: TaskEvent) => void): () => void {
    return this.hub.subscribe(cb);
  }

  dispose(): void {
    this.hub.dispose();
    this.executors.clear();
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
    // location 对所有阶段可见（cover 的 absDir / track 的 rootFolder+relativePath）
    const location = this.keyLocations.get(key);
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
      const batch = this.hub.findBatch(e.batchId);
      if (!batch) return;
      const counters: BatchCounters = {
        batchId: e.batchId,
        kind: batch.kind,
        total: e.total,
        running: e.running,
        completed: e.completed,
        failed: e.failed,
      };
      this.hub.apply({ type: 'TASK_DELTA', entries: [], counters: [counters] });
      this.hub.markCounters(counters);
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
    this.hub.apply({ type: 'TASK_DELTA', entries: [entry], counters: [] });
    this.hub.markEntry(e.key, entry);
    if (
      e.status === 'failed' &&
      PHASE_CONFIG[phase].failurePolicy === 'fail-pipeline'
    ) {
      this.cancelPendingDependents(phase, workId);
    }
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
    this.hub.pushLog(log);
  }
}

function toPhaseStatus(status: CoreStatus): PhaseStatus {
  return status === 'cancelled' ? 'skipped' : status;
}

function nowIso(): string {
  return new Date().toISOString();
}

// ---------- 生产单例（惰性：首次使用时读 config 建池，测试注入自己的实例） ----------

let singleton: TaskSystem | null = null;

export function getTaskSystem(): TaskSystem {
  if (!singleton) {
    const config = getConfig();
    singleton = new TaskSystem(
      new TaskQueue({
        net: config.maxParallelism,
        cpu: config.analysisParallelism,
      }),
    );
    // 生产单例绑真实阶段执行体（测试注入自己的 TaskSystem 实例并注册 mock）
    singleton.registerExecutor('metadata', metadataExecutor);
    singleton.registerExecutor('cover', coverExecutor);
    singleton.registerExecutor('track', trackExecutor);
    singleton.registerExecutor('analyze', analyzeExecutor);
  }
  return singleton;
}
