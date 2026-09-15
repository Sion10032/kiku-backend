import { and, eq, inArray, sql } from 'drizzle-orm';
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
  /** 本请求内先恢复原始的字段；随后再套用本次编辑（叠加语义，见 saveOverride） */
  resetFields?: MetadataField[];
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
 * 标量覆盖补丁：仅出现的键生效（缺席 = 沿用 prev；显式 null = 恢复该字段）。
 * 不含 tags/vas 动作行与 prune——prune 时序敏感（动作行未写前会误删仅有
 * tags/vas 覆盖的主行），由外层保存器写完全部内容后统一调用。
 */
export type ScalarOverridePatch = {
  title?: string | null;
  circleName?: string | null;
  seriesName?: string | null;
  ageRating?: 'all' | 'r15' | 'r18' | null;
  tagsCleared?: boolean;
  vasCleared?: boolean;
  updatedBy?: string;
};

/** 事务内主行读-改-写（仅标量字段；调用方须保证 workId 存在）。 */
export function applyScalarOverrideInTx(
  tx: Tx,
  workId: string,
  patch: ScalarOverridePatch,
): void {
  const prev = tx
    .select()
    .from(workMetaOverride)
    .where(eq(workMetaOverride.workId, workId))
    .get();
  const circleId =
    'circleName' in patch && patch.circleName != null
      ? upsertCircleByName(tx, patch.circleName)
      : 'circleName' in patch
        ? null
        : (prev?.circleId ?? null);
  const seriesId =
    'seriesName' in patch && patch.seriesName != null
      ? upsertSeriesByName(tx, patch.seriesName)
      : 'seriesName' in patch
        ? null
        : (prev?.seriesId ?? null);
  const next = {
    workId,
    title: 'title' in patch ? (patch.title ?? null) : (prev?.title ?? null),
    circleId,
    seriesId,
    ageRating:
      'ageRating' in patch
        ? (patch.ageRating ?? null)
        : (prev?.ageRating ?? null),
    tagsCleared:
      'tagsCleared' in patch
        ? patch.tagsCleared
          ? 1
          : 0
        : (prev?.tagsCleared ?? 0),
    vasCleared:
      'vasCleared' in patch
        ? patch.vasCleared
          ? 1
          : 0
        : (prev?.vasCleared ?? 0),
    updatedBy: patch.updatedBy ?? prev?.updatedBy ?? null,
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
}

/**
 * 保存覆盖（单事务）：
 * 0) 清理失效 remove 行（原始关系已被 rescan 删除 → 行退化为 no-op）
 * 1) resetFields：先恢复原始（标量置 null / tags·vas 清动作行与 cleared）
 * 2) 主行读-改-写（只更新请求中出现的键；reset 的标量以显式 null 键合入 patch）
 * 3) tag/va 动作落库：以「原始集合」为基准推导——add 原始已存在 → 撤销 remove 行；
 *    remove 原始不存在 → 撤销先前 add 行。delta 语义的关键分支。
 *
 * reset 必须先于 apply：同请求的「resetFields + addTags/标量编辑」语义是
 * 「先重置回 original、再套用本次编辑」（purge 不能吃掉本次新增），
 * 顺序不可交换。
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

    // step 1（resetFields）：
    // - 标量：翻译成显式 null 键合入即将应用的 patch——仅当请求未显式携带该键
    //   时补（显式输入获胜，applyScalarOverrideInTx 的 'key' in patch 在场判断
    //   语义保持不变）。
    // - tags/vas：清空全部动作行 + 解除 cleared 标记。顺序敏感：必须先 purge
    //   再推导下方 add/remove，动作才会相对 original 基准叠加；主行不存在时
    //   UPDATE 零行即 no-op，主行收口由末尾 pruneIfEmpty 统一处理。
    const resets = new Set(input.resetFields ?? []);
    const scalarPatch: ScalarOverridePatch = { ...input };
    if (resets.has('title') && !('title' in input)) scalarPatch.title = null;
    if (resets.has('circle') && !('circleName' in input)) {
      scalarPatch.circleName = null;
    }
    if (resets.has('series') && !('seriesName' in input)) {
      scalarPatch.seriesName = null;
    }
    if (resets.has('ageRating') && !('ageRating' in input)) {
      scalarPatch.ageRating = null;
    }
    if (resets.has('tags')) {
      tx.delete(tagWorkOverride)
        .where(eq(tagWorkOverride.workId, workId))
        .run();
      tx.update(workMetaOverride)
        .set({ tagsCleared: 0 })
        .where(eq(workMetaOverride.workId, workId))
        .run();
    }
    if (resets.has('vas')) {
      tx.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, workId)).run();
      tx.update(workMetaOverride)
        .set({ vasCleared: 0 })
        .where(eq(workMetaOverride.workId, workId))
        .run();
    }

    applyScalarOverrideInTx(tx, workId, scalarPatch);

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

// ---------- 页内展示合并（高频路径的 service 侧合并；RQB with 不能查视图/按关系行过滤） ----------

/** FormattedWork 的结构子集；applyEffective 原地修改并回填 overriddenFields。 */
export type EffectiveWork = {
  id: string;
  title: string;
  circle: OverrideEntityRef<number>;
  series: OverrideEntityRef<string> | null;
  ageRating: string;
  tags: Array<OverrideEntityRef<number>>;
  vas: Array<OverrideEntityRef<string>>;
  overriddenFields?: MetadataField[];
};

/** 页内批量合并：3 个索引小查询（页大小有限，非 N+1）；无覆盖行时直接返回。 */
export async function applyEffective(items: EffectiveWork[]): Promise<void> {
  if (items.length === 0) return;
  const ids = items.map((i) => i.id);
  const [metaRows, tagRows, vaRows] = await Promise.all([
    db
      .select()
      .from(workMetaOverride)
      .where(inArray(workMetaOverride.workId, ids)),
    db
      .select({
        workId: tagWorkOverride.workId,
        action: tagWorkOverride.action,
        id: tags.id,
        name: tags.name,
      })
      .from(tagWorkOverride)
      .innerJoin(tags, eq(tagWorkOverride.tagId, tags.id))
      .where(inArray(tagWorkOverride.workId, ids)),
    db
      .select({
        workId: vaWorkOverride.workId,
        action: vaWorkOverride.action,
        id: vas.id,
        name: vas.name,
      })
      .from(vaWorkOverride)
      .innerJoin(vas, eq(vaWorkOverride.vaId, vas.id))
      .where(inArray(vaWorkOverride.workId, ids)),
  ]);
  if (metaRows.length === 0) return; // 99.9% 请求在此返回

  // 被覆盖 circle/series 的名字解析（FK 保证行存在）
  const circleIds = metaRows
    .map((m) => m.circleId)
    .filter((x): x is number => x !== null);
  const seriesIds = metaRows
    .map((m) => m.seriesId)
    .filter((x): x is string => x !== null);
  const [circleRows, seriesRows] = await Promise.all([
    circleIds.length > 0
      ? db.select().from(circles).where(inArray(circles.id, circleIds))
      : Promise.resolve([]),
    seriesIds.length > 0
      ? db.select().from(series).where(inArray(series.id, seriesIds))
      : Promise.resolve([]),
  ]);
  const circleName = new Map(circleRows.map((c) => [c.id, c.name]));
  const seriesName = new Map(seriesRows.map((s) => [s.id, s.name]));

  const metaById = new Map(metaRows.map((m) => [m.workId, m]));
  const tagRowsByWork = new Map<
    string,
    Array<{ action: 'add' | 'remove'; id: number; name: string }>
  >();
  for (const r of tagRows) {
    const list = tagRowsByWork.get(r.workId) ?? [];
    list.push(r);
    tagRowsByWork.set(r.workId, list);
  }
  const vaRowsByWork = new Map<
    string,
    Array<{ action: 'add' | 'remove'; id: string; name: string }>
  >();
  for (const r of vaRows) {
    const list = vaRowsByWork.get(r.workId) ?? [];
    list.push(r);
    vaRowsByWork.set(r.workId, list);
  }

  for (const item of items) {
    const meta = metaById.get(item.id);
    if (!meta) continue;
    const fields: MetadataField[] = [];
    if (meta.title !== null) {
      item.title = meta.title;
      fields.push('title');
    }
    if (meta.circleId !== null) {
      item.circle = {
        id: meta.circleId,
        name: circleName.get(meta.circleId) ?? '',
      };
      fields.push('circle');
    }
    if (meta.seriesId !== null) {
      item.series = {
        id: meta.seriesId,
        name: seriesName.get(meta.seriesId) ?? '',
      };
      fields.push('series');
    }
    if (meta.ageRating !== null) {
      item.ageRating = meta.ageRating;
      fields.push('ageRating');
    }
    const tRows = tagRowsByWork.get(item.id) ?? [];
    if (meta.tagsCleared === 1 || tRows.length > 0) {
      const removed = new Set(
        tRows.filter((r) => r.action === 'remove').map((r) => r.id),
      );
      const adds = tRows
        .filter((r) => r.action === 'add')
        .map((r) => ({ id: r.id, name: r.name, overridden: true }));
      item.tags =
        meta.tagsCleared === 1
          ? adds
          : [...item.tags.filter((t) => !removed.has(t.id)), ...adds];
      fields.push('tags');
    }
    const vRows = vaRowsByWork.get(item.id) ?? [];
    if (meta.vasCleared === 1 || vRows.length > 0) {
      const removed = new Set(
        vRows.filter((r) => r.action === 'remove').map((r) => r.id),
      );
      const adds = vRows
        .filter((r) => r.action === 'add')
        .map((r) => ({ id: r.id, name: r.name, overridden: true }));
      item.vas =
        meta.vasCleared === 1
          ? adds
          : [...item.vas.filter((v) => !removed.has(v.id)), ...adds];
      fields.push('vas');
    }
    item.overriddenFields = fields;
  }
}
