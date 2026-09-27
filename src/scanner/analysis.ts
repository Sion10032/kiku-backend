import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import {
  checkFfmpegAvailable,
  extractToTemp,
  measureLoudness,
} from '../infra/audio/ffmpeg.js';
import type { Config } from '../infra/config/schema.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import type { WorkSource } from '../infra/fs/source/types.js';
import { getRootFolderPathByName } from '../services/rootFolder.service.js';
import {
  computeWorkLoudness,
  getPendingAnalysisWorkIds,
  getTrackRows,
  setTrackLoudness,
} from '../services/track.service.js';
import { getWorkRow } from '../services/work.service.js';
import type { ScanLogPayload } from './scanner.js';

export interface AnalysisTaskPayload {
  workId: string;
  title: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  analyzed: number;
  total: number;
  error?: string;
}

export type AnalysisEvent =
  | { type: 'ANALYSIS_TASK'; task: AnalysisTaskPayload }
  | { type: 'ANALYSIS_LOG'; log: ScanLogPayload }
  | {
      type: 'ANALYSIS_RESULTS';
      results: {
        totalWorks: number;
        analyzedTracks: number;
        failedTracks: number;
        failedWorks: number;
      };
    }
  | { type: 'ANALYSIS_FINISHED'; message: string }
  | { type: 'ANALYSIS_ERROR'; error: string };

export interface AnalysisSnapshot {
  tasks: AnalysisTaskPayload[];
  failedTasks: AnalysisTaskPayload[];
  completed: number;
  logs: ScanLogPayload[];
}

/** 日志快照保留条数上限（与扫描快照同值） */
export const SCAN_LOG_CAP = 500;

export function emptyAnalysisSnapshot(): AnalysisSnapshot {
  return { tasks: [], failedTasks: [], completed: 0, logs: [] };
}

/** 镜像 applyScanEvent 语义（completed→计数、failed→failedTasks、scanning→按 workId upsert、LOG 封顶）。 */
export function applyAnalysisEvent(
  snapshot: AnalysisSnapshot,
  event: AnalysisEvent,
): AnalysisSnapshot {
  switch (event.type) {
    case 'ANALYSIS_TASK': {
      const { task } = event;
      // 终态任务可能仍在非终态列表中，先按 workId 移除
      const tasks = snapshot.tasks.filter((t) => t.workId !== task.workId);
      if (task.status === 'completed') {
        return { ...snapshot, tasks, completed: snapshot.completed + 1 };
      }
      if (task.status === 'failed') {
        return {
          ...snapshot,
          tasks,
          failedTasks: [...snapshot.failedTasks, task],
        };
      }
      // pending / scanning：upsert，保持发现顺序
      const idx = tasks.findIndex((t) => t.workId === task.workId);
      if (idx === -1) return { ...snapshot, tasks: [...tasks, task] };
      const next = [...tasks];
      next[idx] = task;
      return { ...snapshot, tasks: next };
    }
    case 'ANALYSIS_LOG': {
      const logs = [...snapshot.logs, event.log];
      return {
        ...snapshot,
        logs: logs.length > SCAN_LOG_CAP ? logs.slice(-SCAN_LOG_CAP) : logs,
      };
    }
    default:
      return snapshot;
  }
}

/** 单条日志事件（模块级共享）。 */
const emitLog = function* (
  level: string,
  message: string,
): Generator<AnalysisEvent, void, unknown> {
  yield {
    type: 'ANALYSIS_LOG',
    log: { level, message, timestamp: new Date().toISOString() },
  };
};

export interface AnalysisOptions {
  /** low 队列启动快照：仅用于开局 ANALYSIS_TASK pending 事件展示（消费走 pullQueued） */
  initialLow?: string[];
  /** 高优先级拉取（每轮最优先消费，插队队列） */
  pullPriority?: () => string | undefined;
  /** low 队列拉取（FIFO 排队，含全量/子集入队） */
  pullQueued?: () => string | undefined;
  /** 依赖注入（测试） */
  measure?: typeof measureLoudness;
  openSource?: (rootPath: string, dir: string) => Promise<WorkSource>;
}

interface WorkOutcome {
  title: string;
  analyzed: number;
  failed: number;
}

