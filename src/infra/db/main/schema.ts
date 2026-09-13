import { sql } from 'drizzle-orm';
import {
  index,
  integer,
  primaryKey,
  real,
  sqliteTable,
  sqliteView,
  text,
} from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('t_circle', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const works = sqliteTable(
  't_work',
  {
    id: text('id').primaryKey(),
    rootFolder: text('root_folder').notNull(),
    dir: text('dir').notNull(),
    title: text('title').notNull(),
    circleId: integer('circle_id')
      .notNull()
      .references(() => circles.id),
    /** 年龄分级：all 全年龄 / r15 / r18。迁移按旧库 nsfw 映射（真值 → 'r18'，假值/NULL → 'all'），rescan 后由 DLsite 元数据回写真实分级。 */
    ageRating: text('age_rating', { enum: ['all', 'r15', 'r18'] })
      .notNull()
      .default('r18'),
    release: text('release'),
    dlCount: integer('dl_count'),
    price: integer('price'),
    reviewCount: integer('review_count'),
    rateCount: integer('rate_count'),
    rateAverage2dp: real('rate_average_2dp'),
    rateCountDetail: text('rate_count_detail'),
    /** DLsite 榜单成绩 JSON 数组（[{term,category,rank,rank_date}]，与爬虫原始形状一致、保留 rank_date；迁移按同形状归一化存储；null = 无数据）。 */
    rank: text('rank'),
    language: text('language'),
    sourceId: text('source_id'),
    /** 所属系列（最多一个，可空）。普通 FK：不级联删除（系列表不会被删除）。 */
    seriesId: text('series_id').references(() => series.id),
    /** 软删除标记（ISO 时间串，null = 正常）。源文件缺失时置位，超过宽限期后物理清理。 */
    deletedAt: text('deleted_at'),
    /** 作品整合响度（LUFS，已分析音轨按时长加权）；null = 未分析。 */
    loudnessLufs: real('loudness_lufs'),
    /** 作品内已分析音轨的 True Peak 最大值（dBTP），用于正向增益防削波钳制。 */
    loudnessTruePeakDb: real('loudness_true_peak_db'),
  },
  (t) => [
    // 列表端点按这些列排序且恒带 deleted_at IS NULL，用部分索引精确匹配查询形状；
    // 排序索引让 SQLite 流式输出、取满一页即停（配合关系表索引消除逐行全表扫描）。
    index('t_work_release_idx')
      .on(t.release)
      .where(sql`${t.deletedAt} is null`),
    index('t_work_dl_count_idx')
      .on(t.dlCount)
      .where(sql`${t.deletedAt} is null`),
    index('t_work_price_idx').on(t.price).where(sql`${t.deletedAt} is null`),
    index('t_work_rate_average_2dp_idx')
      .on(t.rateAverage2dp)
      .where(sql`${t.deletedAt} is null`),
    index('t_work_review_count_idx')
      .on(t.reviewCount)
      .where(sql`${t.deletedAt} is null`),
  ],
);

export const tags = sqliteTable('t_tag', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const vas = sqliteTable('t_va', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const series = sqliteTable('t_series', {
  id: text('id').primaryKey(), // DLsite SRI 编号，如 'SRI0000027029'
  name: text('name').notNull(), // 不设唯一：存在同名不同系列
});

export const tagWork = sqliteTable(
  'r_tag_work',
  {
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.tagId, t.workId] }),
    // 关系列表按 work_id 过滤（drizzle 关系子查询 where d0.id = work_id）；
    // 主键 (tag_id, work_id) 的第二列无法服务该查询，缺索引会逐行全表扫描。
    index('r_tag_work_work_id_idx').on(t.workId),
  ],
);

