// 任务中心路由：权威快照、SSE 增量流、取消（批次或单作品）。
// 快照权威：订阅先推 TASK_SNAPSHOT（含节流未发状态），后续增量 TASK_DELTA/BATCH_LOG/BATCH_SUMMARY。

import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import type { TaskEvent } from '../scanner/taskEvents.js';
import { getTaskSystem } from '../scanner/taskSystem.js';

const idParamsSchema = z.object({ id: z.string() });

export const taskRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // GET /api/tasks — 权威快照（重连补播的数据源）
  fastify.get(
    '/tasks',
    {
      schema: {
        response: {
          200: z.object({ snapshot: z.unknown() }),
        },
      },
    },
    async () => ({ snapshot: getTaskSystem().snapshot() }),
  );

  // GET /api/tasks/events — SSE：先推快照再推增量
  fastify.get('/tasks/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    const sys = getTaskSystem();
    await reply.sse.send({
      event: 'TASK_SNAPSHOT',
      data: { snapshot: sys.snapshot() },
    });

    const unsubscribe = sys.subscribe((event: TaskEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    });

    // 同时监听 raw close：若初始 send 期间客户端已断开，
    // onClose 注册的回调可能永不触发，造成监听器泄漏（对齐现有 SSE 端点）。
    const cleanup = (): void => {
      unsubscribe();
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });

  // DELETE /api/tasks/:id — id 为 batchId（取消批次）或 workId（取消单作品流水线）。
  // 待处理阶段移除、在飞阶段 abort，各池槽正常释放（对齐现状中止语义）。
  fastify.delete(
    '/tasks/:id',
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
      const snap = getTaskSystem().snapshot();
      if (snap.batches.some((b) => b.batchId === id)) {
        getTaskSystem().cancelBatch(id);
        return { success: true };
      }
      if (snap.pipelines.some((p) => p.workId === id)) {
        getTaskSystem().cancelWork(id);
        return { success: true };
      }
      return reply.fail(404, 'errors.task.not-found', { id });
    },
  );
};
