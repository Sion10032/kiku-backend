// 跨路由共享的作品响应契约（/works、/history 同构）
import { z } from 'zod';

export const circleSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const tagSchema = z.object({
  id: z.number(),
  name: z.string(),
});

export const vaSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const seriesSchema = z.object({
  id: z.string(),
  name: z.string(),
});

export const userProgressSchema = z.object({
  mediaIndex: z.string(),
  trackTitle: z.string().nullable(),
  position: z.number(),
  duration: z.number().nullable(),
  listenedCount: z.number(),
  updatedAt: z.string(),
});

export const formattedWorkSchema = z.object({
  id: z.string(),
  rootFolder: z.string(),
  dir: z.string(),
  title: z.string(),
  circle: circleSchema,
  ageRating: z.enum(['all', 'r15', 'r18']),
  release: z.string().nullable(),
  dl_count: z.number().nullable(),
  price: z.number().nullable(),
  review_count: z.number().nullable(),
  rate_count: z.number().nullable(),
  rate_average_2dp: z.number().nullable(),
  rate_count_detail: z.record(z.string(), z.number()),
  /** DLsite 榜单成绩原始数组形状（与爬虫/迁移存储同形状，含 rank_date） */
  rank: z
    .array(
      z.object({
        term: z.string(),
        category: z.string(),
        rank: z.number(),
        rank_date: z.string(),
      }),
    )
    .nullable(),
  tags: z.array(
    z.object({
      id: z.number(),
      name: z.string(),
      overridden: z.boolean().optional(),
    }),
  ),
  vas: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      overridden: z.boolean().optional(),
    }),
  ),
  series: seriesSchema.nullable(),
  userRating: z.number().nullable(),
  userProgress: userProgressSchema.nullable(),
  /** 当前用户已读标记（独立于进度；未登录恒 false） */
  read: z.boolean(),
  /** 作品总时长（秒，SUM(t_track.duration_sec)）；无音轨/全未知为 null */
  duration: z.number().nullable(),
  /** 作品整合响度（LUFS，已分析音轨按时长加权）；null = 未分析 */
  loudnessLufs: z.number().nullable(),
  /** 作品峰值电平（dBTP，已分析音轨最大 True Peak）；null = 未分析 */
  loudnessTruePeakDb: z.number().nullable(),
  language: z.string().nullable(),
  sourceId: z.string().nullable(),
  /** 被管理员覆盖的字段（无覆盖时缺省） */
  overriddenFields: z
    .array(z.enum(['title', 'circle', 'series', 'ageRating', 'tags', 'vas']))
    .optional(),
});

export const paginationSchema = z.object({
  currentPage: z.number(),
  pageSize: z.number(),
  totalCount: z.number(),
});
