import { and, eq, isNull, sql } from 'drizzle-orm';
import { getConfig } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import type {
  AgeRating,
  Circle,
  Series,
  Tag,
  Va,
  Work,
} from '../infra/db/main/schema.js';
import {
  circles,
  series,
  tags,
  tagWork,
  vas,
  vaWork,
  works,
} from '../infra/db/main/schema.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import type { TrackNode } from '../infra/fs/utils.js';
import type { WorkRankEntry } from '../infra/scraper/dlsite.js';
import { deleteAllCovers } from './cover.service.js';
import {
  applyEffective,
  type MetadataField,
} from './metadataOverride.service.js';
import {
  getProgressByWorks,
  getReadWorkIds,
  type WorkProgressSummary,
} from './progress.service.js';
import { compileQuery } from './query/compiler.js';
import { parseQuery } from './query/parser.js';
import { getTotalDurations, getTrackRows } from './track.service.js';

// ---------- Upsert (used by scanner) ----------

export interface UpsertWorkInput {
  id: string; // Full RJ code like "RJ01578781"
  rootFolder: string; // config rootFolder name
  dir: string; // relative directory path
  title: string;
  circleName: string;
  circleId?: string; // DLsite maker_id (optional)
  /** 年龄分级（缺省按 all 处理） */
  ageRating?: AgeRating;
  release?: string;
  dlCount?: number;
  price?: number;
  reviewCount?: number;
  rateCount?: number;
  rateAverage2dp?: number;
  rateCountDetail?: Record<string, number>;
  rank?: WorkRankEntry[];
  tags?: string[];
  vas?: Array<{ id: string; name: string }>;
  series?: { id: string; name: string } | null;
  language?: string;
  sourceId?: string;
}

export interface UpsertResult {
  workId: string;
  title: string;
  created: boolean;
  success: boolean;
  error?: string;
}

/**
 * 按 id upsert 系列行（SRI 编号为主键）。
 * 名字不设唯一且可能变更语义：已存在的系列一律沿用库内记录，不合并、不改名。
 */
async function upsertSeriesRow(
  id: string,
  name: string,
): Promise<string | null> {
  const existing = await db.query.series.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, id) },
  });
  if (existing) return existing.id;
  await db.insert(series).values({ id, name }).onConflictDoNothing();
  return id;
}

/**
 * Create or update a work with all its relations (circle, tags, VAs).
 * Used by the scanner to persist DLsite metadata into the database.
 */
