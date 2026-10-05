// 通用任务调度内核：不认识任何业务概念。
// 任务 = { key, resource, priority, deps?, batchId?, run(signal) }；
// 语义 = 同 key 合并/拒绝、每资源并发池、优先级保序、依赖就绪、批次 barrier、终态 TTL。
// 依赖语义：dep key 查无记录视为已满足（外部完成 / TTL 已清）；dep 失败或取消时，等待者级联取消。

export type CoreStatus =
  | 'pending'
  | 'running'
  | 'completed'
  | 'failed'
  | 'cancelled';

export interface CoreTask {
  /** 唯一身份（业务侧为 `${phase}:${workId}`）。 */
  key: string;
  /** 资源池 id（内核不解释，如 'net' | 'cpu'）。 */
  resource: string;
  /** 大者先执行；同优先级 FIFO。 */
  priority: number;
  /** 全部 dep 处于 completed（或查无记录）才就绪。 */
  deps?: string[];
  batchId?: string;
  /** 抛错即 failed；cancel 时会 abort 此 signal。 */
  run: (signal: AbortSignal) => Promise<void>;
}

export type SubmitOutcome = 'accepted' | 'merged' | 'rejected-running';

export interface BatchOutcome {
  total: number;
  completed: number;
  failed: number;
  cancelled: number;
}

export type CoreEvent =
  | { type: 'task'; key: string; status: CoreStatus; error?: string }
  | {
      type: 'batch-count';
      batchId: string;
      total: number;
      running: number;
      completed: number;
      failed: number;
    };

export interface TaskQueueOptions {
  /** 终态记录保留时长，超时清除（清除后同 key 可重入、deps 视为满足）。默认 5 分钟。 */
  ttlMs?: number;
  /** TTL 清扫间隔。默认 min(60_000, ttlMs / 2)。 */
  intervalMs?: number;
}

interface TaskRecord {
  task: CoreTask;
  status: CoreStatus;
  error?: string;
  controller?: AbortController;
  cancelRequested?: boolean;
  finishedAt?: number;
}

const DEFAULT_TTL_MS = 5 * 60_000;

