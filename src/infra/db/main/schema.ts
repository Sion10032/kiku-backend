import {
  integer,
  primaryKey,
  real,
  sqliteTable,
  text,
} from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('t_circle', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const works = sqliteTable('t_work', {
  id: text('id').primaryKey(),
  rootFolder: text('root_folder').notNull(),
  dir: text('dir').notNull(),
  title: text('title').notNull(),
  circleId: integer('circle_id')
    .notNull()
    .references(() => circles.id),
  /** 年龄分级：all 全年龄 / r15 / r18。不迁移旧 nsfw 值，存量行先落最严格的 'r18'，rescan 后由 DLsite 元数据回写真实分级。 */
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
  rank: text('rank'),
  language: text('language'),
  sourceId: text('source_id'),
  /** 所属系列（最多一个，可空）。普通 FK：不级联删除（系列表不会被删除）。 */
  seriesId: text('series_id').references(() => series.id),
  /** 软删除标记（ISO 时间串，null = 正常）。源文件缺失时置位，超过宽限期后物理清理。 */
  deletedAt: text('deleted_at'),
});

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
  (t) => [primaryKey({ columns: [t.tagId, t.workId] })],
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
  (t) => [primaryKey({ columns: [t.vaId, t.workId] })],
);

export const users = sqliteTable('t_user', {
  name: text('name').primaryKey(),
  password: text('password').notNull(),
  group: text('group').notNull(),
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
