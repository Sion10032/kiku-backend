import { EventEmitter } from 'node:events';
import type { Config } from '../config/schema.js';
import { fetchDLsiteWorkInfo } from '../scraper/dlsite.js';
import {
  type CoverType,
  coverExists,
  downloadCover,
} from '../services/cover.service.js';
import {
  getWorksByRootFolder,
  hardDeleteWork,
  softDeleteWork,
  upsertWork,
} from '../services/work.service.js';
import { classifyMissingWorks } from './prune.js';
import { openWorkSource } from './source/index.js';
import { treeHasAudio } from './source/tree.js';
import { UnsupportedArchiveError } from './source/types.js';
import { collectWorkEntries } from './utils.js';

interface ScanTask {
  id: number;
  title: string;
  relativePath: string;
  rootFolder: string;
  rjCode: string; // Full RJ code like "RJ01578781"
  dirName: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
}

/** 软删作品超过该天数仍缺失 → 物理清理（级联 + 封面） */
const SCAN_PURGE_DAYS = 30;

/** 扫描时确保存在的封面类型 */
const SCAN_COVER_TYPES: CoverType[] = ['main', 'sam', '240x240'];

/** 单个任务快照（增量推送，避免整表传输） */
export interface ScanTaskPayload {
  id: number;
  title: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
}

/** 单条扫描日志 */
export interface ScanLogPayload {
  level: string;
  message: string;
  timestamp: string;
}

export type ScanEvent =
  | { type: 'SCAN_TASK'; task: ScanTaskPayload }
  | { type: 'SCAN_LOG'; log: ScanLogPayload }
  | {
      type: 'SCAN_RESULTS';
      results: {
        total: number;
        added: number;
        updated: number;
        failed: number;
        /** 本次因已扫描完成而跳过的作品数 */
        skipped: number;
        /** 源缺失被软删的作品数 */
        removed: number;
        /** 软删超期被物理清理的作品数 */
        purged: number;
      };
    }
  | { type: 'SCAN_FINISHED'; message: string }
  | { type: 'SCAN_ERROR'; error: string };

/** 重连时通过 SCAN_INIT_STATE 下发的状态快照 */
export interface ScanSnapshot {
  /** 非终态任务（pending/scanning） */
  tasks: ScanTaskPayload[];
  failedTasks: ScanTaskPayload[];
  completed: number;
  /** 最近 SCAN_LOG_CAP 条日志 */
  logs: ScanLogPayload[];
}

/** 日志快照保留条数上限 */
export const SCAN_LOG_CAP = 500;

export function emptySnapshot(): ScanSnapshot {
  return { tasks: [], failedTasks: [], completed: 0, logs: [] };
}

