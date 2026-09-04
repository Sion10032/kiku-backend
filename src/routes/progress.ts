import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  deleteWorkProgress,
  getUserHistoryIds,
  getWorkProgress,
  markWorkRead,
  markWorkUnread,
  upsertProgress,
} from '../services/progress.service.js';
import { getUserByName } from '../services/user.service.js';
import { getWorkById, getWorksByIdsOrdered } from '../services/work.service.js';
import { formattedWorkSchema, paginationSchema } from './schemas/work.js';

// 请求体 snake_case 对齐 review.ts（work_id/review_text）风格
const progressBodySchema = z.object({
  work_id: z.string(),
  media_index: z.string(),
  track_title: z.string().optional(),
  position: z.number().min(0),
  duration: z.number().min(0).nullable().optional(),
});

const workIdParamsSchema = z.object({
  workId: z.string(),
});

// 响应 camelCase 对齐 reviewResponseSchema 风格
const progressRowSchema = z.object({
  userName: z.string(),
  workId: z.string(),
  mediaIndex: z.string(),
  trackTitle: z.string().nullable(),
  position: z.number(),
  duration: z.number().nullable(),
  updatedAt: z.string().nullable(),
});

export const progressRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // 上报播放进度（节流写入，同 (user, work, track) 覆盖）
  fastify.put(
    '/progress',
    {
      preHandler: [fastify.authenticate],
      schema: {
        body: progressBodySchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const { work_id, media_index, track_title, position, duration } =
        request.body;

      // FK 防护：t_user_progress 有 user/work 两个外键，直接写入不存在的
      // 父行会执 SQLITE_CONSTRAINT_FOREIGNKEY → 500。
      // - 幽灵 token（签名有效但用户已不存在，如库重建后未重新注册）→
      //   401：前端 beforeError 拦截后清 token 跳登录，恢复正常会话
      // - 作品不在库（前端缓存页面播放已重建库）→ 404：进度无意义静默丢弃
      if (!(await getUserByName(user.name))) {
        return reply.status(401).send({ error: 'User not found' });
      }
      try {
        await getWorkById(work_id);
      } catch {
        return reply.status(404).send({ error: `Work ${work_id} not found` });
      }

      await upsertProgress({
        userName: user.name,
        workId: work_id,
        mediaIndex: media_index,
        trackTitle: track_title,
        position,
        duration,
      });

      return { success: true };
    },
  );

  // 标记已读/未读（只读写标记行，不动进度；workId 404 防护对齐 PUT /progress）
  fastify.put(
    '/progress/:workId/read',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: workIdParamsSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.string() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const user = request.user;
      const { workId } = request.params;
      try {
        await getWorkById(workId);
      } catch {
        return reply.status(404).send({ error: `Work ${workId} not found` });
      }
      await markWorkRead(user.name, workId);
      return { success: true };
    },
  );

  fastify.delete(
    '/progress/:workId/read',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: workIdParamsSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          401: z.object({ error: z.string() }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { workId } = request.params;
      await markWorkUnread(user.name, workId);
      return { success: true };
    },
  );

  // 用户收听历史（按作品去重，最近收听时间倒序）：
  // progress.service 聚合出有序 workId，work.service 保序格式化，
  // 响应结构与 /works 列表同构（前端复用 WorksPage 类型与卡片组件）
  const historyQuerySchema = z.object({
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce.number().int().min(1).max(100).default(20),
  });

  fastify.get(
    '/history',
    {
      preHandler: [fastify.authenticate],
      schema: {
        querystring: historyQuerySchema,
        response: {
          200: z.object({
            works: z.array(formattedWorkSchema),
            pagination: paginationSchema,
          }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { page, pageSize } = request.query;
      const { workIds, totalCount } = await getUserHistoryIds(user.name, {
        page,
        pageSize,
      });
      const works = await getWorksByIdsOrdered(workIds, user.name);
      return { works, pagination: { currentPage: page, pageSize, totalCount } };
    },
  );

  // 某作品全部进度行（详情页/继续播放）
  fastify.get(
    '/progress/:workId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: workIdParamsSchema,
        response: {
          200: z.array(progressRowSchema),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { workId } = request.params;
      return getWorkProgress(user.name, workId);
    },
  );

  // 删除某作品全部播放进度（回到未读态）
  fastify.delete(
    '/progress/:workId',
    {
      preHandler: [fastify.authenticate],
      schema: {
        params: workIdParamsSchema,
        response: {
          200: z.object({ deleted: z.number() }),
        },
      },
    },
    async (request) => {
      const user = request.user;
      const { workId } = request.params;
      const deleted = await deleteWorkProgress(user.name, workId);
      return { deleted };
    },
  );
};