export const vaWork = sqliteTable(
  'r_va_work',
  {
    vaId: text('va_id')
      .notNull()
      .references(() => vas.id, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
  },
  (t) => [
    primaryKey({ columns: [t.vaId, t.workId] }),
    // 同 r_tag_work：主键第二列 work_id 无法服务按作品查声优的关联子查询。
    index('r_va_work_work_id_idx').on(t.workId),
  ],
);

export const users = sqliteTable('t_user', {
  name: text('name').primaryKey(),
  password: text('password').notNull(),
  group: text('group').notNull(),
  /** token 版本号：改密时 +1，旧 JWT 的 ver 声明不匹配即吊销 */
  tokenVersion: integer('token_version').notNull().default(0),
});

export const reviews = sqliteTable(
  't_review',
  {
    userName: text('user_name')
      .notNull()
      .references(() => users.name, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    rating: integer('rating'),
    reviewText: text('review_text'),
    createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
    updatedAt: text('updated_at').default('CURRENT_TIMESTAMP'),
    progress: text('progress'),
  },
  (t) => [primaryKey({ columns: [t.userName, t.workId] })],
);

// 动态播放进度：记录用户播放到每个作品的哪个音轨的哪个时间（与 t_review.progress 手动枚举无关）
export const userProgress = sqliteTable(
  't_user_progress',
  {
    userName: text('user_name')
      .notNull()
      .references(() => users.name, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    // 音轨标识 = 文件相对路径（media index，即前端 Track.hash）
    mediaIndex: text('media_index').notNull(),
    // 标题快照（列表展示时免读文件系统）
    trackTitle: text('track_title'),
    // 已播放到的时间（秒）
    position: real('position').notNull().default(0),
    // 音轨总时长（秒，未知为 null）
    duration: real('duration'),
    updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
  },
  (t) => [primaryKey({ columns: [t.userName, t.workId, t.mediaIndex] })],
);

// 作品已读标记（独立于播放进度：标记 = 1 行；首次产生进度时自动写入，可手动覆盖）。
// 存在即已读，删除即未读；标记未读不清理进度（D3）。
export const readStates = sqliteTable(
  't_read_state',
  {
    userName: text('user_name')
      .notNull()
      .references(() => users.name, { onDelete: 'cascade' }),
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    // 标记时刻（ISO 8601 文本，与全库时间戳风格一致）
    readAt: text('read_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userName, t.workId] })],
);

// 多态收藏：作品 / 系列 / 声优 / 社团，按用户隔离。
// 多态目标无法做 FK（targetId 统一存 text：work→RJ 号、series→SRI 号、
// va→DLsite 声优 id、circle→t_circle.id 转文本），完整性由 favourite.service 校验。
export const favourites = sqliteTable(
  't_favourite',
  {
    userName: text('user_name')
      .notNull()
      .references(() => users.name, { onDelete: 'cascade' }),
    // 'work' | 'series' | 'va' | 'circle'
    targetType: text('target_type').notNull(),
    targetId: text('target_id').notNull(),
    createdAt: text('created_at').notNull().default('CURRENT_TIMESTAMP'),
  },
  (t) => [primaryKey({ columns: [t.userName, t.targetType, t.targetId] })],
);

// 设置云端备份：用户手动命名快照，(userName, name) 唯一，同名覆盖更新。
// payload 为前端 settingsStore 持久化字段的 JSON 快照，结构由前端保证，
// 后端仅校验是合法 JSON 文本；上限每用户 10 条，由 service 层强制。
export const settingsBackups = sqliteTable(
  't_settings_backup',
  {
    userName: text('user_name')
      .notNull()
      .references(() => users.name, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    payload: text('payload').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [primaryKey({ columns: [t.userName, t.name] })],
);

export const tracks = sqliteTable(
  't_track',
  {
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    // 音轨标识 = 文件相对路径（media index，与前端 Track.hash 一致）
    mediaIndex: text('media_index').notNull(),
    title: text('title').notNull(),
    durationSec: real('duration_sec'), // 解析失败为 null
    sizeBytes: integer('size_bytes').notNull(),
    /** 整合响度（LUFS）；null = 未分析。 */
    loudnessLufs: real('loudness_lufs'),
    /** True Peak（dBTP）。 */
    loudnessTruePeakDb: real('loudness_true_peak_db'),
    /** 最近一次分析时间（ISO 8601 文本，与全库时间戳风格一致）。 */
    analyzedAt: text('analyzed_at'),
    /** 最近一次分析错误（null = 无错误；重试成功时清空）。 */
    analyzeError: text('analyze_error'),
    // 响度曲线（D6）：JSON 数组，short-term LUFS 按秒降采样（1 点/秒，1 位小数），空段 null
    loudnessCurve: text('loudness_curve'),
  },
  (t) => [primaryKey({ columns: [t.workId, t.mediaIndex] })],
);

// Export types for all tables
export type Circle = typeof circles.$inferSelect;
export type NewCircle = typeof circles.$inferInsert;

export type Work = typeof works.$inferSelect;
export type NewWork = typeof works.$inferInsert;

/** 年龄分级三档（与 t_work.age_rating 的 enum 一致），全后端共用。 */
export type AgeRating = Work['ageRating'];

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type Va = typeof vas.$inferSelect;
export type NewVa = typeof vas.$inferInsert;

export type Series = typeof series.$inferSelect;
export type NewSeries = typeof series.$inferInsert;

export type TagWork = typeof tagWork.$inferSelect;
export type VaWork = typeof vaWork.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;

export type UserProgress = typeof userProgress.$inferSelect;
export type NewUserProgress = typeof userProgress.$inferInsert;

export type ReadState = typeof readStates.$inferSelect;
export type NewReadState = typeof readStates.$inferInsert;

export type Favourite = typeof favourites.$inferSelect;
export type NewFavourite = typeof favourites.$inferInsert;

export type SettingsBackup = typeof settingsBackups.$inferSelect;
export type NewSettingsBackup = typeof settingsBackups.$inferInsert;

// —— 元数据覆盖层（A' 方案：标量 takeover + 关系 delta，见 plans/2026-09-03-metadata-override.md）——

/** 标量覆盖：NULL = 该字段未覆盖。tags/vas 的 cleared 标记表达「稳定空列表」（对 rescan 未来新增免疫）。 */
export const workMetaOverride = sqliteTable('t_work_meta_override', {
  workId: text('work_id')
    .primaryKey()
    .references(() => works.id, { onDelete: 'cascade' }),
  title: text('title'),
  circleId: integer('circle_id').references(() => circles.id),
  seriesId: text('series_id').references(() => series.id),
  ageRating: text('age_rating').$type<'all' | 'r15' | 'r18'>(),
  tagsCleared: integer('tags_cleared').notNull().default(0),
  vasCleared: integer('vas_cleared').notNull().default(0),
  updatedBy: text('updated_by'),
  updatedAt: text('updated_at').notNull().default('CURRENT_TIMESTAMP'),
});

/** 关系覆盖（delta）：仅被编辑的作品有行；add = 覆盖新增，remove = 屏蔽原始关系。 */
export const tagWorkOverride = sqliteTable(
  'r_tag_work_override',
  {
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id, { onDelete: 'cascade' }),
    action: text('action').$type<'add' | 'remove'>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.tagId] }),
    // 生效探针按 work_id 前缀扫描；tag:/裸词 的 add 分支按 tag_id 探测（性能结论回填）
    index('r_tag_work_override_work_id_idx').on(t.workId),
    index('r_tag_work_override_tag_id_idx').on(t.tagId),
  ],
);

export const vaWorkOverride = sqliteTable(
  'r_va_work_override',
  {
    workId: text('work_id')
      .notNull()
      .references(() => works.id, { onDelete: 'cascade' }),
    vaId: text('va_id')
      .notNull()
      .references(() => vas.id, { onDelete: 'cascade' }),
    action: text('action').$type<'add' | 'remove'>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workId, t.vaId] }),
    index('r_va_work_override_work_id_idx').on(t.workId),
    index('r_va_work_override_va_id_idx').on(t.vaId),
  ],
);

