import { and, eq, sql } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  series,
  tags,
  tagWork,
  tagWorkOverride,
  vas,
  vaWork,
  vaWorkOverride,
  vTagWork,
  vVaWork,
  workMetaOverride,
  works,
} from '../infra/db/main/schema.js';

export const OVERRIDE_FIELDS = [
  'title',
  'circle',
  'series',
  'ageRating',
  'tags',
  'vas',
] as const;
export type MetadataField = (typeof OVERRIDE_FIELDS)[number];

export class OverrideNotFoundError extends Error {
  constructor(workId: string) {
    super(`Work ${workId} not found`);
    this.name = 'OverrideNotFoundError';
  }
}

/** PATCH 请求体（service 层口径）：字段缺席 = 不动；显式 null = 恢复该字段。 */
export type SaveMetadataOverrideInput = {
  title?: string | null;
  circleName?: string | null;
  seriesName?: string | null;
  ageRating?: 'all' | 'r15' | 'r18' | null;
  tagsCleared?: boolean;
  vasCleared?: boolean;
  /** 新增标签（按名；维度表按名 upsert，新条目不随恢复删除） */
  addTags?: string[];
  /** 移除标签（按 id；若该 id 是先前 add 的则撤销该行而非标记 remove） */
  removeTagIds?: number[];
  addVas?: Array<{ id?: string; name: string }>;
  removeVaIds?: string[];
  updatedBy?: string;
};

// bun:sqlite 是同步驱动：事务回调必须同步（async 回调会在首个 await 后被提前 commit，
// 见 kikoeru.ts / blob/index.ts 的既有事务用法），事务体内用 .get()/.all()/.run() 终结。
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

// ---------- 维度表按名 upsert（事务内执行；新条目留在共享维度表，不随恢复删除） ----------

function upsertCircleByName(tx: Tx, name: string): number {
  const found = tx
    .select({ id: circles.id })
    .from(circles)
    .where(eq(circles.name, name))
    .get();
  if (found) return found.id;
  const inserted = tx
    .insert(circles)
    .values({ name })
    .returning({ id: circles.id })
    .get();
  if (!inserted) throw new Error(`circle upsert failed: ${name}`);
  return inserted.id;
}

function upsertSeriesByName(tx: Tx, name: string): string {
  const found = tx
    .select({ id: series.id })
    .from(series)
    .where(eq(series.name, name))
    .get();
  if (found) return found.id;
  // 手工新增的系列没有 DLsite SRI 编号，以名字作 id（t_series.id 为 text）
  const inserted = tx
    .insert(series)
    .values({ id: name, name })
    .returning({ id: series.id })
    .get();
  if (!inserted) throw new Error(`series upsert failed: ${name}`);
  return inserted.id;
}

function upsertTagByName(tx: Tx, name: string): number {
  const found = tx
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, name))
    .get();
  if (found) return found.id;
  const inserted = tx
    .insert(tags)
    .values({ name })
    .returning({ id: tags.id })
    .get();
  if (!inserted) throw new Error(`tag upsert failed: ${name}`);
  return inserted.id;
}

function upsertVa(tx: Tx, input: { id?: string; name: string }): string {
  const byName = tx
    .select({ id: vas.id })
    .from(vas)
    .where(eq(vas.name, input.name))
    .get();
  if (byName) return byName.id;
  if (input.id) {
    const byId = tx
      .select({ id: vas.id })
      .from(vas)
      .where(eq(vas.id, input.id))
      .get();
    if (byId) return byId.id;
    tx.insert(vas).values({ id: input.id, name: input.name }).run();
    return input.id;
  }
  // 无 DLsite 声优 id 的手工条目：以名字作 id（t_va.id 为 text）
  tx.insert(vas).values({ id: input.name, name: input.name }).run();
  return input.name;
}

/** 覆盖行无任何有效内容时删除主行，维持「存在即有覆盖」语义。 */
function pruneIfEmpty(tx: Tx, workId: string): void {
  const row = tx
    .select()
    .from(workMetaOverride)
    .where(eq(workMetaOverride.workId, workId))
    .get();
  if (!row) return;
  const tagActions =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(tagWorkOverride)
      .where(eq(tagWorkOverride.workId, workId))
      .get()?.n ?? 0;
  const vaActions =
    tx
      .select({ n: sql<number>`count(*)` })
      .from(vaWorkOverride)
      .where(eq(vaWorkOverride.workId, workId))
      .get()?.n ?? 0;
  const hasScalar =
    row.title !== null ||
    row.circleId !== null ||
    row.seriesId !== null ||
    row.ageRating !== null;
  const hasFlag = row.tagsCleared !== 0 || row.vasCleared !== 0;
  if (!hasScalar && !hasFlag && tagActions === 0 && vaActions === 0) {
    tx.delete(workMetaOverride)
      .where(eq(workMetaOverride.workId, workId))
      .run();
  }
}

