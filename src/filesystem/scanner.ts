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

interface MainLog {
  level: string;
  message: string;
  timestamp: string;
}

/** 软删作品超过该天数仍缺失 → 物理清理（级联 + 封面） */
const SCAN_PURGE_DAYS = 30;

export type ScanEvent =
  | {
      type: 'SCAN_TASKS';
      tasks: Array<{ id: number; title: string; status: string }>;
    }
  | {
      type: 'SCAN_FAILED_TASKS';
      failedTasks: Array<{ id: number; title: string; error: string }>;
    }
  | { type: 'SCAN_MAIN_LOGS'; mainLogs: MainLog[] }
  | {
      type: 'SCAN_RESULTS';
      results: {
        total: number;
        added: number;
        updated: number;
        failed: number;
        /** 源缺失被软删的作品数 */
        removed: number;
        /** 软删超期被物理清理的作品数 */
        purged: number;
      };
    }
  | { type: 'SCAN_FINISHED'; message: string }
  | { type: 'SCAN_ERROR'; error: string };

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
  const mainLogs: MainLog[] = [];
  /** 本次扫描在磁盘上发现的全部 RJ 码（含 unsupported-archive：源还在就不算缺失） */
  const onDiskRjCodes = new Set<string>();

  const log = (level: string, message: string): void => {
    mainLogs.push({ level, message, timestamp: new Date().toISOString() });
  };

  const strip = (t: ScanTask) => ({
    id: t.id,
    title: t.title,
    status: t.status,
  });

  log('info', 'Starting scan...');
  yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

  // Scan each root folder to build the task list
  for (const rootFolder of config.rootFolders) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    log(
      'info',
      `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`,
    );
    yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

    const entries = await collectWorkEntries(
      rootFolder.path,
      config.scannerMaxRecursionDepth,
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
        log('error', `Unsupported archive: ${task.title}`);
        yield {
          type: 'SCAN_TASKS',
          tasks: [...tasks, ...failedTasks].map(strip),
        };
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
        log(
          'error',
          `Failed to open: ${entry.rjCode} ${entry.name} - ${errMsg}`,
        );
        yield {
          type: 'SCAN_TASKS',
          tasks: [...tasks, ...failedTasks].map(strip),
        };
        continue;
      }

      if (!hasAudio) {
        log('info', `Skipped (no audio): ${entry.rjCode} ${entry.name}`);
        continue;
      }

      tasks.push({
        id: tasks.length + 1,
        title: `${entry.rjCode} ${entry.name}`,
        relativePath: entry.relativePath,
        rootFolder: rootFolder.name,
        rjCode: entry.rjCode,
        dirName: entry.name,
        status: 'pending',
      });

      yield {
        type: 'SCAN_TASKS',
        tasks: [...tasks, ...failedTasks].map(strip),
      };
    }
  }

  log('info', `Found ${tasks.length} works to scan`);
  yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

  // Process each task
  let added = 0;
  let updated = 0;
  let failed = 0;

  for (const task of tasks) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    try {
      task.status = 'scanning';
      yield {
        type: 'SCAN_TASKS',
        tasks: tasks.map(strip),
      };

      const rjCode = task.rjCode;

      log('info', `Fetching metadata for ${rjCode}...`);
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

      // Fetch metadata from DLsite
      const metadata = await fetchDLsiteWorkInfo(rjCode, signal);

      log('info', `Got metadata: ${metadata.title}`);
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

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
      const coverTypes: CoverType[] = ['main', 'sam', '240x240'];
      for (const type of coverTypes) {
        if (!coverExists(rjCode, type)) {
          log(
            'info',
            `Downloading cover ${type} for ${rjCode} (source: ${coverSourceId})...`,
          );
          yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };

          try {
            const success = await downloadCover(
              rjCode,
              type,
              signal,
              coverSourceId,
            );
            if (success) {
              log('info', `Cover ${type} downloaded for ${rjCode}`);
            } else {
              log('warning', `Failed to download cover ${type} for ${rjCode}`);
            }
          } catch (coverErr) {
            log(
              'warning',
              `Error downloading cover ${type} for ${rjCode}: ${String(coverErr)}`,
            );
          }

          yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };
        }
      }

      if (result.created) {
        added++;
        log('info', `Added: ${rjCode} - ${metadata.title}`);
      } else {
        updated++;
        log('info', `Updated: ${rjCode} - ${metadata.title}`);
      }

      task.status = 'completed';
    } catch (err) {
      task.status = 'failed';
      const errMsg = err instanceof Error ? err.message : String(err);
      task.error = errMsg;
      failedTasks.push(task);
      failed++;

      log('error', `Failed: ${task.title} - ${errMsg}`);
    }

    yield {
      type: 'SCAN_TASKS',
      tasks: tasks.map(strip),
    };
    yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };
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
        log('info', `Removed (source missing): ${id}`);
      } catch (err) {
        log('error', `Failed to soft-delete ${id}: ${String(err)}`);
      }
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };
    }

    for (const id of decision.toHardDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await hardDeleteWork(id);
        purged++;
        log('info', `Purged (source missing beyond grace): ${id}`);
      } catch (err) {
        log('error', `Failed to purge ${id}: ${String(err)}`);
      }
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [...mainLogs] };
    }
  }

  if (removed > 0 || purged > 0) {
    log('info', `Pruned: ${removed} removed, ${purged} purged`);
  }

  // Send final results
  yield {
    type: 'SCAN_RESULTS',
    results: { total: tasks.length, added, updated, failed, removed, purged },
  };

  if (failedTasks.length > 0) {
    yield {
      type: 'SCAN_FAILED_TASKS',
      failedTasks: failedTasks.map((t) => ({
        id: t.id,
        title: t.title,
        error: t.error || 'Unknown error',
      })),
    };
  }
}

/**
 * Manages the scan lifecycle and broadcasts scan events via an EventEmitter.
 * SSE endpoints subscribe to the 'scan' event to push updates to clients.
 */
class ScannerManager extends EventEmitter {
  private currentController: AbortController | null = null;
  private scanning = false;

  get isScanning(): boolean {
    return this.scanning;
  }

  /** Start a scan in the background. Throws if a scan is already running. */
  startScan(config: Config): void {
    if (this.scanning) {
      throw new Error('Scan is already in progress');
    }

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
