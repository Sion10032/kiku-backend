import { sqliteTable, text, integer, real, primaryKey } from 'drizzle-orm/sqlite-core';

export const circles = sqliteTable('t_circle', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const works = sqliteTable('t_work', {
  id: text('id').primaryKey(),
  rootFolder: text('root_folder').notNull(),
  dir: text('dir').notNull(),
  title: text('title').notNull(),
  circleId: integer('circle_id').notNull().references(() => circles.id),
  nsfw: integer('nsfw', { mode: 'boolean' }),
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
});

export const tags = sqliteTable('t_tag', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
});

export const vas = sqliteTable('t_va', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
});

export const tagWork = sqliteTable('r_tag_work', {
  tagId: integer('tag_id').notNull().references(() => tags.id, { onDelete: 'cascade' }),
  workId: text('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
}, t => [ primaryKey({ columns: [ t.tagId, t.workId ] }) ]);

export const vaWork = sqliteTable('r_va_work', {
  vaId: text('va_id').notNull().references(() => vas.id, { onDelete: 'cascade' }),
  workId: text('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
}, t => [ primaryKey({ columns: [ t.vaId, t.workId ] }) ]);

export const users = sqliteTable('t_user', {
  name: text('name').primaryKey(),
  password: text('password').notNull(),
  group: text('group').notNull(),
});

export const reviews = sqliteTable('t_review', {
  userName: text('user_name').notNull().references(() => users.name, { onDelete: 'cascade' }),
  workId: text('work_id').notNull().references(() => works.id, { onDelete: 'cascade' }),
  rating: integer('rating'),
  reviewText: text('review_text'),
  createdAt: text('created_at').default('CURRENT_TIMESTAMP'),
  updatedAt: text('updated_at').default('CURRENT_TIMESTAMP'),
  progress: text('progress'),
}, t => [ primaryKey({ columns: [ t.userName, t.workId ] }) ]);

// Export types for all tables
export type Circle = typeof circles.$inferSelect;
export type NewCircle = typeof circles.$inferInsert;

export type Work = typeof works.$inferSelect;
export type NewWork = typeof works.$inferInsert;

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;

export type Va = typeof vas.$inferSelect;
export type NewVa = typeof vas.$inferInsert;

export type TagWork = typeof tagWork.$inferSelect;
export type VaWork = typeof vaWork.$inferSelect;

export type User = typeof users.$inferSelect;
export type NewUser = typeof users.$inferInsert;

export type Review = typeof reviews.$inferSelect;
export type NewReview = typeof reviews.$inferInsert;