/**
 * 保存覆盖（单事务）：
 * 0) 清理失效 remove 行（原始关系已被 rescan 删除 → 行退化为 no-op）
 * 1) 主行读-改-写（只更新请求中出现的键）
 * 2) tag/va 动作落库：以「原始集合」为基准推导——add 原始已存在 → 撤销 remove 行；
 *    remove 原始不存在 → 撤销先前 add 行。delta 语义的关键分支。
 */
export async function saveOverride(
  workId: string,
  input: SaveMetadataOverrideInput,
): Promise<void> {
  const exists = await db
    .select({ id: works.id })
    .from(works)
    .where(eq(works.id, workId))
    .limit(1);
  if (!exists[0]) throw new OverrideNotFoundError(workId);

  db.transaction((tx) => {
    tx.run(sql`
      DELETE FROM r_tag_work_override
       WHERE work_id = ${workId} AND action = 'remove'
         AND tag_id NOT IN (SELECT tag_id FROM r_tag_work WHERE work_id = ${workId})
    `);
    tx.run(sql`
      DELETE FROM r_va_work_override
       WHERE work_id = ${workId} AND action = 'remove'
         AND va_id NOT IN (SELECT va_id FROM r_va_work WHERE work_id = ${workId})
    `);

    const prev = tx
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, workId))
      .get();
    const circleId =
      'circleName' in input && input.circleName != null
        ? upsertCircleByName(tx, input.circleName)
        : 'circleName' in input
          ? null
          : (prev?.circleId ?? null);
    const seriesId =
      'seriesName' in input && input.seriesName != null
        ? upsertSeriesByName(tx, input.seriesName)
        : 'seriesName' in input
          ? null
          : (prev?.seriesId ?? null);
    const next = {
      workId,
      title: 'title' in input ? (input.title ?? null) : (prev?.title ?? null),
      circleId,
      seriesId,
      ageRating:
        'ageRating' in input
          ? (input.ageRating ?? null)
          : (prev?.ageRating ?? null),
      tagsCleared:
        'tagsCleared' in input
          ? input.tagsCleared
            ? 1
            : 0
          : (prev?.tagsCleared ?? 0),
      vasCleared:
        'vasCleared' in input
          ? input.vasCleared
            ? 1
            : 0
          : (prev?.vasCleared ?? 0),
      updatedBy: input.updatedBy ?? prev?.updatedBy ?? null,
      updatedAt: new Date().toISOString(),
    };
    if (prev) {
      tx.update(workMetaOverride)
        .set(next)
        .where(eq(workMetaOverride.workId, workId))
        .run();
    } else {
      tx.insert(workMetaOverride).values(next).run();
    }

    const originalTagIds = new Set(
      tx
        .select({ tagId: tagWork.tagId })
        .from(tagWork)
        .where(eq(tagWork.workId, workId))
        .all()
        .map((r) => r.tagId),
    );
    for (const name of input.addTags ?? []) {
      const tagId = upsertTagByName(tx, name);
      if (originalTagIds.has(tagId)) {
        tx.delete(tagWorkOverride)
          .where(
            and(
              eq(tagWorkOverride.workId, workId),
              eq(tagWorkOverride.tagId, tagId),
            ),
          )
          .run();
      } else {
        tx.insert(tagWorkOverride)
          .values({ workId, tagId, action: 'add' })
          .onConflictDoUpdate({
            target: [tagWorkOverride.workId, tagWorkOverride.tagId],
            set: { action: 'add' },
          })
          .run();
      }
    }
    for (const tagId of input.removeTagIds ?? []) {
      if (originalTagIds.has(tagId)) {
        tx.insert(tagWorkOverride)
          .values({ workId, tagId, action: 'remove' })
          .onConflictDoUpdate({
            target: [tagWorkOverride.workId, tagWorkOverride.tagId],
            set: { action: 'remove' },
          })
          .run();
      } else {
        tx.delete(tagWorkOverride)
          .where(
            and(
              eq(tagWorkOverride.workId, workId),
              eq(tagWorkOverride.tagId, tagId),
            ),
          )
          .run();
      }
    }

    const originalVaIds = new Set(
      tx
        .select({ vaId: vaWork.vaId })
        .from(vaWork)
        .where(eq(vaWork.workId, workId))
        .all()
        .map((r) => r.vaId),
    );
    for (const v of input.addVas ?? []) {
      const vaId = upsertVa(tx, v);
      if (originalVaIds.has(vaId)) {
        tx.delete(vaWorkOverride)
          .where(
            and(
              eq(vaWorkOverride.workId, workId),
              eq(vaWorkOverride.vaId, vaId),
            ),
          )
          .run();
      } else {
        tx.insert(vaWorkOverride)
          .values({ workId, vaId, action: 'add' })
          .onConflictDoUpdate({
            target: [vaWorkOverride.workId, vaWorkOverride.vaId],
            set: { action: 'add' },
          })
          .run();
      }
    }
    for (const vaId of input.removeVaIds ?? []) {
      if (originalVaIds.has(vaId)) {
        tx.insert(vaWorkOverride)
          .values({ workId, vaId, action: 'remove' })
          .onConflictDoUpdate({
            target: [vaWorkOverride.workId, vaWorkOverride.vaId],
            set: { action: 'remove' },
          })
          .run();
      } else {
        tx.delete(vaWorkOverride)
          .where(
            and(
              eq(vaWorkOverride.workId, workId),
              eq(vaWorkOverride.vaId, vaId),
            ),
          )
          .run();
      }
    }

    pruneIfEmpty(tx, workId);
  });
}

