// scan 编排器（产源角色，不占池槽）：分流 → 注入 → barrier → 补图殿后 → prune → SUMMARY。
// fail-safe（枚举失败 root 排除 prune）、补图殿后时序、abort 不 prune、scan:all 单飞
// 全部对齐现状（spec §6 / 行为对齐表）。自动接力（autoLoudnessAnalysis）经 chain 参数注入。

import { randomUUID } from 'node:crypto';
import type { Config } from '../../infra/config/schema.js';
import { collectWorkEntries } from '../../infra/fs/utils.js';
import { workSourceResolver } from '../../infra/sources/index.js';
import { MANUAL_PREFIXES } from '../../infra/sources/manual.js';
import {
  type CoverType,
  coverBlobKey,
  listCoverKeys,
  SCAN_COVER_TYPES,
} from '../../services/cover.service.js';
import { listRootFolders } from '../../services/rootFolder.service.js';
import { getWorksByRootFolder } from '../../services/work.service.js';
import { executePrune } from '../prune.js';
import {
  discoverTasks,
  type PendingRoot,
  type ScanCollector,
} from '../scanPipeline.js';
import type { ScanSummaryResults } from '../taskEvents.js';
import { getTaskSystem, type TaskSystem } from '../taskSystem.js';

/** scan 与 update 共用的互斥身份（对齐现状单飞语义）。 */
export const SCAN_ALL_IDENTITY = 'scan:all';

// ---------- 互斥身份（进程内；scan:all 由 scan/update 编排器共用） ----------

const held = new Set<string>();

export function acquireIdentity(id: string): boolean {
  if (held.has(id)) return false;
  held.add(id);
  return true;
}

export function releaseIdentity(id: string): void {
  held.delete(id);
}

/** 路由层预查（409 即时反馈）；真正的占用判定仍在编排器 acquireIdentity（防竞态双跑）。 */
export function isIdentityHeld(id: string): boolean {
  return held.has(id);
}

function abortError(): Error {
  return new DOMException('Scan aborted', 'AbortError');
}

/** 消费 executePrune 的事件流并转批次日志，返回剪除统计。 */
async function drainPrune(
  gen: AsyncGenerator<
    { level: string; message: string },
    { removed: number; purged: number }
  >,
  sys: TaskSystem,
  batchId: string,
): Promise<{ removed: number; purged: number }> {
  let r = await gen.next();
  while (!r.done) {
    sys.log(r.value.level, r.value.message, batchId);
    r = await gen.next();
  }
  return r.value;
}

export interface ScanOrchestrationOptions {
  /** 测试注入；缺省用生产单例（惰性建，池宽读 config）。 */
  sys?: TaskSystem;
  /** scan 正常收尾后的自动接力（autoLoudnessAnalysis → analysis 编排器），fire-and-forget。 */
  chain?: (config: Config, signal: AbortSignal) => Promise<unknown>;
  /** 路由层生成（立即可返回给前端）；缺省内部生成。 */
  batchId?: string;
}

/**
 * 执行一次全库扫描。返回 SUMMARY；null = scan:all 已在跑或被取消。
 * 校验段沿用 discoverTasks（mapPool×8 校验与注入重叠执行，对齐现状吞吐模型）。
 */
