import { randomUUID } from 'node:crypto';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../infra/config/index.js';
import { runAnalysisOrchestration } from '../scanner/orchestrators/analysis.js';
import {
  abortBatchController,
  registerController,
  unregisterController,
} from '../scanner/orchestrators/controllers.js';
import {
  isIdentityHeld,
  runScanOrchestration,
  SCAN_ALL_IDENTITY,
} from '../scanner/orchestrators/scan.js';
import { runUpdateOrchestration } from '../scanner/orchestrators/update.js';
import { type ScanEvent, scanner } from '../scanner/scanner.js';
import { getTaskSystem } from '../scanner/taskSystem.js';

export const scannerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // SSE event stream（旧协议，迁移期保留；任务中心走 /api/tasks/events，旧端点由后续清理删除）
  fastify.get('/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    await reply.sse.send({
      event: 'SCAN_INIT_STATE',
      data: { isScanning: scanner.isScanning, snapshot: scanner.getSnapshot() },
    });

    const handler = (event: ScanEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    scanner.on('scan', handler);

    const cleanup = (): void => {
      scanner.off('scan', handler);
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });

  // Start a scan（入队编排，立即返回 batchId；进度走 /api/tasks/events）。
  // body 缺省（{} 或无 body）时 mode 默认 scan，旧调用方行为不变。
  // workIds：update 模式的作品子集（音声管理页按选中项刷新）；
  // scan 模式扫盘发现新作品，不接受子集，携带即 400；空数组无子集语义，同样 400。
  fastify.post(
    '/scan',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: z
          .object({
            mode: z.enum(['scan', 'update']).default('scan'),
            workIds: z.array(z.string()).min(1).optional(),
          })
          // 无 body 时走默认值（zod v4 的 .default() 实参需匹配输出类型）
          .default({ mode: 'scan' })
          .refine(
            (body) => body.mode !== 'scan' || body.workIds === undefined,
            { message: 'workIds is only supported with mode "update"' },
          ),
        response: {
          200: z.object({ success: z.boolean(), batchId: z.string() }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (request, reply) => {
      if (isIdentityHeld(SCAN_ALL_IDENTITY)) {
        return reply.fail(409, 'errors.task.scan-in-progress');
      }
      const cfg = getConfig();
      const batchId =
        request.body.mode === 'update'
          ? `update-${randomUUID()}`
          : `scan-${randomUUID()}`;
      const controller = new AbortController();
      registerController(batchId, controller);

      const settle = (): void => unregisterController(batchId);
      if (request.body.mode === 'update') {
        void runUpdateOrchestration(
          cfg,
          controller.signal,
          request.body.workIds,
          {
            batchId,
          },
        )
          .catch((err) => {
            console.error('[scanner] update orchestration failed:', err);
          })
          .finally(settle);
      } else {
        void runScanOrchestration(cfg, controller.signal, {
          batchId,
          // 自动接力：scan 正常收尾 + autoLoudnessAnalysis 开启 → analysis 编排器（low）
          chain: async (chainConfig, chainSignal) => {
            if (!chainConfig.autoLoudnessAnalysis) return;
            await runAnalysisOrchestration(
              chainConfig,
              chainSignal,
              undefined,
              'low',
            );
          },
        })
          .catch((err) => {
            console.error('[scanner] scan orchestration failed:', err);
          })
          .finally(settle);
      }
      return { success: true, batchId };
    },
  );

  // Terminate the running scan/update：按活跃 scan:all 批次取消（任务 + 编排信号两侧）
  fastify.post(
    '/kill',
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
        (b) =>
          b.status === 'running' && (b.kind === 'scan' || b.kind === 'update'),
      );
      if (!active) {
        return reply.fail(404, 'errors.task.scan-not-running');
      }
      abortBatchController(active.batchId);
      getTaskSystem().cancelBatch(active.batchId);
      return { success: true };
    },
  );
};
