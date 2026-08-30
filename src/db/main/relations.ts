import { defineRelations } from 'drizzle-orm';
import * as schema from './schema.js';

// Drizzle v1: Relational Queries v2 集中式 defineRelations（取代 v0 的 relations()）
export const relations = defineRelations(schema, (r) => ({
  users: {
    reviews: r.many.reviews(),
    userProgress: r.many.userProgress(),
  },
  circles: {
    works: r.many.works(),
  },
  works: {
    circle: r.one.circles({
      from: r.works.circleId,
      to: r.circles.id,
      optional: false,
    }),
    tags: r.many.tagWork(),
    vas: r.many.vaWork(),
    series: r.one.series({
      from: r.works.seriesId,
      to: r.series.id,
      optional: true,
    }),
    reviews: r.many.reviews(),
    userProgress: r.many.userProgress(),
  },
  tags: {
    works: r.many.tagWork(),
  },
  tagWork: {
    tag: r.one.tags({ from: r.tagWork.tagId, to: r.tags.id, optional: false }),
    work: r.one.works({
      from: r.tagWork.workId,
      to: r.works.id,
      optional: false,
    }),
  },
  vas: {
    works: r.many.vaWork(),
  },
  series: {
    works: r.many.works(),
  },
  vaWork: {
    va: r.one.vas({ from: r.vaWork.vaId, to: r.vas.id, optional: false }),
    work: r.one.works({
      from: r.vaWork.workId,
      to: r.works.id,
      optional: false,
    }),
  },
  reviews: {
    user: r.one.users({
      from: r.reviews.userName,
      to: r.users.name,
      optional: false,
    }),
    work: r.one.works({
      from: r.reviews.workId,
      to: r.works.id,
      optional: false,
    }),
  },
  userProgress: {
    user: r.one.users({
      from: r.userProgress.userName,
      to: r.users.name,
      optional: false,
    }),
    work: r.one.works({
      from: r.userProgress.workId,
      to: r.works.id,
      optional: false,
    }),
  },
}));
