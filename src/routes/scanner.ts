import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../infra/config/index.js';
import { type ScanEvent, scanner } from '../scanner/scanner.js';

export const scannerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // SSE event stream — pushes scan progress to the frontend.
  fastify.get('/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    // Send initial scan state on connect / reconnect.
    await reply.sse.send({
      event: 'SCAN_INIT_STATE',
      data: { isScanning: scanner.isScanning, snapshot: scanner.getSnapshot() },
    });

    // Forward scan events to this client.
    const handler = (event: ScanEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    scanner.on('scan', handler);

    // Cleanup on disconnect.
    // 同时监听 raw close：若初始 send 期间客户端已断开，
    // @fastify/sse 的 cleanup 先于 onClose 注册执行，
    // 之后注册的回调永不触发，会造成 EventEmitter listener 泄漏。
    const cleanup = (): void => {
      scanner.off('scan', handler);
    };
    reply.sse.onClose(cleanup);
    reply.raw.on('close', cleanup);
  });

  // Start a scan.
  // body 缺省（{} 或无 body）时 mode 默认 scan，旧调用方行为不变。
  fastify.post(
    '/scan',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        body: z
          .object({
            mode: z.enum(['scan', 'update']).default('scan'),
          })
          // 无 body 时走默认值（zod v4 的 .default() 实参需匹配输出类型）
          .default({ mode: 'scan' }),
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async (request) => {
      const config = getConfig();
      scanner.startScan(config, request.body.mode);
      return { success: true };
    },
  );

  // Terminate the running scan.
  fastify.post(
    '/kill',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async () => {
      scanner.killScan();
      return { success: true };
    },
  );
};
