/**
 * 扫描后「源缺失」清理的纯函数。
 *
 * 输入为数据库中的作品记录与本次扫描在磁盘上发现的 RJ 码集合，
 * 输出缺失作品的分类处理决策，不含任何 IO，便于单元测试。
 */

import {
  getWorksByRootFolder,
  hardDeleteWork,
  softDeleteWork,
} from '../services/work.service.js';
import type { DiscoveryLog } from './scanPipeline.js';

export interface WorkRowForPrune {
  id: string;
  deletedAt: string | null;
}

export interface PruneDecision {
  /** 源缺失且未软删标记 → 需要执行软删（置 deletedAt） */
  toSoftDelete: string[];
  /** 源缺失、已软删且超过宽限期 → 需要执行物理删除（级联 + 清封面） */
  toHardDelete: string[];
  /** 源缺失、已软删但在宽限期内 → 保持软删，本次不处理 */
  inGrace: string[];
}

/**
 * 将数据库作品按「源是否仍在磁盘」与「软删标记 + 宽限期」分类。
 *
 * @param inDb 数据库记录（至少含 id 与 deletedAt）
 * @param onDiskRjCodes 本次扫描在磁盘上发现的全部 RJ 码（含 unsupported-archive，源还在就不算缺失）
 * @param now 当前时间（便于测试注入）
 * @param graceDays 软删后物理清理的宽限期天数（须严格超过才物理删）
 */
export function classifyMissingWorks(
  inDb: WorkRowForPrune[],
  onDiskRjCodes: Set<string>,
  now: Date,
  graceDays: number,
): PruneDecision {
  const toSoftDelete: string[] = [];
  const toHardDelete: string[] = [];
  const inGrace: string[] = [];

  for (const row of inDb) {
    if (onDiskRjCodes.has(row.id)) continue;

    if (row.deletedAt === null) {
      toSoftDelete.push(row.id);
      continue;
    }

    const deletedTime = Date.parse(row.deletedAt);
    const expired =
      !Number.isNaN(deletedTime) &&
      now.getTime() - deletedTime > graceDays * 24 * 60 * 60 * 1000;
    if (expired) {
      toHardDelete.push(row.id);
    } else {
      inGrace.push(row.id);
    }
  }

  return { toSoftDelete, toHardDelete, inGrace };
}

/** 软删作品超过该天数仍缺失 → 物理清理（级联 + 封面） */
export const SCAN_PURGE_DAYS = 30;

/**
 * Prune 执行阶段：逐 root 差集清理源已消失的作品（软删 + 超期物理删）。
 * 枚举失败的 root（failedRootPaths）整体跳过，绝不据此软删（fail-safe）。
 * yield 过程日志，return 计数供 SCAN_RESULTS 汇总。
 */
export async function* executePrune(options: {
  roots: Array<{ name: string; path: string | null }>;
  onDiskWorkCodes: Set<string>;
  failedRootPaths: Set<string>;
  signal: AbortSignal;
}): AsyncGenerator<DiscoveryLog, { removed: number; purged: number }> {
  const { roots, onDiskWorkCodes, failedRootPaths, signal } = options;
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
        yield { level: 'info', message: `Removed (source missing): ${id}` };
      } catch (err) {
        yield {
          level: 'error',
          message: `Failed to soft-delete ${id}: ${String(err)}`,
        };
      }
    }

    for (const id of decision.toHardDelete) {
      if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
      try {
        await hardDeleteWork(id);
        purged++;
        yield {
          level: 'info',
          message: `Purged (source missing beyond grace): ${id}`,
        };
      } catch (err) {
        yield {
          level: 'error',
          message: `Failed to purge ${id}: ${String(err)}`,
        };
      }
    }
  }

  // 无清理也打：日志闭环（0/0 说明 prune 跑过且无事发生）
  yield {
    level: 'info',
    message: `Pruned: ${removed} removed, ${purged} purged`,
  };

  return { removed, purged };
}
