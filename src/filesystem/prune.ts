/**
 * 扫描后「源缺失」清理的纯函数。
 *
 * 输入为数据库中的作品记录与本次扫描在磁盘上发现的 RJ 码集合，
 * 输出缺失作品的分类处理决策，不含任何 IO，便于单元测试。
 */

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