/** 单字段恢复原始：标量置 NULL；tags/vas 删动作行 + 解除 cleared。之后 prune。 */
export async function resetField(
  workId: string,
  field: MetadataField,
): Promise<void> {
  if (field === 'tags' || field === 'vas') {
    const table = field === 'tags' ? tagWorkOverride : vaWorkOverride;
    db.transaction((tx) => {
      tx.delete(table).where(eq(table.workId, workId)).run();
      tx.update(workMetaOverride)
        .set(field === 'tags' ? { tagsCleared: 0 } : { vasCleared: 0 })
        .where(eq(workMetaOverride.workId, workId))
        .run();
      pruneIfEmpty(tx, workId);
    });
    return;
  }
  const patch =
    field === 'title'
      ? { title: null }
      : field === 'circle'
        ? { circleId: null }
        : field === 'series'
          ? { seriesId: null }
          : { ageRating: null };
  db.transaction((tx) => {
    tx.update(workMetaOverride)
      .set(patch)
      .where(eq(workMetaOverride.workId, workId))
      .run();
    pruneIfEmpty(tx, workId);
  });
}

// ---------- 编辑回显 ----------

export type OverrideEntityRef<T> = { id: T; name: string };
export type OverrideActionRow<T> = OverrideEntityRef<T> & {
  action: 'add' | 'remove';
};

export type OverrideDetail = {
  original: {
    title: string;
    circle: OverrideEntityRef<number> | null;
    series: OverrideEntityRef<string> | null;
    ageRating: string;
    tags: Array<OverrideEntityRef<number>>;
    vas: Array<OverrideEntityRef<string>>;
  };
  effective: {
    title: string;
    circle: OverrideEntityRef<number> | null;
    series: OverrideEntityRef<string> | null;
    ageRating: string;
    tags: Array<OverrideEntityRef<number>>;
    vas: Array<OverrideEntityRef<string>>;
  };
  override: {
    title: string | null;
    circle: OverrideEntityRef<number> | null;
    series: OverrideEntityRef<string> | null;
    ageRating: string | null;
    tagsCleared: boolean;
    vasCleared: boolean;
    tagActions: Array<OverrideActionRow<number>>;
    vaActions: Array<OverrideActionRow<string>>;
    updatedBy: string | null;
    updatedAt: string | null;
  };
  overriddenFields: MetadataField[];
};

