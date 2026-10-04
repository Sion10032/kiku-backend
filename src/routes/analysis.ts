import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../infra/config/index.js';
import {
  type AnalysisEvent,
  type AnalysisSnapshot,
  analysisManager,
} from '../scanner/analysis.js';
import { runAnalysisOrchestration } from '../scanner/orchestrators/analysis.js';
import {
  abortBatchController,
  registerController,
  unregisterController,
} from '../scanner/orchestrators/controllers.js';
import { getTaskSystem } from '../scanner/taskSystem.js';

const analysisSnapshotSchema = z.object({
  tasks: z.array(z.object({ workId: z.string() })),
  failedTasks: z.array(z.object({ workId: z.string() })),
  completed: z.number(),
  logs: z.array(
    z.object({ level: z.string(), message: z.string(), timestamp: z.string() }),
  ),
});

export const analysisRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // SSE event stream（旧协议，迁移期保留；任务中心走 /api/tasks/events，旧端点由后续清理删除）
  fastify.get('/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    await reply.sse.send({
      event: 'ANALYSIS_INIT_STATE',
      data: {
        isAnalyzing: analysisManager.isAnalyzing,
        snapshot: analysisManager.getSnapshot(),
      },
    });

    const handler = (event: AnalysisEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    analysisManager.on('analysis', handler);

    const cleanup = (): void => {
      analysisManager.off('analysis', handler);
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });

  // Start loudness analysis（入队编排，立即返回 batchId；进度走 /api/tasks/events）。
  // workIds：目标作品子集（缺省 = 全量 pending）；
  // priority：high（作品页，cpu 池内插队）| low（管理页，缺省，scan 接力同档）
  fastify.post(
    '/start',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: z
          .object({
            workIds: z.array(z.string()).min(1).optional(),
            priority: z.enum(['high', 'low']).default('low'),
          })
          .default({ priority: 'low' }),
        response: {
          200: z.object({ success: z.boolean(), batchId: z.string() }),
        },
      },
    },
    async (request) => {
      const cfg = getConfig();
      const { workIds, priority } = request.body;
      const batchId = `analysis-${randomUUID()}`;
      const controller = new AbortController();
      registerController(batchId, controller);
      void runAnalysisOrchestration(cfg, controller.signal, workIds, priority, {
        batchId,
      })
        .catch((err) => {
          console.error('[analysis] orchestration failed:', err);
        })
        .finally(() => unregisterController(batchId));
      return { success: true, batchId };
    },
  );

  // Terminate the running analysis：按活跃 analysis 批次取消（任务 + 编排信号两侧）
  fastify.post(
    '/stop',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: z.object({ success: z.boolean() }),
          404: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const snap = getTaskSystem().snapshot();
      const active = snap.batches.find(
        (b) => b.status === 'running' && b.kind === 'analysis',
      );
      if (!active) {
        return reply.fail(404, 'errors.task.analysis-not-running');
      }
      abortBatchController(active.batchId);
      getTaskSystem().cancelBatch(active.batchId);
      return { success: true };
    },
  );

  // Current analysis state（旧协议，迁移期保留）
  fastify.get(
    '/status',
    {
      schema: {
        response: {
          200: z.object({
            isAnalyzing: z.boolean(),
            snapshot: analysisSnapshotSchema.nullable(),
          }),
        },
      },
    },
    async () => ({
      isAnalyzing: analysisManager.isAnalyzing,
      snapshot: analysisManager.getSnapshot(),
    }),
  );
};
