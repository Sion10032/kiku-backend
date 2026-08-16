import { EventEmitter } from 'events';
import type { Config } from '../config/schema.js';
import { getFolderList, getTrackList } from './utils.js';
import { fetchDLsiteWorkInfo } from '../scraper/dlsite.js';
import { upsertWork } from '../services/work.service.js';
import { downloadCover, coverExists, type CoverType } from '../services/cover.service.js';

interface ScanTask {
  id: number;
  title: string;
  folderPath: string;
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

export type ScanEvent =
  | { type: 'SCAN_TASKS'; tasks: Array<{ id: number; title: string; status: string; }>; }
  | { type: 'SCAN_FAILED_TASKS'; failedTasks: Array<{ id: number; title: string; error: string; }>; }
  | { type: 'SCAN_MAIN_LOGS'; mainLogs: MainLog[]; }
  | { type: 'SCAN_RESULTS'; results: { total: number; added: number; updated: number; failed: number; }; }
  | { type: 'SCAN_FINISHED'; message: string; }
  | { type: 'SCAN_ERROR'; error: string; };

/**
 * Async generator that performs a scan, yielding events as it progresses.
 * Checks the abort signal between operations so the scan can be terminated.
 */
async function* performScan(config: Config, signal: AbortSignal): AsyncGenerator<ScanEvent> {
  const tasks: ScanTask[] = [];
  const failedTasks: ScanTask[] = [];
  const mainLogs: MainLog[] = [];

  const log = (level: string, message: string): void => {
    mainLogs.push({ level, message, timestamp: new Date().toISOString() });
  };

  log('info', 'Starting scan...');
  yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

  // Scan each root folder to build the task list
  for (const rootFolder of config.rootFolders) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    log('info', `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`);
    yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

    const folders = await getFolderList(rootFolder.path, config.scannerMaxRecursionDepth);

    for (const folder of folders) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

      // Skip folders without RJ code
      if (folder.rjCode === null) continue;

      const tracks = await getTrackList(folder.path);

      if (tracks.length > 0) {
        const task: ScanTask = {
          id: tasks.length + 1,
          title: `${folder.rjCode} ${folder.dirName}`,
          folderPath: folder.path,
          rootFolder: rootFolder.name,
          rjCode: folder.rjCode,
          dirName: folder.dirName,
          status: 'pending',
        };

        tasks.push(task);

        yield {
          type: 'SCAN_TASKS',
          tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
        };
      }
    }
  }

  log('info', `Found ${tasks.length} works to scan`);
  yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

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
        tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      };

      const rjCode = task.rjCode;

      log('info', `Fetching metadata for ${rjCode}...`);
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

      // Fetch metadata from DLsite
      const metadata = await fetchDLsiteWorkInfo(rjCode, signal);

      log('info', `Got metadata: ${metadata.title}`);
      yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

      // Write to database
      const result = await upsertWork({
        id: rjCode,
        rootFolder: task.rootFolder,
        dir: task.dirName,
        title: metadata.title,
        circleName: metadata.circle || 'Unknown',
        nsfw: metadata.nsfw,
        release: metadata.releaseDate || undefined,
        dlCount: metadata.dlCount || undefined,
        price: metadata.price || undefined,
        reviewCount: metadata.reviewCount || undefined,
        rateCount: metadata.rateCount || undefined,
        rateAverage2dp: metadata.rateAverage || undefined,
        rateCountDetail: Object.keys(metadata.rateCountDetail).length > 0 ? metadata.rateCountDetail : undefined,
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
      const coverTypes: CoverType[] = [ 'main', 'sam', '240x240' ];
      for (const type of coverTypes) {
        if (!coverExists(rjCode, type)) {
          log('info', `Downloading cover ${type} for ${rjCode} (source: ${coverSourceId})...`);
          yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };

          try {
            const success = await downloadCover(rjCode, type, signal, coverSourceId);
            if (success) {
              log('info', `Cover ${type} downloaded for ${rjCode}`);
            }
            else {
              log('warning', `Failed to download cover ${type} for ${rjCode}`);
            }
          }
          catch (coverErr) {
            log('warning', `Error downloading cover ${type} for ${rjCode}: ${String(coverErr)}`);
          }

          yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };
        }
      }

      if (result.created) {
        added++;
        log('info', `Added: ${rjCode} - ${metadata.title}`);
      }
      else {
        updated++;
        log('info', `Updated: ${rjCode} - ${metadata.title}`);
      }

      task.status = 'completed';
    }
    catch (err) {
      task.status = 'failed';
      task.error = String(err);
      failedTasks.push(task);
      failed++;

      log('error', `Failed: ${task.title} - ${String(err)}`);
    }

    yield {
      type: 'SCAN_TASKS',
      tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    };
    yield { type: 'SCAN_MAIN_LOGS', mainLogs: [ ...mainLogs ] };
  }

  // Send final results
  yield {
    type: 'SCAN_RESULTS',
    results: { total: tasks.length, added, updated, failed },
  };

  if (failedTasks.length > 0) {
    yield {
      type: 'SCAN_FAILED_TASKS',
      failedTasks: failedTasks.map(t => ({ id: t.id, title: t.title, error: t.error || 'Unknown error' })),
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
      this.emit('scan', { type: 'SCAN_FINISHED', message: 'Scan completed successfully' });
    }
    catch (err) {
      if (signal.aborted) {
        this.emit('scan', { type: 'SCAN_FINISHED', message: 'Scan was terminated' });
      }
      else {
        this.emit('scan', { type: 'SCAN_ERROR', error: String(err) });
      }
    }
    finally {
      this.scanning = false;
      this.currentController = null;
    }
  }
}

export const scanner = new ScannerManager();
