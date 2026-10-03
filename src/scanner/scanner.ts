import { EventEmitter } from 'node:events';
import { join } from 'node:path';
import type { Config } from '../infra/config/schema.js';
import { db } from '../infra/db/main/index.js';
import { circles } from '../infra/db/main/schema.js';
import { folderHasAudio } from '../infra/fs/source/folder.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import { treeHasAudio } from '../infra/fs/source/tree.js';
import { UnsupportedArchiveError } from '../infra/fs/source/types.js';
import { collectWorkEntries, type WorkEntry } from '../infra/fs/utils.js';
import { fetchDLsiteWorkInfo } from '../infra/scraper/dlsite.js';
import { workSourceResolver } from '../infra/sources/index.js';
import { deriveManualTitle, MANUAL_PREFIXES } from '../infra/sources/manual.js';
import {
  type CoverType,
  coverExists,
  downloadCover,
  importLocalCover,
} from '../services/cover.service.js';
import {
  getRootFolderPathByName,
  listRootFolders,
} from '../services/rootFolder.service.js';
import {
  getAllWorkRefs,
  getWorksByRootFolder,
  hardDeleteWork,
  softDeleteWork,
  upsertWork,
} from '../services/work.service.js';
import { analysisManager } from './analysis.js';
import { classifyMissingWorks } from './prune.js';
import { syncWorkTracks } from './trackSync.js';

/** 扫描器模式：scan 扫盘发现新作品；update 遍历数据库刷新既有作品元数据。 */
export type ScanMode = 'scan' | 'update';

interface ScanTask {
  id: number;
  title: string;
  relativePath: string;
  rootFolder: string;
  /** 作品代码（RJ/VJ/UW…，保持原样不规范化） */
  workCode: string;
  dirName: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
  /** 作品目录绝对路径（根目录绝对路径 + relativePath；手动分支导入本地封面用） */
  absDir?: string;
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
  /** 产出该快照的运行模式；缺省视为 'scan' */
  mode?: ScanMode;
}

/** 日志快照保留条数上限 */
export const SCAN_LOG_CAP = 500;

export function emptySnapshot(mode: ScanMode = 'scan'): ScanSnapshot {
  return { tasks: [], failedTasks: [], completed: 0, logs: [], mode };
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

/** 单条日志事件构造（模块级，scan/update 两模式共享；顺序 yield* 与并发收集共用）。 */
const logEvent = (level: string, message: string): ScanEvent => ({
  type: 'SCAN_LOG',
  log: { level, message, timestamp: new Date().toISOString() },
});

/** 单条日志事件 generator（logEvent 的 yield* 包装）。 */
const emitLog = function* (
  level: string,
  message: string,
): Generator<ScanEvent, void, unknown> {
  yield logEvent(level, message);
};

/** 任务快照（模块级，两模式共享）。 */
const stripTask = (t: ScanTask): ScanTaskPayload => ({
  id: t.id,
  title: t.title,
  status: t.status,
  error: t.error,
});

/**
 * 抓取并持久化单个作品的 DLsite 元数据（upsert + 补缺失封面）。
 * scan 与 update 两种模式共用；yield 事件流（日志即时推送），
 * return 值携带结果供调用方计数；失败时抛错，由调用方记 failed task。
 */
export async function* syncWorkMetadata(
  rjCode: string,
  rootFolder: string,
  relativePath: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  yield* emitLog('info', `Fetching metadata for ${rjCode}...`);

  // Fetch metadata from DLsite
  const metadata = await fetchDLsiteWorkInfo(rjCode, signal);

  yield* emitLog('info', `Got metadata: ${metadata.title}`);

  // Write to database (dir = relativePath, not dirName)
  const result = await upsertWork({
    id: rjCode,
    rootFolder,
    dir: relativePath,
    title: metadata.title,
    circleName: metadata.circle || 'Unknown',
    circleId: metadata.circleId || undefined,
    ageRating: metadata.ageRating,
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
    rank: metadata.rank.length > 0 ? metadata.rank : undefined,
    tags: metadata.tags,
    vas: metadata.vas,
    series: metadata.series,
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
      yield* emitLog(
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
          yield* emitLog('info', `Cover ${type} downloaded for ${rjCode}`);
        } else {
          yield* emitLog(
            'warning',
            `Failed to download cover ${type} for ${rjCode}`,
          );
        }
      } catch (coverErr) {
        yield* emitLog(
          'warning',
          `Error downloading cover ${type} for ${rjCode}: ${String(coverErr)}`,
        );
      }
    }
  }

  return { title: metadata.title, created: result.created };
}

/**
 * 手动作品（非 DLsite）元数据同步：与 syncWorkMetadata 同构的 AsyncGenerator，
 * 但全程零网络——标题由目录名推导（deriveManualTitle），社团落 unknown 占位行，
 * 封面只从作品目录导入本地图片（importLocalCover）。
 * 音轨回填镜像 syncWorkMetadataAndTracks 的 syncWorkTracks 部分。
 */