/**
 * 单作品分析：轨道循环（仅 loudness IS NULL 的行）→ 测量 → 写行 → 作品响度。
 * 进度事件经 push 外发（worker 池并发下由主循环统一 yield）；
 * 抛错（含 abort）由 worker 捕获记失败任务。
 */
async function analyzeWork(
  workId: string,
  signal: AbortSignal,
  push: (e: AnalysisEvent) => void,
  deps: Required<Pick<AnalysisOptions, 'measure' | 'openSource'>>,
): Promise<WorkOutcome> {
  const work = await getWorkRow(workId);
  if (!work) throw new Error(`work ${workId} not found`);
  const rootPath = await getRootFolderPathByName(work.rootFolder);
  if (!rootPath) throw new Error(`root folder ${work.rootFolder} missing`);

  const source = await deps.openSource(rootPath, work.dir);
  const rows = (await getTrackRows(workId)).filter(
    (r) => r.loudnessLufs === null,
  );
  const total = rows.length;
  let analyzed = 0;
  let failed = 0;

  for (const row of rows) {
    if (signal.aborted)
      throw new DOMException('Analysis aborted', 'AbortError');
    let temp: { path: string; cleanup: () => Promise<void> } | null = null;
    try {
      // folder 源直接用原路径；归档源提取临时文件
      temp =
        source.kind === 'folder'
          ? {
              path: join(rootPath, work.dir, row.mediaIndex),
              cleanup: async () => {},
            }
          : await extractToTemp(source, row.mediaIndex, signal);
      const { lufs, truePeakDb, curve } = await deps.measure(temp.path, signal);
      await setTrackLoudness(workId, row.mediaIndex, {
        lufs,
        truePeakDb,
        curve,
      });
      analyzed++;
    } catch (err) {
      if (signal.aborted) throw err;
      await setTrackLoudness(workId, row.mediaIndex, {
        error: err instanceof Error ? err.message : String(err),
      });
      failed++;
      push({
        type: 'ANALYSIS_LOG',
        log: {
          level: 'error',
          message: `Track failed: ${workId} ${row.mediaIndex}: ${String(err)}`,
          timestamp: new Date().toISOString(),
        },
      });
    } finally {
      await temp?.cleanup();
    }
    push({
      type: 'ANALYSIS_TASK',
      task: {
        workId,
        title: work.title,
        status: 'scanning',
        analyzed: analyzed + failed,
        total,
      },
    });
  }

  await computeWorkLoudness(workId);
  return { title: work.title, analyzed, failed };
}

/**
 * Async generator that performs loudness analysis, yielding events as it progresses.
 * 队列 = 指定作品集或全部待分析作品；worker 池并发（analysisParallelism），
 * 事件队列汇聚 + 主循环单点 yield；abort 后不再产出 RESULTS。
 */
