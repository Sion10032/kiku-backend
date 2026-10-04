import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { workSourceResolver } from '../infra/sources/index.js';
import { getTaskSystem } from '../scanner/taskSystem.js';
import {
  getWorkRow,
  liveWorkExists,
  softDeleteWork,
  softDeleteWorks,
  workExists,
} from '../services/work.service.js';

const idParamsSchema = z.object({
  id: z.string(),
});

type WorkOpErrorKey =
  | 'errors.media.work-not-found'
  | 'errors.media.manual-work-no-remote'
  | 'errors.task.work-in-progress';

/** 异步手动操作公共段：作品校验（含 manual 拒绝）→ 高优注入 → 202/409。 */
async function submitWorkOp(
  id: string,
  phases: Array<'metadata' | 'cover' | 'track' | 'analyze'>,
  opts: { rejectManual: boolean },
): Promise<
  | { ok: true; workId: string }
  | { ok: false; code: 404 | 409; errorKey: WorkOpErrorKey }
> {
  const work = await getWorkRow(id);
  if (!work || !(await liveWorkExists(id))) {
    return { ok: false, code: 404, errorKey: 'errors.media.work-not-found' };
  }
  if (opts.rejectManual && workSourceResolver.classify(id) === 'manual') {
    // 手动作品无 DLsite 来源：语义冲突（非服务器错误），409（对齐现状）
    return {
      ok: false,
      code: 409,
      errorKey: 'errors.media.manual-work-no-remote',
    };
  }
  const report = getTaskSystem().submit([id], phases, {
    priority: 'high',
    mode: 'force',
    locations: {
      [id]: {
        rootFolder: work.rootFolder,
        relativePath: work.dir,
        dirName: work.dir,
      },
    },
  });
  if (report.rejected.length > 0) {
    return { ok: false, code: 409, errorKey: 'errors.task.work-in-progress' };
  }
  return { ok: true, workId: id };
}

/**
 * 作品管理端点（管理员专用）：单作品异步运维（刷新元数据 / 同步音轨 / 立即分析）
 * 与删除/批量软删除。手动操作以高优先级入队（202 + workId，进度走 /api/tasks），
 * 不再阻塞 HTTP 等待 DLsite；同作品在飞时 409。
 */
export const workAdminRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // POST /api/work/:id/refresh — 重抓 DLsite 元数据 + 封面 + 音轨时长同步（高优入队）
  fastify.post(
    '/work/:id/refresh',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ workId: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await submitWorkOp(id, ['metadata', 'cover', 'track'], {
        rejectManual: true,
      });
      if (!result.ok) {
        return reply.fail(result.code, result.errorKey);
      }
      return reply.status(202).send({ workId: result.workId });
    },
  );

  // POST /api/work/:id/sync-tracks — 按磁盘内容 diff 同步音轨时长（高优入队）
  fastify.post(
    '/work/:id/sync-tracks',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ workId: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await submitWorkOp(id, ['track'], { rejectManual: false });
      if (!result.ok) {
        return reply.fail(result.code, result.errorKey);
      }
      return reply.status(202).send({ workId: result.workId });
    },
  );

  // POST /api/work/:id/analyze — 立即响度分析（高优入队，cpu 池内插队）
  fastify.post(
    '/work/:id/analyze',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        params: idParamsSchema,
        response: {
          202: z.object({ workId: z.string() }),
          404: z.object({ error: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      const { id } = request.params;
      const result = await submitWorkOp(id, ['analyze'], {
        rejectManual: false,
      });
      if (!result.ok) {
        return reply.fail(result.code, result.errorKey);
      }
      return reply.status(202).send({ workId: result.workId });
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
      // 幂等：对已软删 id 再次删除仍返回 success（workExists 含软删）
      if (!(await workExists(id))) {
        return reply.fail(404, 'errors.work.not-found', { id });
      }
      await softDeleteWork(id);
      return { success: true };
    },
  );

  // POST /api/works/batch-delete — 批量软删除（音声管理页多选），语义同 DELETE /work/:id：
  // 已软删 id 幂等跳过（不刷新删除时间）；单条 UPDATE，无部分完成状态；返回本次删除数。
  fastify.post(
    '/works/batch-delete',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: z.object({ ids: z.array(z.string()).min(1) }),
        response: {
          200: z.object({ success: z.boolean(), deleted: z.number() }),
        },
      },
    },
    async (request) => {
      const ids = [...new Set(request.body.ids)];
      const deleted = await softDeleteWorks(ids);
      return { success: true, deleted };
    },
  );
};
