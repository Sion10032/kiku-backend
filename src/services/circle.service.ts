import { and, eq, inArray } from 'drizzle-orm';
import type { db } from '../infra/db/main/index.js';
import { circles, favourites } from '../infra/db/main/schema.js';

/** 事务上下文类型（与 metadataOverride.service.ts 共用同一来源）。 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** DLsite maker_id：RG/VG + 5 或 8 位数字。 */
const MAKER_ID_RE = /^(?:RG|VG)(?:\d{5}|\d{8})$/;

/** 归一化抓取/传入的 maker_id；空串与不合法形态一律视同未知。 */
export function normalizeMakerId(
  raw: string | null | undefined,
): string | undefined {
  const value = raw?.trim();
  return value && MAKER_ID_RE.test(value) ? value : undefined;
}

/**
 * 解析（必要时创建）circle 行。**必须在事务内调用**：可能原地升级主键。
 *
 * 1. 有 maker_id → 按 id 精确命中，顺带回写名字变更；
 * 2. 未命中 → 按 name 命中：
 *    - 命中的是占位 id（非 maker_id 形态）且本次有 maker_id → 原地升级（见 upgradeCircleId）；
 *    - 命中的是另一个合法 maker_id（同名不同社团）→ 不合并，落到第 3 步另建行；
 * 3. 都没有 → 以 `maker_id ?? name` 作 id 插入（PK 冲突时按 id 重查兜底）。
 */
export function resolveCircle(
  tx: Tx,
  input: { name: string; circleId?: string | null },
): { id: string; name: string } {
  const makerId = normalizeMakerId(input.circleId);

  if (makerId) {
    const byId = tx.select().from(circles).where(eq(circles.id, makerId)).get();
    if (byId) {
      if (byId.name !== input.name) {
        tx.update(circles)
          .set({ name: input.name })
          .where(eq(circles.id, makerId))
          .run();
      }
      return { id: makerId, name: input.name };
    }
  }

  const byName = tx
    .select()
    .from(circles)
    .where(eq(circles.name, input.name))
    .get();
  if (byName) {
    if (!makerId || byName.id === makerId) {
      return { id: byName.id, name: byName.name };
    }
    if (!MAKER_ID_RE.test(byName.id)) {
      upgradeCircleId(tx, byName.id, makerId);
      return { id: makerId, name: input.name };
    }
    // 同名但已是另一个 maker_id：视为不同社团，继续走插入分支。
  }

  const id = makerId ?? input.name;
  tx.insert(circles)
    .values({ id, name: input.name })
    .onConflictDoNothing()
    .run();
  const row = tx.select().from(circles).where(eq(circles.id, id)).get();
  if (!row) throw new Error(`circle resolve failed: ${input.name}`);
  return { id: row.id, name: row.name };
}

/**
 * 占位 id → 真实 maker_id：PK 原地升级。
 * works / t_work_meta_override 由 FK ON UPDATE CASCADE 自动跟随；
 * t_favourite 无 FK，需手动改指（冲突时保留目标、丢弃旧行）。
 */
function upgradeCircleId(tx: Tx, from: string, to: string): void {
  const dupUsers = tx
    .select({ user: favourites.userName })
    .from(favourites)
    .where(
      and(eq(favourites.targetType, 'circle'), eq(favourites.targetId, to)),
    )
    .all()
    .map((r) => r.user);

  if (dupUsers.length > 0) {
    tx.delete(favourites)
      .where(
        and(
          eq(favourites.targetType, 'circle'),
          eq(favourites.targetId, from),
          inArray(favourites.userName, dupUsers),
        ),
      )
      .run();
  }
  tx.update(favourites)
    .set({ targetId: to })
    .where(
      and(eq(favourites.targetType, 'circle'), eq(favourites.targetId, from)),
    )
    .run();
  tx.update(circles).set({ id: to }).where(eq(circles.id, from)).run();
}