export async function* syncManualWorkMetadata(
  workCode: string,
  rootFolder: string,
  relativePath: string,
  folderName: string,
  absDir: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

  // 标题全部本地推导：去掉作品代码后的剩余部分，不访问任何远端
  const title = deriveManualTitle(folderName, workCode);
  yield* emitLog('info', `Manual work ${workCode}: ${title}`);

  // unknown 占位社团行（镜像 migration/kikoeru.ts 的 unknown 兕底），幂等
  await db
    .insert(circles)
    .values({ id: 'unknown', name: 'unknown' })
    .onConflictDoNothing();

  const result = await upsertWork({
    id: workCode,
    title,
    rootFolder,
    dir: relativePath,
    circleName: 'unknown',
    circleId: 'unknown',
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to save work');
  }

  // 本地封面导入（cover.* / folder.*；目录无图片则静默跳过，不判任务失败）
  try {
    const imported = await importLocalCover(workCode, absDir);
    if (imported) {
      yield* emitLog('info', `Local cover imported for ${workCode}`);
    } else {
      yield* emitLog('warning', `No local cover found for ${workCode}`);
    }
  } catch (coverErr) {
    yield* emitLog(
      'warning',
      `Error importing local cover for ${workCode}: ${String(coverErr)}`,
    );
  }

  // 音轨行回填（镜像 syncWorkMetadataAndTracks）：失败仅记 warning，不判任务失败
  try {
    const rootPath = await getRootFolderPathByName(rootFolder);
    if (!rootPath) {
      yield* emitLog(
        'warning',
        `Track sync skipped, root folder not found: ${rootFolder}`,
      );
    } else {
      const source = await openWorkSource(rootPath, relativePath);
      await syncWorkTracks(workCode, source, await source.buildTree());
    }
  } catch (err) {
    yield* emitLog(
      'warning',
      `Track sync failed for ${workCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { title, created: result.created };
}

/**
 * 单作品完整同步：DLsite 元数据（upsert + 补封面）+ 音轨时长 diff 回填。
 * scan 任务分支与 update 模式共用的动作集合；音轨同步失败仅记 warning 日志，
 * 不判任务失败（DLsite 元数据已保存）。
 */
async function* syncWorkMetadataAndTracks(
  rjCode: string,
  rootFolder: string,
  relativePath: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  const metaGen = syncWorkMetadata(rjCode, rootFolder, relativePath, signal);
  let r = await metaGen.next();
  while (!r.done) {
    yield r.value;
    r = await metaGen.next();
  }

  // 音轨行回填：size diff → 仅对新增/变更条目探测时长；失败不判任务失败
  try {
    const rootPath = await getRootFolderPathByName(rootFolder);
    if (!rootPath) {
      yield* emitLog(
        'warning',
        `Track sync skipped, root folder not found: ${rootFolder}`,
      );
    } else {
      const source = await openWorkSource(rootPath, relativePath);
      await syncWorkTracks(rjCode, source, await source.buildTree());
    }
  } catch (err) {
    yield* emitLog(
      'warning',
      `Track sync failed for ${rjCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return r.value;
}

/**
 * 单任务执行体（并发池 worker 调用）：DLsite 元数据 + 音轨同步，
 * 事件缓冲为整组返回（避免跨任务交错，快照与日志按任务成组）。
 * created 缺省表示任务失败（错误已写入 task.error 并包含在事件里）；
 * added/updated/failed 计数由调用方按返回值累计。
 */
async function runWorkTask(
  task: ScanTask,
  signal: AbortSignal,
): Promise<{ events: ScanEvent[]; created?: boolean }> {
  const events: ScanEvent[] = [];
  task.status = 'scanning';
  events.push({ type: 'SCAN_TASK', task: stripTask(task) });

  try {
    // 手动作品走本地同步分支（零网络），其余走 DLsite 抓取。
    const gen =
      workSourceResolver.classify(task.workCode) === 'manual'
        ? syncManualWorkMetadata(
            task.workCode,
            task.rootFolder,
            task.relativePath,
            task.dirName,
            task.absDir ?? '',
            signal,
          )
        : syncWorkMetadataAndTracks(
            task.workCode,
            task.rootFolder,
            task.relativePath,
            signal,
          );
    let r = await gen.next();
    while (!r.done) {
      events.push(r.value);
      r = await gen.next();
    }
    const { title, created } = r.value;
    if (created) {
      events.push(logEvent('info', `Added: ${task.workCode} - ${title}`));
    } else {
      events.push(logEvent('info', `Updated: ${task.workCode} - ${title}`));
    }

    task.status = 'completed';
    events.push({ type: 'SCAN_TASK', task: stripTask(task) });
    return { events, created };
  } catch (err) {
    task.status = 'failed';
    const errMsg = err instanceof Error ? err.message : String(err);
    task.error = errMsg;
    events.push(logEvent('error', `Failed: ${task.title} - ${errMsg}`));
    events.push({ type: 'SCAN_TASK', task: stripTask(task) });
    return { events };
  }
}

/**
 * 有界并发任务池：保持提交顺序的滑动窗口。
 * maxParallelism 控制同时在飞的任务数（DLsite 抓取受其限流约束，默认保守）；
 * 各任务的事件组按提交顺序 yield（确定性输出，快照/测试友好）；
 * abort 时停止提交新任务并传播 AbortError（in-flight 任务由各自 catch 收尾）。
 */
async function* runTaskPool(
  items: readonly ScanTask[],
  parallelism: number,
  runTask: (task: ScanTask) => Promise<ScanEvent[]>,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const width = Math.max(1, Math.min(parallelism, items.length));
  if (items.length > 0) {
    yield* emitLog(
      'info',
      `Processing ${items.length} tasks (parallelism ${width})`,
    );
  }
  const inflight: Promise<ScanEvent[]>[] = [];
  for (const item of items) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
    inflight.push(runTask(item));
    if (inflight.length >= width) {
      for (const ev of await inflight.shift()!) yield ev;
    }
  }
  while (inflight.length > 0) {
    for (const ev of await inflight.shift()!) yield ev;
  }
}

/**
 * Async generator that performs a scan, yielding events as it progresses.
 * Checks the abort signal between operations so the scan can be terminated.
 * 任务分支（新作品/路径变更）走完整同步流程（元数据 + 音轨时长）；
 * 已扫描跳过的作品不同步，由 update 模式统一回填兜底。
 */
export async function* performScan(
  config: Config,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const tasks: ScanTask[] = [];
  const failedTasks: ScanTask[] = [];
  /** 本次扫描在磁盘上发现的全部作品代码（含 unsupported-archive：源还在就不算缺失） */
  const onDiskWorkCodes = new Set<string>();
  /** 本次枚举失败的 root 路径（path 才是 readdir 失败的身份标识） */
  const failedRootPaths = new Set<string>();
  /** 本次因已扫描（路径未变、未软删）而跳过的作品数 */
  let skipped = 0;

  yield* emitLog('info', 'Starting scan...');

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
        id: tasks.length + failedTasks.length + 1,
        title: `${rootFolder.name} (unreadable)`,
        relativePath: rootFolder.path,
        rootFolder: rootFolder.name,
        workCode: '',
        dirName: rootFolder.name,
        status: 'failed',
        error: detail,
      };
      failedTasks.push(task);
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
    // 其余（新作品/路径变更/软删复活/unsupported）进入逐条处理
    const knownWorks = new Map(
      (await getWorksByRootFolder(rootFolder.name)).map((w) => [w.id, w]),
    );

    /** 分流后待逐条处理的条目 */
    const pending: WorkEntry[] = [];
    let skippedInRoot = 0;

    for (const entry of entries) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

      // 源文件在磁盘上即计入集合（差集清理的依据），与能否解析/是否有音频无关
      onDiskWorkCodes.add(entry.workCode);

      // 已完成元数据抓取的作品：路径未变且未被软删 → 不建任务、不抓取、不推送，
      // 也不打开源目录校验音频（重扫全库逐作品枚举是网络存储上扫描卡顿的主因），
      // 仅静默补下缺失封面（本地 blob 检查 + 按需下载；sam 等 404 快速失败）。
      // 手动作品无远端，跳过 DLsite 补图（零网络红线）。
      const known = knownWorks.get(entry.workCode);
      if (
        known &&
        known.deletedAt === null &&
        known.dir === entry.relativePath
      ) {
        if (workSourceResolver.classify(entry.workCode) !== 'manual') {
          for (const type of SCAN_COVER_TYPES) {
            if (!coverExists(entry.workCode, type)) {
              await downloadCover(
                entry.workCode,
                type,
                signal,
                known.sourceId ?? undefined,
              );
            }
          }
        }
        skippedInRoot++;
        continue;
      }

      pending.push(entry);
    }

    skipped += skippedInRoot;

    yield* emitLog(
      'info',
      `Enumerated ${entries.length} work entries in ${rootFolder.name} (${pending.length} to process, ${skippedInRoot} already scanned)`,
    );

    for (const entry of pending) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

      // unsupported-archive: 明确失败而非静默跳过
      if (entry.kind === 'unsupported-archive') {
        const task: ScanTask = {
          id: tasks.length + failedTasks.length + 1,
          title: `${entry.workCode} ${entry.name}`,
          relativePath: entry.relativePath,
          rootFolder: rootFolder.name,
          workCode: entry.workCode,
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
        yield* emitLog('error', `Unsupported archive: ${task.title}`);
        // 收集期失败即时下发，替代原全量任务表推送
        yield { type: 'SCAN_TASK', task: stripTask(task) };
        continue;
      }

      // 新作品/路径变更/软删复活：校验含音频才建任务。
      // folder 用可提前退出的轻量遍历（首个可服务音频即返回，避免全量建树）；
      // archive 仍打开 source 建索引后建树（索引是后续读取的前提）。
      let hasAudio = false;
      try {
        if (entry.kind === 'folder') {
          hasAudio = await folderHasAudio(
            join(rootFolder.path, entry.relativePath),
          );
        } else {
          const source = await openWorkSource(
            rootFolder.path,
            entry.relativePath,
          );
          hasAudio = treeHasAudio(await source.buildTree());
        }
      } catch (err) {
        // 打不开/不支持的包：作为失败任务上报
        const errMsg = err instanceof Error ? err.message : String(err);
        const task: ScanTask = {
          id: tasks.length + failedTasks.length + 1,
          title: `${entry.workCode} ${entry.name}`,
          relativePath: entry.relativePath,
          rootFolder: rootFolder.name,
          workCode: entry.workCode,
          dirName: entry.name,
          status: 'failed',
          error: errMsg,
        };
        failedTasks.push(task);
        yield* emitLog(
          'error',
          `Failed to open: ${entry.workCode} ${entry.name} - ${errMsg}`,
        );
        yield { type: 'SCAN_TASK', task: stripTask(task) };
        continue;
      }

      if (!hasAudio) {
        // 无音频只记日志，不产生任务事件
        yield* emitLog(
          'info',
          `Skipped (no audio): ${entry.workCode} ${entry.name}`,
        );
        continue;
      }

      const task: ScanTask = {
        id: tasks.length + 1,
        title: `${entry.workCode} ${entry.name}`,
        relativePath: entry.relativePath,
        rootFolder: rootFolder.name,
        workCode: entry.workCode,
        dirName: entry.name,
        status: 'pending',
        // 手动分支导入本地封面需要绝对路径（根目录绝对路径 + relativePath）
        absDir: join(rootFolder.path, entry.relativePath),
      };
      tasks.push(task);
      yield { type: 'SCAN_TASK', task: stripTask(task) };
    }
  }

  yield* emitLog('info', `Found ${tasks.length} works to scan`);

  if (skipped > 0) {
    yield* emitLog('info', `Skipped ${skipped} already-scanned works`);
  }

  // Process each task（有界并发：maxParallelism 控制窗口，防 DLsite 限流保守默认）
  let added = 0;
  let updated = 0;
  let failed = 0;

  yield* runTaskPool(
    tasks,
    config.maxParallelism,
    async (task) => {
      const { events, created } = await runWorkTask(task, signal);
      if (created === undefined) {
        failed++;
        failedTasks.push(task);
      } else if (created) {
        added++;
      } else {
        updated++;
      }
      return events;
    },
    signal,
  );

  // ---------- Prune：清理源文件已消失的作品（软删 + 超期物理删） ----------
  let removed = 0;
  let purged = 0;

  // DB 作品按 root 名归属（getWorksByRootFolder）。name 是主键，一个名字只对应
  // 一条路径，枚举失败的根按 path 跳过它自己即可。
  for (const rootFolder of roots) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

    if (!rootFolder.path || failedRootPaths.has(rootFolder.path)) continue;

    const inDb = await getWorksByRootFolder(rootFolder.name);
    if (inDb.length === 0) continue;

    const decision = classifyMissingWorks(
      inDb,
      onDiskWorkCodes,
      new Date(),
      SCAN_PURGE_DAYS,
    );

    for (const id of decision.toSoftDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await softDeleteWork(id);
        removed++;
        yield* emitLog('info', `Removed (source missing): ${id}`);
      } catch (err) {
        yield* emitLog('error', `Failed to soft-delete ${id}: ${String(err)}`);
      }
    }

    for (const id of decision.toHardDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await hardDeleteWork(id);
        purged++;
        yield* emitLog('info', `Purged (source missing beyond grace): ${id}`);
      } catch (err) {
        yield* emitLog('error', `Failed to purge ${id}: ${String(err)}`);
      }
    }
  }

  // 无清理也打：日志闭环（0/0 说明 prune 跑过且无事发生）
  yield* emitLog('info', `Pruned: ${removed} removed, ${purged} purged`);

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
 * update 模式：遍历数据库已有作品，重新抓取 DLsite 元数据并更新，
 * 并顺带做音轨行 diff 回填（与 scan 任务分支共用 syncWorkMetadataAndTracks；
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

  yield* runTaskPool(
    tasks,
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
