import type { FastifyInstance } from 'fastify';
import { Server } from 'socket.io';
import { startScan, killScan, isScanRunning, type ScanMessage } from '../filesystem/scanner.js';
import { getConfig } from '../config/index.js';

let io: Server | null = null;

export function setupWebSocket(fastify: FastifyInstance): void {
  const config = getConfig();

  io = new Server(fastify.server, {
    cors: config.production
      ? { origin: false }
      : { origin: '*' },
  });

  io.on('connection', (socket) => {
    console.log(`[WebSocket] Client connected: ${socket.id}`);

    // Send initial scan state
    socket.emit('SCAN_INIT_STATE', {
      isScanning: isScanRunning(),
    });

    // Handle scan request
    socket.on('PERFORM_SCAN', () => {
      if (isScanRunning()) {
        socket.emit('SCAN_ERROR', { error: 'Scan is already in progress' });
        return;
      }

      try {
        const config = getConfig();
        const worker = startScan(config);

        // Forward worker messages to all clients
        worker.onmessage = (event: MessageEvent<ScanMessage>) => {
          const msg = event.data;
          if (io) {
            io.emit(msg.type, msg);
          }
        };

        worker.onerror = (event) => {
          if (io) {
            io.emit('SCAN_ERROR', { error: event.message });
          }
        };

        socket.emit('success', { message: 'Scan started' });
      }
      catch (err) {
        socket.emit('SCAN_ERROR', { error: String(err) });
      }
    });

    // Handle metadata update request
    socket.on('PERFORM_UPDATE', () => {
      // TODO: Implement metadata update
      socket.emit('success', { message: 'Update not implemented yet' });
    });

    // Handle kill scan request
    socket.on('KILL_SCAN_PROCESS', () => {
      if (isScanRunning()) {
        killScan();
        socket.emit('success', { message: 'Scan terminated' });
      }
      else {
        socket.emit('SCAN_ERROR', { error: 'No scan is running' });
      }
    });

    // Handle scanner page notification
    socket.on('ON_SCANNER_PAGE', () => {
      // Send current state when client enters scanner page
      socket.emit('SCAN_INIT_STATE', {
        isScanning: isScanRunning(),
      });
    });

    socket.on('disconnect', () => {
      console.log(`[WebSocket] Client disconnected: ${socket.id}`);
    });
  });
}

export function broadcastToAdmin(event: string, data: unknown): void {
  if (io) {
    io.emit(event, data);
  }
}

export function getWebSocketServer(): Server | null {
  return io;
}
