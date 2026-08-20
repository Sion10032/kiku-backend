import { relations } from 'drizzle-orm';
import * as schema from './schema.js';

export const usersRelations = relations(schema.users, ({ many }) => ({
  reviews: many(schema.reviews),
  userProgress: many(schema.userProgress),
}));

export const circlesRelations = relations(schema.circles, ({ many }) => ({
  works: many(schema.works),
}));

export const worksRelations = relations(schema.works, ({ one, many }) => ({
  circle: one(schema.circles, {
    fields: [ schema.works.circleId ],
    references: [ schema.circles.id ],
  }),
  tags: many(schema.tagWork),
  vas: many(schema.vaWork),
  reviews: many(schema.reviews),
  userProgress: many(schema.userProgress),
}));

export const tagsRelations = relations(schema.tags, ({ many }) => ({
  works: many(schema.tagWork),
}));

export const tagWorkRelations = relations(schema.tagWork, ({ one }) => ({
  tag: one(schema.tags, {
    fields: [ schema.tagWork.tagId ],
    references: [ schema.tags.id ],
  }),
  work: one(schema.works, {
    fields: [ schema.tagWork.workId ],
    references: [ schema.works.id ],
  }),
}));

export const vasRelations = relations(schema.vas, ({ many }) => ({
  works: many(schema.vaWork),
}));

export const vaWorkRelations = relations(schema.vaWork, ({ one }) => ({
  va: one(schema.vas, {
    fields: [ schema.vaWork.vaId ],
    references: [ schema.vas.id ],
  }),
  work: one(schema.works, {
    fields: [ schema.vaWork.workId ],
    references: [ schema.works.id ],
  }),
}));

export const reviewsRelations = relations(schema.reviews, ({ one }) => ({
  user: one(schema.users, {
    fields: [ schema.reviews.userName ],
    references: [ schema.users.name ],
  }),
  work: one(schema.works, {
    fields: [ schema.reviews.workId ],
    references: [ schema.works.id ],
  }),
}));

export const userProgressRelations = relations(schema.userProgress, ({ one }) => ({
  user: one(schema.users, {
    fields: [ schema.userProgress.userName ],
    references: [ schema.users.name ],
  }),
  work: one(schema.works, {
    fields: [ schema.userProgress.workId ],
    references: [ schema.works.id ],
  }),
}));
