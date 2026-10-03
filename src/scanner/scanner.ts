import { EventEmitter } from 'node:events';
import type { Config } from '../infra/config/schema.js';
import { collectWorkEntries, type WorkEntry } from '../infra/fs/utils.js';
import { workSourceResolver } from '../infra/sources/index.js';
import { MANUAL_PREFIXES } from '../infra/sources/manual.js';
import {
  type CoverType,
  coverBlobKey,
  downloadCover,
  listCoverKeys,
} from '../services/cover.service.js';
import { listRootFolders } from '../services/rootFolder.service.js';
import {
  getAllWorkRefs,
  getWorksByRootFolder,
} from '../services/work.service.js';
import { analysisManager } from './analysis.js';
import { executePrune } from './prune.js';
import {
  applyScanEvent,
  emitLog,
  emptySnapshot,
  logEvent,
  SCAN_COVER_TYPES,
  SCAN_LOG_CAP,
  type ScanEvent,
  type ScanMode,
  type ScanSnapshot,
  type ScanTask,
  stripTask,
} from './scanEvents.js';
import {
  DISCOVERY_CHECK_PARALLELISM,
  discoverTasks,
  mapPool,
  type PendingRoot,
  runTaskPool,
  type ScanCollector,
} from './scanPipeline.js';
import { runWorkTask } from './workSync.js';

// 公共 API 兼容层：类型与纯函数已按职责拆分到 scanEvents/workSync，
// 此处 re-export 维持既有 import 路径（routes 与测试均从 './scanner.js' 引入）。
export {
  applyScanEvent,
  emptySnapshot,
  SCAN_LOG_CAP,
  type ScanEvent,
  type ScanLogPayload,
  type ScanMode,
  type ScanSnapshot,
  type ScanTask,
  type ScanTaskPayload,
} from './scanEvents.js';
export { syncManualWorkMetadata, syncWorkMetadata } from './workSync.js';

/**
 * Async generator that performs a scan, yielding events as it progresses.
 * Checks the abort signal between operations so the scan can be terminated.
 * 结构：Phase1 分流（本函数内，纯内存/DB 判定）→ 校验流水线与任务池
 * 重叠消费（scanPipeline）→ prune（prune.ts）。
 */
