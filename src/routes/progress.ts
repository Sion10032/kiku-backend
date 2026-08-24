import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  upsertProgress,
  getWorkProgress,
  deleteWorkProgress,
} from '../services/progress.service.js';
import { getUserByName } from '../services/user.service.js';
import { getWorkById } from '../services/work.service.js';

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
        },
      },
    },
    async (request, reply) => {
      const user = request.user as { name: string; group: string };
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
      const user = request.user as { name: string; group: string };
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
      const user = request.user as { name: string; group: string };
      const { workId } = request.params;
      const deleted = await deleteWorkProgress(user.name, workId);
      return { deleted };
    },
  );
};