/** 将事件应用到快照（ScannerManager 维护重连补播用；纯函数便于测试） */
export function applyScanEvent(
  snapshot: ScanSnapshot,
  event: ScanEvent,
): ScanSnapshot {
  switch (event.type) {
    case 'SCAN_TASK': {
      const { task } = event;
      // completed/failed 的任务可能仍在非终态列表中，先按 id 移除
      const tasks = snapshot.tasks.filter((t) => t.id !== task.id);
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
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { ...snapshot, tasks: [...tasks, task] };
      const next = [...tasks];
      next[idx] = task;
      return { ...snapshot, tasks: next };
    }
    case 'SCAN_LOG': {
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

/**
 * Async generator that performs a scan, yielding events as it progresses.
 * Checks the abort signal between operations so the scan can be terminated.
 */
export async function* performScan(
  config: Config,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const tasks: ScanTask[] = [];
  const failedTasks: ScanTask[] = [];
  /** 本次扫描在磁盘上发现的全部 RJ 码（含 unsupported-archive：源还在就不算缺失） */
  const onDiskRjCodes = new Set<string>();
  /** 本次因已扫描（路径未变、未软删）而跳过的作品数 */
  let skipped = 0;

  // 每条日志即产出一条事件（增量推送，替代原全量日志数组下发）
  const log = function* (
    level: string,
    message: string,
  ): Generator<ScanEvent, void, unknown> {
    yield {
      type: 'SCAN_LOG',
      log: { level, message, timestamp: new Date().toISOString() },
    };
  };

  const stripTask = (t: ScanTask): ScanTaskPayload => ({
    id: t.id,
    title: t.title,
    status: t.status,
    error: t.error,
  });

  yield* log('info', 'Starting scan...');

  // Scan each root folder to build the task list
  for (const rootFolder of config.rootFolders) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    yield* log(
      'info',
      `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`,
    );

    const entries = await collectWorkEntries(
      rootFolder.path,
      config.scannerMaxRecursionDepth,
    );

    // 已扫描作品索引：存在且路径未变、未软删的在下方直接跳过
    const knownWorks = new Map(
      (await getWorksByRootFolder(rootFolder.name)).map((w) => [w.id, w]),
    );

    for (const entry of entries) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

      // 源文件在磁盘上即计入集合（差集清理的依据），与能否解析/是否有音频无关
      onDiskRjCodes.add(entry.rjCode);

      // unsupported-archive: 明确失败而非静默跳过
      if (entry.kind === 'unsupported-archive') {
        const task: ScanTask = {
          id: tasks.length + failedTasks.length + 1,
          title: `${entry.rjCode} ${entry.name}`,
          relativePath: entry.relativePath,
          rootFolder: rootFolder.name,
          rjCode: entry.rjCode,
          dirName: entry.name,
          status: 'failed',
          error: String(
            new UnsupportedArchiveError(
              entry.name,
              '不是 tar / stored zip 格式',
            ),
          ),
        };
        failedTasks.push(task);
        yield* log('error', `Unsupported archive: ${task.title}`);
        // 收集期失败即时下发，替代原全量任务表推送
        yield { type: 'SCAN_TASK', task: stripTask(task) };
        continue;
      }

      // folder/archive：打开 source，校验含音频才建任务
      let hasAudio = false;
      try {
        const source = await openWorkSource(
          rootFolder.path,
          entry.relativePath,
        );
        hasAudio = treeHasAudio(await source.buildTree());
      } catch (err) {
        // 打不开/不支持的包：作为失败任务上报
        const errMsg = err instanceof Error ? err.message : String(err);
        const task: ScanTask = {
          id: tasks.length + failedTasks.length + 1,
          title: `${entry.rjCode} ${entry.name}`,
          relativePath: entry.relativePath,
          rootFolder: rootFolder.name,
          rjCode: entry.rjCode,
          dirName: entry.name,
          status: 'failed',
          error: errMsg,
        };
        failedTasks.push(task);
        yield* log(
          'error',
          `Failed to open: ${entry.rjCode} ${entry.name} - ${errMsg}`,
        );
        yield { type: 'SCAN_TASK', task: stripTask(task) };
        continue;
      }

      if (!hasAudio) {
        // 无音频只记日志，不产生任务事件
        yield* log('info', `Skipped (no audio): ${entry.rjCode} ${entry.name}`);
        continue;
      }

      // 已完成元数据抓取的作品：路径未变且未被软删 → 不建任务、不抓取、不推送，
      // 仅静默补下缺失封面（本地 blob 检查 + 按需下载；sam 等 404 快速失败）
      const known = knownWorks.get(entry.rjCode);
      if (
        known &&
        known.deletedAt === null &&
        known.dir === entry.relativePath
      ) {
        for (const type of SCAN_COVER_TYPES) {
          if (!coverExists(entry.rjCode, type)) {
            await downloadCover(
              entry.rjCode,
              type,
              signal,
              known.sourceId ?? undefined,
            );
          }
        }
        skipped++;
        // 不逐条推送跳过日志（大库时刷屏），仅在汇总处报告总数；
        // 无音频的跳过（no audio）数量通常极少，保留逐条日志便于排查
        continue;
      }

      const task: ScanTask = {
        id: tasks.length + 1,
        title: `${entry.rjCode} ${entry.name}`,
        relativePath: entry.relativePath,
        rootFolder: rootFolder.name,
        rjCode: entry.rjCode,
        dirName: entry.name,
        status: 'pending',
      };
      tasks.push(task);
      yield { type: 'SCAN_TASK', task: stripTask(task) };
    }
  }

  yield* log('info', `Found ${tasks.length} works to scan`);

  if (skipped > 0) {
    yield* log('info', `Skipped ${skipped} already-scanned works`);
  }

  // Process each task
  let added = 0;
  let updated = 0;
  let failed = 0;

  for (const task of tasks) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    try {
      task.status = 'scanning';
      yield { type: 'SCAN_TASK', task: stripTask(task) };

      const rjCode = task.rjCode;

      yield* log('info', `Fetching metadata for ${rjCode}...`);

      // Fetch metadata from DLsite
      const metadata = await fetchDLsiteWorkInfo(rjCode, signal);

      yield* log('info', `Got metadata: ${metadata.title}`);

      // Write to database (dir = relativePath, not dirName)
      const result = await upsertWork({
        id: rjCode,
        rootFolder: task.rootFolder,
        dir: task.relativePath,
        title: metadata.title,
        circleName: metadata.circle || 'Unknown',
        nsfw: metadata.nsfw,
        release: metadata.releaseDate || undefined,
        dlCount: metadata.dlCount || undefined,
        price: metadata.price || undefined,
        reviewCount: metadata.reviewCount || undefined,
        rateCount: metadata.rateCount || undefined,
        rateAverage2dp: metadata.rateAverage || undefined,
        rateCountDetail:
          Object.keys(metadata.rateCountDetail).length > 0
            ? metadata.rateCountDetail
            : undefined,
        rank: Object.keys(metadata.rank).length > 0 ? metadata.rank : undefined,
        tags: metadata.tags,
        vas: metadata.vas,
        language: metadata.language || undefined,
        sourceId: metadata.sourceId || undefined,
      });

      if (!result.success) {
        throw new Error(result.error || 'Failed to save work');
      }

      // 下载封面（如果不存在）
      // 使用 sourceId（未翻译版本）下载封面，如果不存在则使用当前 ID
      const coverSourceId = metadata.sourceId || rjCode;
      for (const type of SCAN_COVER_TYPES) {
        if (!coverExists(rjCode, type)) {
          yield* log(
            'info',
            `Downloading cover ${type} for ${rjCode} (source: ${coverSourceId})...`,
          );

          try {
            const success = await downloadCover(
              rjCode,
              type,
              signal,
              coverSourceId,
            );
            if (success) {
              yield* log('info', `Cover ${type} downloaded for ${rjCode}`);
            } else {
              yield* log(
                'warning',
                `Failed to download cover ${type} for ${rjCode}`,
              );
            }
          } catch (coverErr) {
            yield* log(
              'warning',
              `Error downloading cover ${type} for ${rjCode}: ${String(coverErr)}`,
            );
          }
        }
      }

      if (result.created) {
        added++;
        yield* log('info', `Added: ${rjCode} - ${metadata.title}`);
      } else {
        updated++;
        yield* log('info', `Updated: ${rjCode} - ${metadata.title}`);
      }

      task.status = 'completed';
      yield { type: 'SCAN_TASK', task: stripTask(task) };
    } catch (err) {
      task.status = 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);
      task.error = errMsg;
      failedTasks.push(task);
      failed++;

      yield* log('error', `Failed: ${task.title} - ${errMsg}`);
      yield { type: 'SCAN_TASK', task: stripTask(task) };
    }
  }

  // ---------- Prune：清理源文件已消失的作品（软删 + 超期物理删） ----------
  let removed = 0;
  let purged = 0;

  for (const rootFolder of config.rootFolders) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    const inDb = await getWorksByRootFolder(rootFolder.name);
    if (inDb.length === 0) continue;

    const decision = classifyMissingWorks(
      inDb,
      onDiskRjCodes,
      new Date(),
      SCAN_PURGE_DAYS,
    );

    for (const id of decision.toSoftDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await softDeleteWork(id);
        removed++;
        yield* log('info', `Removed (source missing): ${id}`);
      } catch (err) {
        yield* log('error', `Failed to soft-delete ${id}: ${String(err)}`);
      }
    }

    for (const id of decision.toHardDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await hardDeleteWork(id);
        purged++;
        yield* log('info', `Purged (source missing beyond grace): ${id}`);
      } catch (err) {
        yield* log('error', `Failed to purge ${id}: ${String(err)}`);
      }
    }
  }

  if (removed > 0 || purged > 0) {
    yield* log('info', `Pruned: ${removed} removed, ${purged} purged`);
  }

  // Send final results
  yield {
    type: 'SCAN_RESULTS',
    results: {
      total: tasks.length,
      added,
      updated,
      failed,
      skipped,
      removed,
      purged,
    },
  };
}