export async function* performAnalysis(
  config: Config,
  signal: AbortSignal,
  opts: AnalysisOptions = {},
): AsyncGenerator<AnalysisEvent> {
  const deps = {
    measure: opts.measure ?? measureLoudness,
    openSource: opts.openSource ?? openWorkSource,
  };

  if (!(await checkFfmpegAvailable())) {
    yield {
      type: 'ANALYSIS_ERROR',
      error: `ffmpeg not found at "${config.ffmpegPath}" — install ffmpeg or set ffmpegPath in config`,
    };
    return;
  }

  const queue = [...(opts.initialLow ?? [])];
  if (queue.length === 0) {
    yield* emitLog('info', 'Nothing to analyze');
  }
  yield* emitLog(
    'info',
    `Analyzing ${queue.length} works (parallelism ${config.analysisParallelism})`,
  );
  for (const w of queue) {
    yield {
      type: 'ANALYSIS_TASK',
      task: { workId: w, title: w, status: 'pending', analyzed: 0, total: 0 },
    };
  }

  // 事件队列 + worker 池：worker 并发跑作品，主循环单点 yield
  const events: AnalysisEvent[] = [];
  let wake: (() => void) | undefined;
  const push = (e: AnalysisEvent): void => {
    events.push(e);
    wake?.();
  };
  let analyzedTracks = 0;
  let failedTracks = 0;
  let failedWorks = 0;
  /** worker 实际拉取数（优先队列会超出初始 queue，RESULTS 以此为准） */
  let pulledCount = 0;

  const pull = (): string | undefined => {
    const id = opts.pullPriority?.() ?? opts.pullQueued?.();
    if (id !== undefined) pulledCount++;
    return id;
  };

  const worker = async (): Promise<void> => {
    for (;;) {
      if (signal.aborted) return;
      const workId = pull();
      if (!workId) return;
      try {
        const r = await analyzeWork(workId, signal, push, deps);
        analyzedTracks += r.analyzed;
        failedTracks += r.failed;
        if (r.failed > 0 && r.analyzed === 0) {
          failedWorks++;
          push({
            type: 'ANALYSIS_TASK',
            task: {
              workId,
              title: r.title,
              status: 'failed',
              analyzed: 0,
              total: 0,
              error: `${r.failed} tracks failed`,
            },
          });
        } else {
          push({
            type: 'ANALYSIS_TASK',
            task: {
              workId,
              title: r.title,
              status: 'completed',
              analyzed: r.analyzed,
              total: r.analyzed + r.failed,
            },
          });
        }
      } catch (err) {
        if (signal.aborted) return;
        failedWorks++;
        push({
          type: 'ANALYSIS_LOG',
          log: {
            level: 'error',
            message: `Work failed: ${workId}: ${String(err)}`,
            timestamp: new Date().toISOString(),
          },
        });
        push({
          type: 'ANALYSIS_TASK',
          task: {
            workId,
            title: workId,
            status: 'failed',
            analyzed: 0,
            total: 0,
            error: String(err),
          },
        });
      }
    }
  };

  const nWorkers = Math.max(
    1,
    Math.min(config.analysisParallelism, queue.length),
  );
  const workers = Promise.allSettled(
    Array.from({ length: nWorkers }, () => worker()),
  );

  // 主循环：有事件就 yield，worker 全结束且队列空则退出
  for (;;) {
    if (events.length > 0) {
      yield events.shift() as AnalysisEvent;
      continue;
    }
    const settled = await Promise.race([
      workers.then(() => 'done' as const),
      new Promise<void>((r) => {
        wake = () => {
          wake = undefined;
          r();
        };
      }),
    ]);
    if (settled === 'done' && events.length === 0) break;
  }
  await workers;

  // abort 语义对齐 scanner：AbortError 上抛 → Manager 发 FINISHED(terminated)，不再 yield RESULTS
  if (signal.aborted) throw new DOMException('Analysis aborted', 'AbortError');

  yield {
    type: 'ANALYSIS_RESULTS',
    results: {
      totalWorks: pulledCount,
      analyzedTracks,
      failedTracks,
      failedWorks,
    },
  };
  yield {
    type: 'ANALYSIS_FINISHED',
    message: 'Analysis completed successfully',
  };
}

/**
 * Manages the analysis lifecycle and broadcasts analysis events via an EventEmitter.
 * SSE endpoints subscribe to the 'analysis' event to push updates to clients.
 * 镜像 ScannerManager：单飞、快照维护、SSE 补播、可中止。
 */
class AnalysisManager extends EventEmitter {
  private currentController: AbortController | null = null;
  private analyzing = false;
  private snapshot: AnalysisSnapshot | null = null;
  /** high 插队队列：每轮消费最优先（作品页触发） */
  private priority: string[] = [];
  /** low 排队队列：全量 pending 与管理页子集都入这里，每轮最后消费 */
  private queuedLow: string[] = [];
  /** 全量请求待落地标志（落地 = DB pending 并入 queuedLow） */
  private fullLowRequested = false;
  /** runAnalysis 轮次（kill 后使飞行中的全量落地失效） */
  private runSeq = 0;

  get isAnalyzing(): boolean {
    return this.analyzing;
  }

  /** 当前分析状态快照（SSE 重连补播用）；从未分析过为 null */
  getSnapshot(): AnalysisSnapshot | null {
    return this.snapshot;
  }

