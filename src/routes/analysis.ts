import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../infra/config/index.js';
import {
  type AnalysisEvent,
  type AnalysisSnapshot,
  analysisManager,
} from '../scanner/analysis.js';

const scanLogSchema = z.object({
  level: z.string(),
  message: z.string(),
  timestamp: z.string(),
});

const analysisTaskSchema = z.object({
  workId: z.string(),
  title: z.string(),
  status: z.enum(['pending', 'scanning', 'completed', 'failed']),
  analyzed: z.number(),
  total: z.number(),
  error: z.string().optional(),
});

const analysisSnapshotSchema: z.ZodType<AnalysisSnapshot> = z.object({
  tasks: z.array(analysisTaskSchema),
  failedTasks: z.array(analysisTaskSchema),
  completed: z.number(),
  logs: z.array(scanLogSchema),
});

export const analysisRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // SSE event stream — pushes analysis progress to the frontend.
  fastify.get('/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    // Send initial analysis state on connect / reconnect.
    await reply.sse.send({
      event: 'ANALYSIS_INIT_STATE',
      data: {
        isAnalyzing: analysisManager.isAnalyzing,
        snapshot: analysisManager.getSnapshot(),
      },
    });

    // Forward analysis events to this client.
    const handler = (event: AnalysisEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    analysisManager.on('analysis', handler);

    // Cleanup on disconnect.
    // 同时监听 raw close：若初始 send 期间客户端已断开，
    // @fastify/sse 的 cleanup 先于 onClose 注册执行，
    // 之后注册的回调永不触发，会造成 EventEmitter listener 泄漏。
    const cleanup = (): void => {
      analysisManager.off('analysis', handler);
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });

  // Start a loudness analysis (full queue, a work-ID subset, or a priority
  // bump from the work page while a run is already in progress).
  fastify.post(
    '/start',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: z
          .object({
            // workIds：目标作品子集（缺省 = 全量 pending）；
            // priority：high（作品页，已跑时插队）| low（管理页，缺省，已跑时不干扰）
            workIds: z.array(z.string()).min(1).optional(),
            priority: z.enum(['high', 'low']).default('low'),
          })
          // 无 body 时走默认值（zod v4 的 .default() 实参需匹配输出类型）
          .default({ priority: 'low' }),
        response: {
          200: z.object({ success: z.boolean(), queued: z.boolean() }),
        },
      },
    },
    async (request) => {
      const config = getConfig();
      const { workIds, priority } = request.body;
      // 启动 / 插队 / 不干扰的编排都在 manager 内：queued = 已在跑且插队成功
      const { queued } = analysisManager.startAnalysis(
        config,
        workIds,
        priority,
      );
      return { success: true, queued };
    },
  );

  // Terminate the running analysis.
  fastify.post(
    '/stop',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async () => {
      analysisManager.killAnalysis();
      return { success: true };
    },
  );

  // Current analysis state.
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