export async function runScanOrchestration(
  config: Config,
  signal: AbortSignal,
  options: ScanOrchestrationOptions = {},
): Promise<ScanSummaryResults | null> {
  const sys = options.sys ?? getTaskSystem();
  if (!acquireIdentity(SCAN_ALL_IDENTITY)) return null;
  const batchId = options.batchId ?? `scan-${randomUUID()}`;

  try {
    sys.startBatch('scan', batchId);
    sys.log('info', 'Starting scan...', batchId);

    const collector: ScanCollector = { failedTasks: [] };
    /** 本次扫描在磁盘上发现的全部作品代码（含 unsupported-archive：源还在就不算缺失） */
    const onDiskWorkCodes = new Set<string>();
    /** 本次枚举失败的 root 路径（path 才是 readdir 失败的身份标识） */
    const failedRootPaths = new Set<string>();
    let skipped = 0;
    /** 校验段失败任务数（unsupported / 打不开），对应现状任务池外的失败终态 */
    let checkFailed = 0;
    const pendingRoots: PendingRoot[] = [];
    /** 已知作品中确认缺封面的列表（分流只收集，殿后注入） */
    const coverBackfill: Array<{ id: string; missing: CoverType[] }> = [];

    // 一次性拉取封面 blob key 集合：分流时纯内存比对缺失类型（全库仅 1 次查询）；
    // 拉取失败则放弃本轮补齐自愈（记日志），扫描主流程继续。
    let coverKeys: Set<string>;
    try {
      coverKeys = listCoverKeys();
    } catch (err) {
      coverKeys = new Set();
      sys.log(
        'warning',
        `Cover backfill skipped (failed to list cover blobs): ${
          err instanceof Error ? err.message : String(err)
        }`,
        batchId,
      );
    }

    const roots = await listRootFolders();

    for (const rootFolder of roots) {
      if (signal.aborted) throw abortError();

      if (!rootFolder.path) {
        sys.log(
          'warning',
          `Skipped root folder (path unset): ${rootFolder.name}`,
          batchId,
        );
        continue;
      }

      sys.log(
        'info',
        `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`,
        batchId,
      );

      const collected = await collectWorkEntries(
        rootFolder.path,
        config.scannerMaxRecursionDepth,
        0,
        MANUAL_PREFIXES,
      );
      if (!collected.complete) {
        // 枚举失败 ≠ 目录为空（fail-safe）：该 root 的扫描结果视为未知，
        // 排除出本次 prune，绝不据此软删；error 日志保证可感知。
        const detail = `${collected.failedPath}: ${collected.reason}`;
        failedRootPaths.add(rootFolder.path);
        sys.log(
          'error',
          `Failed to enumerate root folder ${rootFolder.name} (${rootFolder.path}): ${detail} — excluded from pruning`,
          batchId,
        );
        continue;
      }
      const entries = collected.entries;

      const knownWorks = new Map(
        (await getWorksByRootFolder(rootFolder.name)).map((w) => [w.id, w]),
      );

      const pending: PendingRoot['entries'] = [];
      let skippedInRoot = 0;

      for (const entry of entries) {
        if (signal.aborted) throw abortError();

        onDiskWorkCodes.add(entry.workCode);

        const known = knownWorks.get(entry.workCode);
        const isManual =
          workSourceResolver.classify(entry.workCode) === 'manual';
        if (known && known.deletedAt === null) {
          if (known.dir === entry.relativePath) {
            // 已扫描跳过：不建任务不校验（重扫卡顿主因）；缺封面的收集殿后补齐。
            // 手动作品无远端，跳过 DLsite 补图（零网络红线）。
            if (!isManual) {
              const missing = SCAN_COVER_TYPES.filter(
                (type) => !coverKeys.has(coverBlobKey(entry.workCode, type)),
              );
              if (missing.length > 0) {
                coverBackfill.push({ id: entry.workCode, missing });
              }
            }
            skippedInRoot++;
            continue;
          }
          // moved：仅路径变更。DLsite 作品标记 moved 跳过元数据抓取；
          // manual 分支天然零网络且 upsert 更新路径，不走 moved。
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
      sys.log(
        'info',
        `Enumerated ${entries.length} work entries in ${rootFolder.name} (${pending.length} to process, ${skippedInRoot} already scanned)`,
        batchId,
      );

      if (pending.length > 0) {
        pendingRoots.push({
          name: rootFolder.name,
          path: rootFolder.path,
          entries: pending,
        });
      }
    }

    if (skipped > 0) {
      sys.log('info', `Skipped ${skipped} already-scanned works`, batchId);
    }
    sys.log(
      'info',
      `Processing tasks (parallelism ${config.maxParallelism})`,
      batchId,
    );

    // ---------- 校验 + 注入（重叠消费：校验通过即入队排队，不整批等待） ----------
    let rejectedRunning = 0;
    let submitted = 0;
    for await (const out of discoverTasks(pendingRoots, collector, signal)) {
      if (out.kind === 'task') {
        const report = sys.submit(
          [out.workCode],
          ['metadata', 'cover', 'track'],
          {
            priority: 'low',
            batchId,
            mode: 'if-needed',
            ...(out.moved
              ? { variants: { [out.workCode]: 'moved' as const } }
              : {}),
            locations: {
              [out.workCode]: {
                rootFolder: out.rootFolder,
                relativePath: out.relativePath,
                dirName: out.dirName,
                absDir: out.absDir,
              },
            },
          },
        );
        submitted++;
        if (report.rejected.length > 0) {
          rejectedRunning += report.rejected.length;
          sys.log(
            'warning',
            `Skipped (already running): ${out.workCode}`,
            batchId,
            out.workCode,
          );
        }
      } else {
        for (const log of out.logs) {
          sys.log(log.level, log.message, batchId);
        }
        checkFailed += out.failures.length;
      }
    }

    // ---------- barrier：等本批全部作品流水线终态 ----------
    const outcome = await sys.barrier(batchId);

    // ---------- 补图殿后：跳过作品的缺失封面注入（对齐现状「补图自愈殿后」时序） ----------
    if (coverBackfill.length > 0 && !signal.aborted) {
      sys.log(
        'info',
        `Downloading missing covers for ${coverBackfill.length} known works...`,
        batchId,
      );
      sys.submit(
        coverBackfill.map((c) => c.id),
        ['cover'],
        { priority: 'low', batchId, mode: 'force' },
      );
      await sys.barrier(batchId);
    }

    // ---------- prune：清理源文件已消失的作品（软删 + 超期物理删）；abort 不 prune ----------
    let removed = 0;
    let purged = 0;
    if (!signal.aborted) {
      const pruned = await drainPrune(
        executePrune({ roots, onDiskWorkCodes, failedRootPaths, signal }),
        sys,
        batchId,
      );
      removed = pruned.removed;
      purged = pruned.purged;
    }

    // ---------- SUMMARY（服务端直出） ----------
    let added = 0;
    let updated = 0;
    for (const [key, res] of sys.batchResults(batchId)) {
      if (!key.startsWith('metadata:')) continue;
      if (res.created) added++;
      else updated++;
    }
    const summary: ScanSummaryResults = {
      total: submitted,
      added,
      updated,
      failed: checkFailed + outcome.failed + rejectedRunning,
      skipped,
      removed,
      purged,
    };

    const cancelled = signal.aborted;
    sys.finishBatch(batchId, cancelled ? 'cancelled' : 'completed', summary);

    // 自动接力：scan 正常收尾 + chain 存在才触发；失败静默（下一次手动/播放触发兜底）
    if (!cancelled && options.chain) {
      void options.chain(config, signal).catch((err) => {
        console.error('[scan] chained step failed:', err);
      });
    }
    return cancelled ? null : summary;
  } catch (err) {
    // 分流/校验段 abort（discoverTasks/mapPool 抛 AbortError）或意外错误：批次收尾，不 prune
    sys.finishBatch(batchId, signal.aborted ? 'cancelled' : 'failed');
    if (signal.aborted) return null; // 取消语义（对齐签名：null = 在跑或被取消）
    throw err;
  } finally {
    releaseIdentity(SCAN_ALL_IDENTITY);
  }
}
