import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { refreshWorkMetadata, syncWorkDurations } from '../scanner/workOps.js';
import { softDeleteWork, workExists } from '../services/work.service.js';

const idParamsSchema = z.object({
  id: z.string(),
});

const trackSyncStatsSchema = z.object({
  added: z.number(),
  updated: z.number(),
  removed: z.number(),
});

/**
 * 单作品管理端点（管理员专用）：更新元数据 / 更新音轨时长 / 删除。
 * 与 metadata.ts 的公开浏览读端点相对；全部挂 authenticateAdmin。
 */
export const workAdminRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /api/work/:id/refresh — 重抓 DLsite 元数据 + 音轨时长同步
  fastify.post(
    '/work/:id/refresh',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ title: z.string(), tracks: trackSyncStatsSchema }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const result = await refreshWorkMetadata(id);
        if (!result.ok) {
          if (result.reason === 'work-not-found') {
            return reply.fail(404, 'errors.media.work-not-found');
          }
          return reply.fail(500, 'errors.work-admin.failed', {
            reason: result.reason,
          });
        }
        return { title: result.title, tracks: result.tracks };
      } catch (err) {
        // DLsite 抓取 / 入库失败：消息透传给管理员界面
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Refresh failed',
        });
      }
    },
  );

  // POST /api/work/:id/sync-tracks — 按磁盘内容 diff 同步音轨时长
  fastify.post(
    '/work/:id/sync-tracks',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ tracks: trackSyncStatsSchema }),
          404: z.object({ error: z.string() }),
          500: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      try {
        const result = await syncWorkDurations(id);
        if (!result.ok) {
          if (result.reason === 'work-not-found') {
            return reply.fail(404, 'errors.media.work-not-found');
          }
          return reply.fail(500, 'errors.work-admin.failed', {
            reason: result.reason,
          });
        }
        return { tracks: result.tracks };
      } catch (err) {
        return reply.status(500).send({
          error: err instanceof Error ? err.message : 'Track sync failed',
        });
      }
    },
  );

  // DELETE /api/work/:id — 软删除（置 deletedAt；全部读路径已过滤，立即不可见）。
  // 幂等：对已软删 id 再次删除仍返回 success；仅从未入库的 id 返回 404。
  fastify.delete(
    '/work/:id',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          200: z.object({ success: z.boolean() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      if (!(await workExists(id))) {
        return reply.fail(404, 'errors.work.not-found', { id });
      }
      await softDeleteWork(id);
      return { success: true };
    },
  );
};