/** 编辑回显：原始值 + 覆盖状态 + 生效值（生效 tags/vas 查生效视图——视图的低频用途）。 */
export async function getOverride(
  workId: string,
): Promise<OverrideDetail | null> {
  const workRows = await db
    .select()
    .from(works)
    .where(eq(works.id, workId))
    .limit(1);
  const w = workRows[0];
  if (!w) return null;

  const originalCircleRows = await db
    .select({ id: circles.id, name: circles.name })
    .from(circles)
    .where(eq(circles.id, w.circleId))
    .limit(1);
  const originalSeriesRows = w.seriesId
    ? await db
        .select({ id: series.id, name: series.name })
        .from(series)
        .where(eq(series.id, w.seriesId))
        .limit(1)
    : [];
  const [originalTags, originalVas, metaRows, tagActions, vaActions] =
    await Promise.all([
      db
        .select({ id: tagWork.tagId, name: tags.name })
        .from(tagWork)
        .innerJoin(tags, eq(tagWork.tagId, tags.id))
        .where(eq(tagWork.workId, workId)),
      db
        .select({ id: vaWork.vaId, name: vas.name })
        .from(vaWork)
        .innerJoin(vas, eq(vaWork.vaId, vas.id))
        .where(eq(vaWork.workId, workId)),
      db
        .select()
        .from(workMetaOverride)
        .where(eq(workMetaOverride.workId, workId))
        .limit(1),
      db
        .select({
          id: tagWorkOverride.tagId,
          name: tags.name,
          action: tagWorkOverride.action,
        })
        .from(tagWorkOverride)
        .innerJoin(tags, eq(tagWorkOverride.tagId, tags.id))
        .where(eq(tagWorkOverride.workId, workId)),
      db
        .select({
          id: vaWorkOverride.vaId,
          name: vas.name,
          action: vaWorkOverride.action,
        })
        .from(vaWorkOverride)
        .innerJoin(vas, eq(vaWorkOverride.vaId, vas.id))
        .where(eq(vaWorkOverride.workId, workId)),
    ]);
  const meta = metaRows[0] ?? null;
  const overrideCircleRows = meta?.circleId
    ? await db
        .select({ id: circles.id, name: circles.name })
        .from(circles)
        .where(eq(circles.id, meta.circleId))
        .limit(1)
    : [];
  const overrideSeriesRows = meta?.seriesId
    ? await db
        .select({ id: series.id, name: series.name })
        .from(series)
        .where(eq(series.id, meta.seriesId))
        .limit(1)
    : [];

  const original = {
    title: w.title,
    circle: originalCircleRows[0] ?? null,
    series: originalSeriesRows[0] ?? null,
    ageRating: w.ageRating,
    tags: originalTags,
    vas: originalVas,
  };
  // 生效视图列未标 NOT NULL（schema.ts 未加 .notNull()），select 出的 id 带 null；
  // 视图语义（UNION 两臂来源均为非空列）保证 id 实际非空，此处仅做类型收窄。
  const [effectiveTags, effectiveVas] = await Promise.all([
    db
      .select({ id: vTagWork.tagId, name: tags.name })
      .from(vTagWork)
      .innerJoin(tags, eq(vTagWork.tagId, tags.id))
      .where(eq(vTagWork.workId, workId)),
    db
      .select({ id: vVaWork.vaId, name: vas.name })
      .from(vVaWork)
      .innerJoin(vas, eq(vVaWork.vaId, vas.id))
      .where(eq(vVaWork.workId, workId)),
  ]);

  const overriddenFields: MetadataField[] = [];
  if (meta?.title != null) overriddenFields.push('title');
  if (meta?.circleId != null) overriddenFields.push('circle');
  if (meta?.seriesId != null) overriddenFields.push('series');
  if (meta?.ageRating != null) overriddenFields.push('ageRating');
  if (meta?.tagsCleared === 1 || tagActions.length > 0)
    overriddenFields.push('tags');
  if (meta?.vasCleared === 1 || vaActions.length > 0)
    overriddenFields.push('vas');

  return {
    original,
    effective: {
      title: meta?.title ?? w.title,
      circle: meta?.circleId
        ? (overrideCircleRows[0] ?? null)
        : original.circle,
      series: meta?.seriesId
        ? (overrideSeriesRows[0] ?? null)
        : original.series,
      ageRating: meta?.ageRating ?? w.ageRating,
      tags: effectiveTags.filter(
        (t): t is OverrideEntityRef<number> => t.id !== null,
      ),
      vas: effectiveVas.filter(
        (t): t is OverrideEntityRef<string> => t.id !== null,
      ),
    },
    override: {
      title: meta?.title ?? null,
      circle: overrideCircleRows[0] ?? null,
      series: overrideSeriesRows[0] ?? null,
      ageRating: meta?.ageRating ?? null,
      tagsCleared: (meta?.tagsCleared ?? 0) === 1,
      vasCleared: (meta?.vasCleared ?? 0) === 1,
      tagActions,
      vaActions,
      updatedBy: meta?.updatedBy ?? null,
      updatedAt: meta?.updatedAt ?? null,
    },
    overriddenFields,
  };
}
