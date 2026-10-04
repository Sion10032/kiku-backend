// 服务端权威快照持有者：立即应用事件（reducer 单一归并语义）、按窗口节流发出
// TASK_DELTA / BATCH_LOG。TASK_SNAPSHOT 权威性不受节流影响（snapshot() 即时最新）。

import {
  applyTaskEvent,
  type BatchCounters,
  type BatchInfo,
  type BatchLog,
  emptyTaskSnapshot,
  LOG_CAP,
  type PhaseEntry,
  type TaskEvent,
  type TaskSnapshot,
} from './taskEvents.js';

export interface SnapshotHubOptions {
  /** TASK_DELTA/BATCH_LOG 节流窗口。默认 250ms。 */
  flushIntervalMs?: number;
}

export class SnapshotHub {
  private state: TaskSnapshot = emptyTaskSnapshot();
  private readonly listeners = new Set<(e: TaskEvent) => void>();
  private readonly dirtyEntries = new Map<string, PhaseEntry>();
  private readonly dirtyCounters = new Map<string, BatchCounters>();
  private readonly pendingLogs: BatchLog[] = [];
  private flushTimer: ReturnType<typeof setTimeout> | undefined;
  private readonly flushIntervalMs: number;

  constructor(options: SnapshotHubOptions = {}) {
    this.flushIntervalMs = options.flushIntervalMs ?? 250;
  }

  /** 立即更新权威快照。 */
  apply(event: TaskEvent): void {
    this.state = applyTaskEvent(this.state, event);
  }

  findBatch(batchId: string): BatchInfo | undefined {
    return this.state.batches.find((b) => b.batchId === batchId);
  }

  /** 写入完整批次对象（startBatch 建卡 / finishBatch 收尾）。 */
  upsertBatch(batch: BatchInfo): void {
    const idx = this.state.batches.findIndex(
      (b) => b.batchId === batch.batchId,
    );
    const batches = [...this.state.batches];
    if (idx >= 0) batches[idx] = batch;
    else batches.push(batch);
    this.state = { ...this.state, batches };
  }

  markEntry(key: string, entry: PhaseEntry): void {
    this.dirtyEntries.set(key, entry);
    this.markDirty();
  }

  markCounters(counters: BatchCounters): void {
    this.dirtyCounters.set(counters.batchId, counters);
    this.markDirty();
  }

  pushLog(log: BatchLog): void {
    this.state = { ...this.state, logs: capLogs([...this.state.logs, log]) };
    this.pendingLogs.push(log);
    this.markDirty();
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

  /** 不经节流的即时事件（如 BATCH_SUMMARY）。 */
  emitNow(e: TaskEvent): void {
    this.emitEvent(e);
  }

  dispose(): void {
    if (this.flushTimer) clearTimeout(this.flushTimer);
    this.flushTimer = undefined;
    this.listeners.clear();
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

function capLogs(logs: BatchLog[]): BatchLog[] {
  return logs.length > LOG_CAP ? logs.slice(logs.length - LOG_CAP) : logs;
}