export async function upsertWork(
  input: UpsertWorkInput,
): Promise<UpsertResult> {
  try {
    // 1. Find or create circle
    let circle = await db.query.circles.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, input.circleName) },
    });
    if (!circle) {
      const result = await db
        .insert(circles)
        .values({ name: input.circleName })
        .returning();
      circle = result[0];
    }
    if (!circle) throw new Error('Failed to create circle');

    // 2. Check if work already exists
    const existing = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, input.id) },
    });

    if (existing) {
      // Update existing work（源恢复时清除软删标记）
      await db
        .update(works)
        .set({
          title: input.title,
          circleId: circle.id,
          rootFolder: input.rootFolder,
          dir: input.dir,
          deletedAt: null,
          ageRating: input.ageRating ?? existing.ageRating,
          release: input.release ?? existing.release,
          dlCount: input.dlCount ?? existing.dlCount,
          price: input.price ?? existing.price,
          reviewCount: input.reviewCount ?? existing.reviewCount,
          rateCount: input.rateCount ?? existing.rateCount,
          rateAverage2dp: input.rateAverage2dp ?? existing.rateAverage2dp,
          rateCountDetail: input.rateCountDetail
            ? JSON.stringify(input.rateCountDetail)
            : existing.rateCountDetail,
          rank:
            input.rank && input.rank.length > 0
              ? JSON.stringify(input.rank)
              : existing.rank,
          language: input.language ?? existing.language,
          sourceId: input.sourceId ?? existing.sourceId,
        })
        .where(eq(works.id, input.id));

      // Update tags: delete old, then insert new
      if (input.tags) {
        await db.delete(tagWork).where(eq(tagWork.workId, input.id));
        for (const tagName of input.tags) {
          let tag = await db.query.tags.findFirst({
            where: { RAW: (t, op) => op.eq(t.name, tagName) },
          });
          if (!tag) {
            const result = await db
              .insert(tags)
              .values({ name: tagName })
              .returning();
            tag = result[0];
          }
          if (tag) {
            await db
              .insert(tagWork)
              .values({ tagId: tag.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      // Update VAs: delete old, then insert new
      if (input.vas) {
        await db.delete(vaWork).where(eq(vaWork.workId, input.id));
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({
            where: { RAW: (t, op) => op.eq(t.id, va.id) },
          });
          if (!existingVa) {
            const result = await db
              .insert(vas)
              .values({ id: va.id, name: va.name })
              .returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db
              .insert(vaWork)
              .values({ vaId: existingVa.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      // Update series: 仅在传入系列时设置（null/undefined 保持既有 seriesId 不变，存量不回填）
      if (input.series) {
        const seriesId = await upsertSeriesRow(
          input.series.id,
          input.series.name,
        );
        if (seriesId) {
          await db
            .update(works)
            .set({ seriesId })
            .where(eq(works.id, input.id));
        }
      }

      return {
        workId: input.id,
        title: input.title,
        created: false,
        success: true,
      };
    } else {
      // Create new work（先确保系列行存在，外键开启时插入才能引用）
      let newSeriesId: string | null = null;
      if (input.series) {
        newSeriesId = await upsertSeriesRow(input.series.id, input.series.name);
      }

      await db.insert(works).values({
        id: input.id as string,
        rootFolder: input.rootFolder,
        dir: input.dir,
        title: input.title,
        circleId: circle.id,
        ageRating: input.ageRating ?? 'all',
        release: input.release ?? null,
        dlCount: input.dlCount ?? null,
        price: input.price ?? null,
        reviewCount: input.reviewCount ?? null,
        rateCount: input.rateCount ?? null,
        rateAverage2dp: input.rateAverage2dp ?? null,
        rateCountDetail: input.rateCountDetail
          ? JSON.stringify(input.rateCountDetail)
          : '{}',
        rank:
          input.rank && input.rank.length > 0
            ? JSON.stringify(input.rank)
            : null,
        language: input.language ?? null,
        sourceId: input.sourceId ?? null,
        seriesId: newSeriesId,
      });

      // Create tags
      if (input.tags) {
        for (const tagName of input.tags) {
          let tag = await db.query.tags.findFirst({
            where: { RAW: (t, op) => op.eq(t.name, tagName) },
          });
          if (!tag) {
            const result = await db
              .insert(tags)
              .values({ name: tagName })
              .returning();
            tag = result[0];
          }
          if (tag) {
            await db
              .insert(tagWork)
              .values({ tagId: tag.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      // Create VAs
      if (input.vas) {
        for (const va of input.vas) {
          let existingVa = await db.query.vas.findFirst({
            where: { RAW: (t, op) => op.eq(t.id, va.id) },
          });
          if (!existingVa) {
            const result = await db
              .insert(vas)
              .values({ id: va.id, name: va.name })
              .returning();
            existingVa = result[0];
          }
          if (existingVa) {
            await db
              .insert(vaWork)
              .values({ vaId: existingVa.id, workId: input.id })
              .onConflictDoNothing();
          }
        }
      }

      return {
        workId: input.id,
        title: input.title,
        created: true,
        success: true,
      };
    }
  } catch (err) {
    return {
      workId: input.id,
      title: input.title,
      created: false,
      success: false,
      error: String(err),
    };
  }
}

// ---------- 软删除 / 物理删除（scanner prune 使用） ----------

/** 取某 rootFolder 下的全部作品记录（含软删标记），供 scanner 做源缺失差集。 */
export async function getWorksByRootFolder(rootFolder: string) {
  return db.query.works.findMany({
    where: { RAW: (t, op) => op.eq(t.rootFolder, rootFolder) },
    columns: { id: true, deletedAt: true, dir: true, sourceId: true },
  });
}

/** 软删除：置 deletedAt 标记（ISO 时间串）。源缺失时的第一动作，宽限期内可恢复。 */
export async function softDeleteWork(id: string): Promise<void> {
  await db
    .update(works)
    .set({ deletedAt: new Date().toISOString() })
    .where(eq(works.id, id));
}

/** 作品行是否存在（含软删行）；workAdmin 删除路由判 404 用。 */
export async function workExists(id: string): Promise<boolean> {
  const row = await db.query.works.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, id) },
    columns: { id: true },
  });
  return row != null;
}

/**
 * 物理删除：删除作品记录（级联清 tagWork/vaWork/reviews/userProgress，
 * SQLite 外键已开启）并清理封面 blob。
 */
export async function hardDeleteWork(id: string): Promise<void> {
  await db.delete(works).where(eq(works.id, id));
  deleteAllCovers(id);
}

// 带关联的查询结果类型
type WorkWithRelations = Work & {
  circle: Circle;
  tags?: Array<{ tag: Tag }>;
  vas?: Array<{ va: Va }>;
  series?: Series | null;
  reviews?: Array<{ rating: number | null }>;
};

// 格式化后的输出类型
export interface FormattedWork {
  id: string;
  rootFolder: string;
  dir: string;
  title: string;
  circle: { id: number; name: string };
  /** 年龄分级：all 全年龄 / r15 / r18 */
  ageRating: AgeRating;
  release: string | null;
  dl_count: number | null;
  price: number | null;
  review_count: number | null;
  rate_count: number | null;
  rate_average_2dp: number | null;
  rate_count_detail: Record<string, number>;
  rank: WorkRankEntry[] | null;
  tags: Array<{ id: number; name: string; overridden?: boolean }>;
  vas: Array<{ id: string; name: string; overridden?: boolean }>;
  /** 被管理员覆盖的字段（列表/详情徽标用；无覆盖时缺省）。
   * tag/va 元素级：applyEffective 合并后，override 新增的元素带 overridden: true（原始项缺省） */
  overriddenFields?: MetadataField[];
  series: { id: string; name: string } | null;
  userRating: number | null;
  /** 当前用户播放进度聚合（null = 未读/未登录） */
  userProgress: WorkProgressSummary | null;
  /** 当前用户已读标记（独立于进度；未登录恒 false） */
  read: boolean;
  /** 作品总时长（秒，SUM(t_track.duration_sec)）；无音轨/全未知为 null */
  duration: number | null;
  /** 作品整合响度（LUFS，已分析音轨按时长加权）；null = 未分析 */
  loudnessLufs: number | null;
  language: string | null;
  sourceId: string | null;
}

function formatWork(row: WorkWithRelations): FormattedWork {
  // 响度：有分析数据即下发；目标响度/最大增益/均衡开关均在客户端，
  // gainDb 由前端按用户设置计算（服务端零转码，不做增益应用）
  const loudnessLufs = row.loudnessLufs ?? null;
  return {
    id: row.id,
    rootFolder: row.rootFolder,
    dir: row.dir,
    title: row.title,
    circle: { id: row.circle.id, name: row.circle.name },
    ageRating: row.ageRating,
    release: row.release,
    dl_count: row.dlCount,
    price: row.price,
    review_count: row.reviewCount,
    rate_count: row.rateCount,
    rate_average_2dp: row.rateAverage2dp,
    rate_count_detail: JSON.parse(row.rateCountDetail ?? '{}'),
    rank: row.rank ? JSON.parse(row.rank) : null,
    tags: row.tags?.map((tw) => ({ id: tw.tag.id, name: tw.tag.name })) ?? [],
    vas: row.vas?.map((vw) => ({ id: vw.va.id, name: vw.va.name })) ?? [],
    series:
      row.series != null ? { id: row.series.id, name: row.series.name } : null,
    userRating: row.reviews?.[0]?.rating ?? null,
    userProgress: null,
    read: false,
    duration: null,
    loudnessLufs,
    language: row.language,
    sourceId: row.sourceId,
  };
}

/**
 * 批量注入作品总时长（SUM(t_track.duration_sec)，匿名也注入）。
 * 整页一次聚合查询，避免 N+1。
 */
async function attachTotalDuration(items: FormattedWork[]): Promise<void> {
  if (items.length === 0) return;
  const durMap = await getTotalDurations(items.map((w) => w.id));
  for (const item of items) {
    item.duration = durMap.get(item.id) ?? null;
  }
}

/**
 * 批量注入当前用户的评分与播放进度（userRating/userProgress，避免逐作品 N+1）。
 *
 * 未登录（username 为空）时保持 null（未读态），不做任何查询。
 */
async function attachUserRatingsAndProgress(
  items: FormattedWork[],
  username?: string,
): Promise<void> {
  if (!username || items.length === 0) return;
  const workIds = items.map((w) => w.id);

  const [reviewRows, progressMap, readSet] = await Promise.all([
    db.query.reviews.findMany({
      where: {
        RAW: (t, op) =>
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
          op.and(op.eq(t.userName, username), op.inArray(t.workId, workIds))!,
      },
      columns: { workId: true, rating: true },
    }),
    getProgressByWorks(username, workIds),
    getReadWorkIds(username, workIds),
  ]);

  const ratingByWork = new Map(reviewRows.map((r) => [r.workId, r.rating]));
  for (const item of items) {
    item.userRating = ratingByWork.get(item.id) ?? null;
    item.userProgress = progressMap.get(item.id) ?? null;
    item.read = readSet.has(item.id);
  }
}

/**
 * 统一注入入口：总时长（匿名也注入）+ 用户评分/播放进度（未登录跳过），并行执行。
 * 各列表/详情端点 formatWork 后调用一次。
 */
async function attachUserData(
  items: FormattedWork[],
  username?: string,
): Promise<void> {
  await Promise.all([
    attachTotalDuration(items),
    attachUserRatingsAndProgress(items, username),
  ]);
}

export async function getWorkById(id: string, username?: string) {
  const row = await db.query.works.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
        op.and(op.eq(t.id, id), op.isNull(t.deletedAt))!,
    },
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
      series: true,
    },
  });
  if (!row) throw new Error(`Work ${id} not found`);
  const work = formatWork(row);
  await applyEffective([work]);
  await attachUserData([work], username);
  return work;
}

/**
 * 按 id 批量取作品并保持传入顺序（收听历史等「顺序由外部决定」的场景）。
 *
 * - inArray 批量查询（避免 N+1），结果按 ids 重排（findMany 不保证顺序）
 * - 过滤软删：ids 中已软删的作品静默跳过（不出现在结果里）
 * - attachUserData 注入 userRating/userProgress（同其他列表端点）
 */
export async function getWorksByIdsOrdered(
  ids: string[],
  username?: string,
): Promise<FormattedWork[]> {
  if (ids.length === 0) return [];

  const rows = await db.query.works.findMany({
    with: {
      circle: true,
      tags: { with: { tag: true } },
      vas: { with: { va: true } },
      series: true,
    },
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
        op.and(op.inArray(t.id, ids), op.isNull(t.deletedAt))!,
    },
  });

  const byId = new Map(rows.map((r) => [r.id, r]));
  const items = ids
    .map((id) => byId.get(id))
    .filter((r) => r != null)
    .map((r) => formatWork(r));
  await applyEffective(items);

  await attachUserData(items, username);
  return items;
}

/** 排序字段映射（各列表查询共用）。 */
const ORDER_KEY_MAP = {
  id: 'id',
  release: 'release',
  dl_count: 'dlCount',
  price: 'price',
  rate_average_2dp: 'rateAverage2dp',
  review_count: 'reviewCount',
} as const;

/** 作品列表通用分页/排序参数（筛选类查询与各列表端点共用）。 */
export type WorksListOpts = {
  page?: number;
  pageSize?: number;
  orderBy?: string;
  sortDir?: 'asc' | 'desc';
};

function filteredPageOpts(opts?: WorksListOpts) {
  const {
    page = 1,
    pageSize = 20,
    orderBy = 'release',
    sortDir = 'desc',
  } = opts ?? {};
  const key = ORDER_KEY_MAP[orderBy as keyof typeof ORDER_KEY_MAP] ?? 'release';
  return {
    page,
    pageSize,
    offset: (page - 1) * pageSize,
    orderKey: key,
    sortDir,
  };
}

/**
 * 统一查询入口：LQL 查询文本 → 分页作品列表。
 *
 * - q 为空/空白 → 全量（含随机排序路径，行为对齐原列表端点）
 * - 有筛选时 random/betterRandom 退化为 release（filteredPageOpts 已做映射）
 * - 筛选条件以 ast 为单一来源，findMany/count 各自渲染
 * - 语法/语义错误抛 QueryParseError，由路由层映射 400
 */
export async function queryWorks(
  q: string | undefined,
  username?: string,
  opts?: WorksListOpts,
) {
  const ast = q?.trim() ? parseQuery(q) : undefined;
  const { page, pageSize, offset, orderKey, sortDir } = filteredPageOpts(opts);
  const orderBy = opts?.orderBy ?? 'release';

  // 无筛选 + 随机排序：随机 id 子查询路径（先 RANDOM() 取一页 id，再查关联）
  if (!ast && (orderBy === 'random' || orderBy === 'betterRandom')) {
    const randomIds = db
      .select({ id: works.id })
      .from(works)
      .where(sql`${works.deletedAt} IS NULL`)
      .orderBy(sql`RANDOM()`)
      .limit(pageSize)
      .offset(offset);

    const [items, countResult] = await Promise.all([
      db.query.works.findMany({
        with: {
          circle: true,
          tags: { with: { tag: true } },
          vas: { with: { va: true } },
          series: true,
        },
        where: {
          RAW: (t, op) =>
            // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
            op.and(op.inArray(t.id, randomIds), op.isNull(t.deletedAt))!,
        },
      }),
      db
        .select({ count: sql<number>`count(*)` })
        .from(works)
        .where(sql`${works.deletedAt} IS NULL`),
    ]);
    const formatted = items.map((item) => formatWork(item));
    await applyEffective(formatted);
    await attachUserData(formatted, username);
    return {
      works: formatted,
      pagination: {
        currentPage: page,
        pageSize,
        totalCount: countResult[0]?.count ?? 0,
      },
    };
  }

  // 常规路径（有筛选 or 非随机排序）。
  // count 查询未别名化，用默认 works 表编译即可；
  // findMany 的 RAW 回调中主表被 drizzle 别名化（"d0"），须用回调的 t 重新编译，
  // 否则 "t_work"."col" 列引用无法解析（SQLiteError: no such column）。
  const countWhere = ast
    ? and(compileQuery(ast), isNull(works.deletedAt))
    : isNull(works.deletedAt);

  const [items, countResult] = await Promise.all([
    db.query.works.findMany({
      with: {
        circle: true,
        tags: { with: { tag: true } },
        vas: { with: { va: true } },
        series: true,
      },
      where: {
        RAW: (t, op) => {
          const filter = ast ? compileQuery(ast, t) : undefined;
          // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined，RAW where 需要 SQL
          return op.and(filter, op.isNull(t.deletedAt))!;
        },
      },
      orderBy: (t, { asc: ascOp, desc: descOp }) =>
        sortDir === 'asc' ? ascOp(t[orderKey]) : descOp(t[orderKey]),
      limit: pageSize,
      offset,
    }),
    db.select({ count: sql<number>`count(*)` }).from(works).where(countWhere),
  ]);
  const formatted = items.map((item) => formatWork(item));
  await applyEffective(formatted);
  await attachUserData(formatted, username);
  return {
    works: formatted,
    pagination: {
      currentPage: page,
      pageSize,
      totalCount: countResult[0]?.count ?? 0,
    },
  };
}

export async function getCircles() {
  return db.query.circles.findMany();
}

export async function getTags() {
  return db.query.tags.findMany();
}

export async function getSeries() {
  return db.query.series.findMany();
}

export async function getVas() {
  return db.query.vas.findMany();
}

export type WorkTracksResult =
  | { ok: true; tracks: TrackNode[] }
  | {
      ok: false;
      reason: 'work-not-found' | 'root-folder-not-found';
      rootFolder?: string; // root-folder-not-found 时携带，供 route 报文使用
    };

/**
 * 获取作品的文件树
 * @param id 作品 ID（完整 RJ code）
 * @returns 文件树结构
 */
export async function getWorkTracks(id: string): Promise<WorkTracksResult> {
  const row = await db.query.works.findFirst({
    where: {
      RAW: (t, op) =>
        // biome-ignore lint/style/noNonNullAssertion: drizzle 的 and() 返回 SQL | undefined
        op.and(op.eq(t.id, id), op.isNull(t.deletedAt))!,
    },
    columns: {
      id: true,
      rootFolder: true,
      dir: true,
      title: true,
    },
  });

  if (!row) {
    return { ok: false, reason: 'work-not-found' };
  }

  const config = getConfig();
  const rootFolder = config.rootFolders.find((f) => f.name === row.rootFolder);

  if (!rootFolder) {
    return {
      ok: false,
      reason: 'root-folder-not-found',
      rootFolder: row.rootFolder,
    };
  }

  const source = await openWorkSource(rootFolder.path, row.dir);
  const tree = await source.buildTree();
  // API 层职责：文件系统 TrackNode 保持纯净，时长/响度在返回前按 mediaIndex 附加
  // （库内无行的轨/探测失败的轨 → null）。
  const rows = await getTrackRows(id);
  const dur = new Map(rows.map((r) => [r.mediaIndex, r.durationSec]));
  const lufs = new Map(rows.map((r) => [r.mediaIndex, r.loudnessLufs]));
  const attach = (nodes: TrackNode[]): TrackNode[] =>
    nodes.map((n) =>
      n.type === 'audio'
        ? {
            ...n,
            durationSec: dur.get(n.hash) ?? null,
            loudnessLufs: lufs.get(n.hash) ?? null,
          }
        : n.type === 'folder'
          ? { ...n, children: attach(n.children) }
          : n,
    );
  return { ok: true, tracks: attach(tree) };
}

// ---------- Scanner update mode ----------

/** 所有未软删作品的最小引用（供扫描器 update 模式遍历，不 join 关联）。 */
export async function getAllWorkRefs(): Promise<
  Array<{ id: string; rootFolder: string; dir: string }>
> {
  return db
    .select({ id: works.id, rootFolder: works.rootFolder, dir: works.dir })
    .from(works)
    .where(isNull(works.deletedAt));
}

/**
 * 分析用原始行：rootFolder 名 + 相对 dir 定位作品源，title 供任务事件展示。
 * 过滤软删（软删作品不参与响度分析）；不存在返回 null。
 * 现有 getWorkById 返回 formatted 对象非原始行，不能复用。
 */
export async function getWorkRow(id: string): Promise<{
  id: string;
  rootFolder: string;
  dir: string;
  title: string;
} | null> {
  const rows = await db
    .select({
      id: works.id,
      rootFolder: works.rootFolder,
      dir: works.dir,
      title: works.title,
    })
    .from(works)
    .where(and(eq(works.id, id), isNull(works.deletedAt)))
    .limit(1);
  return rows[0] ?? null;
}