// —— 生效视图（低频路径专用：编辑回显 / getOverride；高频过滤不查视图）——

/** 生效标量：LEFT JOIN + COALESCE（无 NULL 陷阱；陷阱只存在于「COALESCE 放进带 WHERE 的标量子查询」形态）。 */
export const vWork = sqliteView('v_work', {
  workId: text('work_id'),
  title: text('title'),
  circleId: integer('circle_id'),
  seriesId: text('series_id'),
  ageRating: text('age_rating'),
}).as(sql`
  SELECT w.id AS work_id,
         COALESCE(m.title, w.title) AS title,
         COALESCE(m.circle_id, w.circle_id) AS circle_id,
         COALESCE(m.series_id, w.series_id) AS series_id,
         COALESCE(m.age_rating, w.age_rating) AS age_rating
    FROM t_work w
    LEFT JOIN t_work_meta_override m ON m.work_id = w.id
   WHERE w.deleted_at IS NULL
`);

/** 生效标签 = add 行 ∪ (原始 − remove 行；cleared=1 时整体屏蔽)。 */
export const vTagWork = sqliteView('v_tag_work', {
  workId: text('work_id'),
  tagId: integer('tag_id'),
}).as(sql`
  SELECT o.work_id AS work_id, o.tag_id AS tag_id
    FROM r_tag_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.tag_id AS tag_id
    FROM r_tag_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM t_work_meta_override m
            WHERE m.work_id = w.work_id AND m.tags_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM r_tag_work_override o
            WHERE o.work_id = w.work_id AND o.tag_id = w.tag_id
              AND o.action = 'remove'
         )
`);

export const vVaWork = sqliteView('v_va_work', {
  workId: text('work_id'),
  vaId: text('va_id'),
}).as(sql`
  SELECT o.work_id AS work_id, o.va_id AS va_id
    FROM r_va_work_override o
   WHERE o.action = 'add'
  UNION
  SELECT w.work_id AS work_id, w.va_id AS va_id
    FROM r_va_work w
   WHERE NOT EXISTS (
           SELECT 1 FROM t_work_meta_override m
            WHERE m.work_id = w.work_id AND m.vas_cleared = 1
         )
     AND NOT EXISTS (
           SELECT 1 FROM r_va_work_override o
            WHERE o.work_id = w.work_id AND o.va_id = w.va_id
              AND o.action = 'remove'
         )
`);
