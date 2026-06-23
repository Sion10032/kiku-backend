import type { Config } from '../config/schema.js';

export type ScanMessage =
  | { type: 'SCAN_TASKS'; tasks: Array<{ id: number; title: string; status: string; }>; }
  | { type: 'SCAN_FAILED_TASKS'; failedTasks: Array<{ id: number; title: string; error: string; }>; }
  | { type: 'SCAN_MAIN_LOGS'; mainLogs: Array<{ level: string; message: string; timestamp: string; }>; }
  | { type: 'SCAN_RESULTS'; results: { total: number; added: number; updated: number; failed: number; }; }
  | { type: 'SCAN_FINISHED'; message: string; }
  | { type: 'SCAN_ERROR'; error: string; };

let currentWorker: Worker | null = null;

export function startScan(config: Config): Worker {
  if (currentWorker) {
    throw new Error('Scan is already in progress');
  }

  const worker = new Worker(new URL('./scanner.worker.ts', import.meta.url).href);

  worker.onmessage = (event: MessageEvent<ScanMessage>) => {
    const msg = event.data;
    broadcastToAdmin(msg.type, msg);
  };

  worker.onerror = (event) => {
    broadcastToAdmin('SCAN_ERROR', { type: 'SCAN_ERROR', error: event.message });
    currentWorker = null;
  };

  worker.addEventListener('close', () => {
    currentWorker = null;
  });

  worker.postMessage({ type: 'START_SCAN', config });
  currentWorker = worker;
  return worker;
}

export function killScan(): void {
  if (currentWorker) {
    currentWorker.terminate();
    currentWorker = null;
  }
}

export function isScanRunning(): boolean {
  return currentWorker !== null;
}

function broadcastToAdmin(event: string, data: unknown): void {
  // This will be implemented in websocket.ts
  console.log(`[Scanner] ${event}:`, data);
}