function isTerminal(status: CoreStatus): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled'
  );
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export class TaskQueue {
  private readonly pools: Record<string, number>;
  private readonly records = new Map<string, TaskRecord>();
  private readonly ready = new Map<string, TaskRecord[]>();
  private readonly running: Record<string, number> = {};
  private readonly depWaiters = new Map<string, Set<string>>();
  private readonly batchWaiters = new Map<
    string,
    Array<(o: BatchOutcome) => void>
  >();
  private readonly listeners = new Set<(e: CoreEvent) => void>();
  private readonly ttlMs: number;
  private timer: ReturnType<typeof setInterval>;

  constructor(pools: Record<string, number>, options: TaskQueueOptions = {}) {
    this.pools = { ...pools };
    this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
    const intervalMs =
      options.intervalMs ?? Math.min(60_000, Math.floor(this.ttlMs / 2));
    this.timer = setInterval(() => this.sweep(), intervalMs);
    this.timer.unref?.();
  }

  submit(task: CoreTask): SubmitOutcome {
    const existing = this.records.get(task.key);
    if (existing && existing.status === 'running') return 'rejected-running';
    if (existing && existing.status === 'pending') {
      // 合并：优先级取高、执行体取新（后提交意图胜出）；batchId/deps 保留首次提交
      existing.task.run = task.run;
      if (task.priority > existing.task.priority) {
        existing.task.priority = task.priority;
        this.removeFromReady(existing);
        this.enqueue(existing);
      }
      return 'merged';
    }

    const rec: TaskRecord = { task, status: 'pending' };
    this.records.set(task.key, rec);
    this.emit({ type: 'task', key: task.key, status: 'pending' });
    this.emitBatchCount(task.batchId);
    if (this.depsSatisfied(task)) {
      this.enqueue(rec);
      this.schedule();
    } else {
      for (const dep of task.deps ?? []) {
        const waiters = this.depWaiters.get(dep) ?? new Set<string>();
        waiters.add(task.key);
        this.depWaiters.set(dep, waiters);
      }
    }
    return 'accepted';
  }

  cancel(key: string): boolean {
    const rec = this.records.get(key);
    if (!rec) return false;
    if (rec.status === 'pending') {
      this.removeFromReady(rec);
      this.finishPending(rec, 'cancelled');
      return true;
    }
    if (rec.status === 'running') {
      rec.cancelRequested = true;
      rec.controller?.abort();
      return true;
    }
    return false;
  }

  cancelBatch(batchId: string): void {
    for (const rec of this.records.values()) {
      if (rec.task.batchId !== batchId) continue;
      if (rec.status === 'pending' || rec.status === 'running')
        this.cancel(rec.task.key);
    }
  }

  /** 组内全部终态后 resolve；批次不存在立即返回全零。 */
  barrier(batchId: string): Promise<BatchOutcome> {
    if (this.batchPending(batchId)) {
      return new Promise((resolve) => {
        const waiters = this.batchWaiters.get(batchId) ?? [];
        waiters.push(resolve);
        this.batchWaiters.set(batchId, waiters);
      });
    }
    return Promise.resolve(this.batchOutcome(batchId));
  }

  getState(key: string): CoreStatus | undefined {
    return this.records.get(key)?.status;
  }

  onEvent(cb: (e: CoreEvent) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  dispose(): void {
    clearInterval(this.timer);
    this.listeners.clear();
  }

  // ---------- 内部 ----------

  private depsSatisfied(task: CoreTask): boolean {
    if (!task.deps?.length) return true;
    return task.deps.every((dep) => {
      const rec = this.records.get(dep);
      return !rec || rec.status === 'completed';
    });
  }

  private enqueue(rec: TaskRecord): void {
    const list = this.ready.get(rec.task.resource) ?? [];
    let i = 0;
    for (const item of list) {
      if (item.task.priority < rec.task.priority) break;
      i++;
    }
    list.splice(i, 0, rec);
    this.ready.set(rec.task.resource, list);
  }

  /** 运行时热更新池宽（配置页改 maxParallelism/analysisParallelism 后无需重启）：
   *  扩容立即调度 pending，缩容只影响新调度、运行中任务不中断。 */
  setPoolWidth(resource: string, width: number): void {
    this.pools[resource] = Math.max(1, width);
    this.schedule();
  }

  private removeFromReady(rec: TaskRecord): void {
    const list = this.ready.get(rec.task.resource);
    if (!list) return;
    const i = list.indexOf(rec);
    if (i >= 0) list.splice(i, 1);
  }

  private schedule(): void {
    for (const [resource, limit] of Object.entries(this.pools)) {
      while ((this.running[resource] ?? 0) < limit) {
        const rec = this.ready.get(resource)?.shift();
        if (!rec) break;
        this.start(rec, resource);
      }
    }
  }

  private start(rec: TaskRecord, resource: string): void {
    rec.status = 'running';
    rec.controller = new AbortController();
    this.running[resource] = (this.running[resource] ?? 0) + 1;
    this.emit({ type: 'task', key: rec.task.key, status: 'running' });
    this.emitBatchCount(rec.task.batchId);
    rec.task.run(rec.controller.signal).then(
      () => this.settle(rec),
      (err: unknown) => this.settle(rec, err),
    );
  }

  private settle(rec: TaskRecord, err?: unknown): void {
    const resource = rec.task.resource;
    this.running[resource] = (this.running[resource] ?? 1) - 1;
    const cancelled = rec.cancelRequested === true;
    rec.status = cancelled
      ? 'cancelled'
      : err !== undefined
        ? 'failed'
        : 'completed';
    if (err !== undefined && !cancelled) rec.error = errorMessage(err);
    rec.finishedAt = Date.now();
    this.emit({
      type: 'task',
      key: rec.task.key,
      status: rec.status,
      error: rec.error,
    });
    this.emitBatchCount(rec.task.batchId);
    this.releaseDepWaiters(rec.task.key, rec.status);
    this.checkBatchWaiters();
    this.schedule();
  }

  /** pending 记录直接终态（取消），并级联取消以它为 dep 的等待者。 */
  private finishPending(rec: TaskRecord, status: 'cancelled'): void {
    rec.status = status;
    rec.finishedAt = Date.now();
    this.emit({ type: 'task', key: rec.task.key, status });
    this.emitBatchCount(rec.task.batchId);
    this.releaseDepWaiters(rec.task.key, status);
    this.checkBatchWaiters();
  }

  /** dep 到达终态后处理等待者：completed 放行，否则级联取消。 */
  private releaseDepWaiters(depKey: string, depStatus: CoreStatus): void {
    const waiting = this.depWaiters.get(depKey);
    if (!waiting) return;
    this.depWaiters.delete(depKey);
    for (const key of waiting) {
      const rec = this.records.get(key);
      if (rec?.status !== 'pending') continue;
      if (depStatus === 'completed') {
        this.enqueue(rec);
        this.schedule();
      } else {
        this.finishPending(rec, 'cancelled');
      }
    }
  }

  private batchPending(batchId: string): boolean {
    for (const rec of this.records.values()) {
      if (rec.task.batchId === batchId && !isTerminal(rec.status)) return true;
    }
    return false;
  }

  private batchOutcome(batchId: string): BatchOutcome {
    const outcome: BatchOutcome = {
      total: 0,
      completed: 0,
      failed: 0,
      cancelled: 0,
    };
    for (const rec of this.records.values()) {
      if (rec.task.batchId !== batchId) continue;
      outcome.total++;
      if (rec.status === 'completed') outcome.completed++;
      else if (rec.status === 'failed') outcome.failed++;
      else if (rec.status === 'cancelled') outcome.cancelled++;
    }
    return outcome;
  }

  private checkBatchWaiters(): void {
    for (const [batchId, waiters] of this.batchWaiters) {
      if (waiters.length === 0 || this.batchPending(batchId)) continue;
      this.batchWaiters.delete(batchId);
      const outcome = this.batchOutcome(batchId);
      for (const resolve of waiters) resolve(outcome);
    }
  }

  private emitBatchCount(batchId?: string): void {
    if (!batchId) return;
    let total = 0;
    let running = 0;
    let completed = 0;
    let failed = 0;
    for (const rec of this.records.values()) {
      if (rec.task.batchId !== batchId) continue;
      total++;
      if (rec.status === 'running') running++;
      else if (rec.status === 'completed') completed++;
      else if (rec.status === 'failed') failed++;
    }
    this.emit({
      type: 'batch-count',
      batchId,
      total,
      running,
      completed,
      failed,
    });
  }

  private emit(e: CoreEvent): void {
    for (const cb of this.listeners) cb(e);
  }

  private sweep(): void {
    const now = Date.now();
    for (const [key, rec] of this.records) {
      if (
        isTerminal(rec.status) &&
        rec.finishedAt !== undefined &&
        now - rec.finishedAt >= this.ttlMs
      ) {
        this.records.delete(key);
      }
    }
  }
}
