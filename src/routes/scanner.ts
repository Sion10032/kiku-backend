import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../config/index.js';
import { type ScanEvent, scanner } from '../filesystem/scanner.js';

export const scannerRoutes: FastifyPluginAsyncZod = async (fastify) => {
  // SSE event stream — pushes scan progress to the frontend.
  fastify.get('/events', { sse: 'only' }, async (_request, reply) => {
    reply.sse.keepAlive();

    // Send initial scan state on connect / reconnect.
    await reply.sse.send({
      event: 'SCAN_INIT_STATE',
      data: { isScanning: scanner.isScanning },
    });

    // Forward scan events to this client.
    const handler = (event: ScanEvent): void => {
      reply.sse.send({ event: event.type, data: event }).catch(() => {});
    };
    scanner.on('scan', handler);

    // Clean up on disconnect.
    reply.sse.onClose(() => {
      scanner.off('scan', handler);
    });
  });

  // Start a scan.
  fastify.post(
    '/scan',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: {
          200: z.object({ success: z.boolean() }),
        },
      },
    },
    async () => {
      const config = getConfig();
      scanner.startScan(config);
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