/**
 * Manages the scan lifecycle and broadcasts scan events via an EventEmitter.
 * SSE endpoints subscribe to the 'scan' event to push updates to clients.
 */
class ScannerManager extends EventEmitter {
  private currentController: AbortController | null = null;
  private scanning = false;
  private snapshot: ScanSnapshot | null = null;

  get isScanning(): boolean {
    return this.scanning;
  }

  /** 当前扫描状态快照（SSE 重连补播用）；从未扫描过为 null */
  getSnapshot(): ScanSnapshot | null {
    return this.snapshot;
  }

  /** Start a scan in the background. Throws if a scan is already running. */
  startScan(config: Config): void {
    if (this.scanning) {
      throw new Error('Scan is already in progress');
    }

    // 新扫描开始时重置快照
    this.snapshot = emptySnapshot();

    // Run async — fire and forget. Errors are handled inside runScan.
    this.runScan(config).catch((err) => {
      console.error('[Scanner] Unhandled error:', err);
    });
  }

  /** Terminate the current scan. No-op if no scan is running. */
  killScan(): void {
    if (this.currentController) {
      this.currentController.abort();
    }
  }

  private async runScan(config: Config): Promise<void> {
    this.scanning = true;
    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    try {
      for await (const event of performScan(config, signal)) {
        // 维护快照供断线重连补播（SCAN_FINISHED/SCAN_ERROR 不改快照）
        if (this.snapshot) {
          this.snapshot = applyScanEvent(this.snapshot, event);
        }
        this.emit('scan', event);
      }
      this.emit('scan', {
        type: 'SCAN_FINISHED',
        message: 'Scan completed successfully',
      });
    } catch (err) {
      if (signal.aborted) {
        this.emit('scan', {
          type: 'SCAN_FINISHED',
          message: 'Scan was terminated',
        });
      } else {
        this.emit('scan', { type: 'SCAN_ERROR', error: String(err) });
      }
    } finally {
      this.scanning = false;
      this.currentController = null;
    }
  }
}

export const scanner = new ScannerManager();