export async function* performScan(
  config: Config,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const collector: ScanCollector = {
    tasks: [],
    failedTasks: [],
    nextTaskId: 0,
  };
  /** 本次扫描在磁盘上发现的全部作品代码（含 unsupported-archive：源还在就不算缺失） */
  const onDiskWorkCodes = new Set<string>();
  /** 本次枚举失败的 root 路径（path 才是 readdir 失败的身份标识） */
  const failedRootPaths = new Set<string>();
  /** 本次因已扫描（路径未变、未软删）而跳过的作品数 */
  let skipped = 0;
  /** 各 root 分流后的待处理条目（校验流水线的输入，与任务池重叠消费） */
  const pendingRoots: PendingRoot[] = [];
  /** 已知作品中确认缺封面的列表（分流只收集，补图延后到任务池之后并发执行） */
  const coverBackfill: Array<{
    id: string;
    sourceId?: string;
    missing: CoverType[];
  }> = [];

  yield* emitLog('info', 'Starting scan...');

  // 一次性拉取封面 blob key 集合：分流时纯内存比对缺失类型，
  // 替代逐作品逐类型的 blobExists 查询风暴（全库仅 1 次查询）。
  // 拉取失败则放弃本轮补齐自愈（记日志），扫描主流程继续。
  let coverKeys: Set<string>;
  try {
    coverKeys = listCoverKeys();
  } catch (err) {
    coverKeys = new Set();
    yield* emitLog(
      'warning',
      `Cover backfill skipped (failed to list cover blobs): ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const roots = await listRootFolders();

  // Scan each root folder to build the task list
  for (const rootFolder of roots) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    if (!rootFolder.path) {
      yield* emitLog(
        'warning',
        `Skipped root folder (path unset): ${rootFolder.name}`,
      );
      continue;
    }

    yield* emitLog(
      'info',
      `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`,
    );

    const collected = await collectWorkEntries(
      rootFolder.path,
      config.scannerMaxRecursionDepth,
      0,
      MANUAL_PREFIXES,
    );
    if (!collected.complete) {
      // 枚举失败 ≠ 目录为空（fail-safe）：该 root 的扫描结果视为未知，
      // 排除出本次 prune，绝不据此软删；失败任务 + error 日志保证可感知。
      // 判别联合收窄后 failedPath/reason 必为 string，无需兜底。
      const detail = `${collected.failedPath}: ${collected.reason}`;
      const task: ScanTask = {
        id: ++collector.nextTaskId,
        title: `${rootFolder.name} (unreadable)`,
        relativePath: rootFolder.path,
        rootFolder: rootFolder.name,
        workCode: '',
        dirName: rootFolder.name,
        status: 'failed',
        error: detail,
      };
      collector.failedTasks.push(task);
      failedRootPaths.add(rootFolder.path);
      yield* emitLog(
        'error',
        `Failed to enumerate root folder ${rootFolder.name} (${rootFolder.path}): ${detail} — excluded from pruning`,
      );
      yield { type: 'SCAN_TASK', task: stripTask(task) };
      continue;
    }
    const entries = collected.entries;

    // 已扫描作品索引：存在且路径未变、未软删的先分流跳过（含封面补图），
    // 其余（新作品/路径变更/软删复活/unsupported）进入校验流水线
    const knownWorks = new Map(
      (await getWorksByRootFolder(rootFolder.name)).map((w) => [w.id, w]),
    );

    /** 分流后待处理的条目；knownSourceId 存在 ⇒ moved（DB 已有未软删、仅路径变更） */
    const pending: PendingRoot['entries'] = [];
    let skippedInRoot = 0;

    for (const entry of entries) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

      // 源文件在磁盘上即计入集合（差集清理的依据），与能否解析/是否有音频无关
      onDiskWorkCodes.add(entry.workCode);

      // 已完成元数据抓取的作品：路径未变且未被软删 → 不建任务、不抓取、不推送，
      // 也不打开源目录校验音频（重扫全库逐作品枚举是网络存储上扫描卡顿的主因）。
      const known = knownWorks.get(entry.workCode);
      const isManual = workSourceResolver.classify(entry.workCode) === 'manual';
      if (known && known.deletedAt === null) {
        if (known.dir === entry.relativePath) {
          // 封面补图延后到流水线：内存比对出缺失类型才入队（齐全的零日志零入队）。
          // 手动作品无远端，跳过 DLsite 补图（零网络红线）。
          if (!isManual) {
            const missing = SCAN_COVER_TYPES.filter(
              (type) => !coverKeys.has(coverBlobKey(entry.workCode, type)),
            );
            if (missing.length > 0) {
              coverBackfill.push({
                id: entry.workCode,
                sourceId: known.sourceId ?? undefined,
                missing,
              });
            }
          }
          skippedInRoot++;
          continue;
        }
        // moved：仅路径变更（如文件夹打包成 zip）。DLsite 作品标记 moved
        // 跳过元数据抓取；manual 分支天然零网络且 upsert 更新路径，不走 moved。
        pending.push({
          entry,
          knownSourceId: isManual ? undefined : known.sourceId,
        });
        continue;
      }

      // 新作品 / 软删复活：完整同步（重抓元数据）
      pending.push({ entry });
    }

    skipped += skippedInRoot;

    yield* emitLog(
      'info',
      `Enumerated ${entries.length} work entries in ${rootFolder.name} (${pending.length} to process, ${skippedInRoot} already scanned)`,
    );

    // 校验延后到流水线阶段：校验通过即入池排队，与处理重叠执行，不整批等待
    if (pending.length > 0) {
      pendingRoots.push({
        name: rootFolder.name,
        path: rootFolder.path,
        entries: pending,
      });
    }
  }

  if (skipped > 0) {
    yield* emitLog('info', `Skipped ${skipped} already-scanned works`);
  }

  yield* emitLog(
    'info',
    `Processing tasks (parallelism ${config.maxParallelism})`,
  );

  // Process each task（有界并发：maxParallelism 控制窗口，防 DLsite 限流保守默认）
  let added = 0;
  let updated = 0;
  let failed = 0;

  yield* runTaskPool(
    discoverTasks(pendingRoots, collector, signal),
    config.maxParallelism,
    async (task) => {
      const { events, created } = await runWorkTask(task, signal);
      if (created === undefined) {
        failed++;
        collector.failedTasks.push(task);
      } else if (created) {
        added++;
      } else {
        updated++;
      }
      return events;
    },
    signal,
  );

  // ---------- 已知作品缺失封面补齐：任务池之后的自愈步骤 ----------
  // 缺失类型已在分流阶段由 blob key 集合内存比对得出，缺失时按需下载（并发）。
  // 新作品/元数据优先，补图自愈殿后，避免大面积缺失时把任务池堵在后面。
  // 每个作品产出结果日志（补了什么 / 404 缺失），透传到前端。
  if (coverBackfill.length > 0) {
    yield* emitLog(
      'info',
      `Downloading missing covers for ${coverBackfill.length} known works...`,
    );
    for await (const events of mapPool(
      coverBackfill,
      DISCOVERY_CHECK_PARALLELISM,
      async (item): Promise<ScanEvent[]> => {
        const downloaded: CoverType[] = [];
        const unavailable: CoverType[] = [];
        for (const type of item.missing) {
          // downloadCover 内部有 blobExists 短路（防入队后竞态重复下载）
          const ok = await downloadCover(item.id, type, signal, item.sourceId);
          if (ok) downloaded.push(type);
          else unavailable.push(type);
        }
        const events: ScanEvent[] = [];
        if (downloaded.length > 0) {
          events.push(
            logEvent(
              'info',
              `Downloaded cover ${downloaded.join(', ')} for ${item.id}`,
            ),
          );
        }
        for (const type of unavailable) {
          events.push(
            logEvent('warning', `Cover ${type} not available for ${item.id}`),
          );
        }
        return events;
      },
      signal,
    )) {
      for (const ev of events) yield ev;
    }
  }

  // ---------- Prune：清理源文件已消失的作品（软删 + 超期物理删） ----------
  const { removed, purged } = yield* executePrune({
    roots,
    onDiskWorkCodes,
    failedRootPaths,
    signal,
  });

  // Send final results
  yield {
    type: 'SCAN_RESULTS',
    results: {
      total: collector.tasks.length,
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
 * update 模式：遍历数据库已有作品，重新抓取 DLsite 元数据并更新，
 * 并顺带做音轨行 diff 回填（与 scan 任务分支共用 runWorkTask 内的同步分支；
 * 已扫描跳过的作品由本模式统一回填兜底）。
 * 对齐原版 PERFORM_UPDATE（updater.js --refreshAll）语义，不扫描文件系统。
 * 导出供测试直接驱动（对齐 performScan）。
 */
export async function* performUpdate(
  // 与 performScan 共用 manager 调用点与现有测试调用约定；
  // update 模式自身只用 maxParallelism（任务池并发度）。
  config: Config,
  signal: AbortSignal,
  /** 可选作品 ID 子集：只刷新这些作品；缺省/undefined 全量 */
  workIds?: string[],
): AsyncGenerator<ScanEvent> {
  yield* emitLog('info', 'Starting metadata update...');

  let refs = await getAllWorkRefs();
  if (workIds) {
    const wanted = new Set(workIds);
    refs = refs.filter((ref) => wanted.has(ref.id));
  }
  yield* emitLog('info', `Found ${refs.length} works in database`);

  let added = 0;
  let updated = 0;
  let failed = 0;
  let taskId = 0;

  const tasks: ScanTask[] = [];
  for (const ref of refs) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    // 手动作品无 DLsite 远端元数据：记日志跳过，不建任务
    if (workSourceResolver.classify(ref.id) === 'manual') {
      yield* emitLog(
        'info',
        `Skipped (manual work, no remote source): ${ref.id}`,
      );
      continue;
    }

    taskId++;
    tasks.push({
      id: taskId,
      title: `${ref.id} ${ref.dir}`,
      relativePath: ref.dir,
      rootFolder: ref.rootFolder,
      workCode: ref.id,
      dirName: ref.dir,
      status: 'pending',
    });
  }

  async function* taskStream(): AsyncGenerator<
    { kind: 'events'; events: ScanEvent[] } | { kind: 'task'; task: ScanTask }
  > {
    for (const task of tasks) yield { kind: 'task', task };
  }

  yield* runTaskPool(
    taskStream(),
    config.maxParallelism,
    async (task) => {
      const { events, created } = await runWorkTask(task, signal);
      if (created === undefined) {
        failed++;
      } else if (created) {
        added++;
      } else {
        updated++;
      }
      return events;
    },
    signal,
  );

  yield {
    type: 'SCAN_RESULTS',
    results: {
      total: refs.length,
      added,
      updated,
      failed,
      skipped: 0,
      removed: 0,
      purged: 0,
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
  startScan(config: Config, mode: ScanMode = 'scan', workIds?: string[]): void {
    if (this.scanning) {
      throw new Error('Scan is already in progress');
    }

    // 新扫描开始时重置快照（携带当前 mode，供重连后区分文案与语义）
    this.snapshot = emptySnapshot(mode);

    // Run async — fire and forget. Errors are handled inside runScan.
    this.runScan(config, mode, workIds).catch((err) => {
      console.error('[Scanner] Unhandled error:', err);
    });
  }

  /** Terminate the current scan. No-op if no scan is running. */
  killScan(): void {
    if (this.currentController) {
      this.currentController.abort();
    }
  }

  private async runScan(
    config: Config,
    mode: ScanMode,
    workIds?: string[],
  ): Promise<void> {
    this.scanning = true;
    this.currentController = new AbortController();
    const signal = this.currentController.signal;

    try {
      const gen =
        mode === 'update'
          ? performUpdate(config, signal, workIds)
          : performScan(config, signal);
      for await (const event of gen) {
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
      // 响度分析自动接力：scan 正常结束 + 自动分析开启才触发；失败静默（下一次手动/播放触发兜底）
      if (mode === 'scan' && !signal.aborted) {
        if (config.autoLoudnessAnalysis) {
          try {
            analysisManager.startAnalysis(config);
          } catch (err) {
            console.error('[Scanner] Failed to chain analysis:', err);
          }
        }
      }
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