  /**
   * 触发分析（统一入口）：
   * - 子集（workIds）：high → 从 low 移除同作品后进插队队列；low → 追加队尾。
   * - 全量（无 workIds）：把 DB 全部待分析作品并入 low 队尾（已跑时为增量排队）。
   * 未在跑 → 启动消费两队列；已在跑 → high/全量受理排队（queued=true）。
   * started = 本次调用触发新分析；queued = 已在跑且受理排队。
   */
  startAnalysis(
    config: Config,
    workIds?: string[],
    priority: 'high' | 'low' = 'low',
  ): { started: boolean; queued: boolean } {
    if (workIds) {
      if (priority === 'high') {
        // 同作品先从 low 移除，避免双跑
        this.queuedLow = this.queuedLow.filter((id) => !workIds.includes(id));
        this.priority.push(...workIds);
      } else {
        this.queuedLow.push(...workIds);
      }
      if (this.analyzing) return { started: false, queued: true };
    } else {
      this.fullLowRequested = true;
      if (this.analyzing) {
        // 已跑：异步落地为 low 队列增量（worker 拉空竞态由收尾接力兑底）
        const seq = this.runSeq;
        void this.drainFullLow(seq, config);
        return { started: false, queued: true };
      }
    }
    this.snapshot = emptyAnalysisSnapshot();
    this.runAnalysis(config).catch((err) => {
      console.error('[Analysis] Unhandled error:', err);
    });
    return { started: true, queued: false };
  }

  /** 全量请求落地：DB pending（过滤已在队列的）并入 low 队尾。幂等。 */
  private async drainFullLow(seq: number, config: Config): Promise<void> {
    if (!this.fullLowRequested) return;
    this.fullLowRequested = false;
    const pending = await getPendingAnalysisWorkIds();
    if (seq !== this.runSeq) return; // 轮次已失效（kill 后）：丢弃本次全量
    const known = new Set([...this.priority, ...this.queuedLow]);
    const fresh = pending.filter((id) => !known.has(id));
    this.queuedLow.push(...fresh);
    // 落地时分析已收尾（拉空竞态）：主动拉起消费，否则任务滞留
    if (fresh.length > 0 && !this.analyzing) {
      this.snapshot = emptyAnalysisSnapshot();
      this.runAnalysis(config).catch((err) => {
        console.error('[Analysis] Unhandled error:', err);
      });
    }
  }

  /** Terminate the current analysis. No-op if no analysis is running. */
  killAnalysis(): void {
    this.currentController?.abort();
    // 使飞行中的全量落地失效（被终止的批次不重新拉起）
    this.runSeq++;
  }

  private async runAnalysis(config: Config): Promise<void> {
    const seq = ++this.runSeq;
    this.analyzing = true;
    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    try {
      // 全量填充必须在 worker 启动前落地，否则拉空竞态提前收尾
      await this.drainFullLow(seq, config);
      const initialLow = [...this.queuedLow];
      const gen = performAnalysis(config, signal, {
        initialLow,
        pullPriority: () =>
          this.priority.length > 0 ? this.priority.shift() : undefined,
        pullQueued: () =>
          this.queuedLow.length > 0 ? this.queuedLow.shift() : undefined,
      });
      for await (const event of gen) {
        // 维护快照供断线重连补播（ANALYSIS_FINISHED/ERROR 不改快照）
        if (this.snapshot) {
          this.snapshot = applyAnalysisEvent(this.snapshot, event);
        }
        this.emit('analysis', event);
      }
      // ANALYSIS_FINISHED 由 performAnalysis 正常收尾时 yield，这里无需补发
    } catch (err) {
      if (signal.aborted) {
        this.emit('analysis', {
          type: 'ANALYSIS_FINISHED',
          message: 'Analysis was terminated',
        });
      } else {
        this.emit('analysis', { type: 'ANALYSIS_ERROR', error: String(err) });
      }
    } finally {
      this.currentController = null;
      if (signal.aborted) {
        // 终止：排队任务一并丢弃
        this.priority = [];
        this.queuedLow = [];
        this.fullLowRequested = false;
      }
      this.analyzing = false;
    }
    // worker 拉空收尾窗口内到达的排队任务：队列仍非空 → 自动拉起下一轮
    // （同步检查无 await，无窗口；递归深度受真实请求限制）
    if (
      !signal.aborted &&
      seq === this.runSeq &&
      (this.priority.length > 0 || this.queuedLow.length > 0)
    ) {
      this.snapshot = emptyAnalysisSnapshot();
      this.runAnalysis(config).catch((err) => {
        console.error('[Analysis] Unhandled error:', err);
      });
    }
  }
}

export const analysisManager = new AnalysisManager();
