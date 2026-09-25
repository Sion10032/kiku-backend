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
  /** 指定作品集（播放插队用）；缺省 = 全部待分析 */
  workIds?: string[];
  /** worker 每取下一个作品前先查此拉取函数（优先队列） */
  pullPriority?: () => string | undefined;
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

  const queue = [...(opts.workIds ?? (await getPendingAnalysisWorkIds()))];
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
    const id =
      opts.pullPriority?.() ?? (queue.length > 0 ? queue.shift() : undefined);
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
  private priority: string[] = [];

  get isAnalyzing(): boolean {
    return this.analyzing;
  }

  /** 当前分析状态快照（SSE 重连补播用）；从未分析过为 null */
  getSnapshot(): AnalysisSnapshot | null {
    return this.snapshot;
  }

  /** 启动（全量或单作品）。已在跑返回 false。 */
  startAnalysis(config: Config, workId?: string): boolean {
    if (this.analyzing) return false;
    this.snapshot = emptyAnalysisSnapshot();
    this.runAnalysis(config, workId ? [workId] : undefined).catch((err) => {
      console.error('[Analysis] Unhandled error:', err);
    });
    return true;
  }

  /** 分析进行中插入优先作品；未在跑时返回 false（调用方应改用 startAnalysis）。 */
  requestWork(workId: string): boolean {
    if (!this.analyzing) return false;
    this.priority.push(workId);
    return true;
  }

  /** Terminate the current analysis. No-op if no analysis is running. */
  killAnalysis(): void {
    this.currentController?.abort();
  }

  private async runAnalysis(config: Config, workIds?: string[]): Promise<void> {
    this.analyzing = true;
    this.currentController = new AbortController();
    this.priority = [];
    const signal = this.currentController.signal;

    try {
      const gen = performAnalysis(config, signal, {
        workIds,
        pullPriority: () =>
          this.priority.length > 0 ? this.priority.shift() : undefined,
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
      this.analyzing = false;
      this.currentController = null;
    }
  }
}

export const analysisManager = new AnalysisManager();
