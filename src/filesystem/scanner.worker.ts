import type { Config } from '../config/schema.js';
import { getFolderList, getTrackList } from './utils.js';

interface ScanTask {
  id: number;
  title: string;
  folderPath: string;
  rootFolder: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
}

declare const self: Worker;

self.onmessage = async (event: MessageEvent) => {
  const { type, config } = event.data as { type: string; config: Config; };

  if (type === 'START_SCAN') {
    try {
      await performScan(config);
      self.postMessage({ type: 'SCAN_FINISHED', message: 'Scan completed successfully' });
    }
    catch (err) {
      self.postMessage({ type: 'SCAN_ERROR', error: String(err) });
    }
  }
};

async function performScan(config: Config): Promise<void> {
  const tasks: ScanTask[] = [];
  const failedTasks: ScanTask[] = [];
  const mainLogs: Array<{ level: string; message: string; timestamp: string; }> = [];

  // Log scan start
  mainLogs.push({
    level: 'info',
    message: 'Starting scan...',
    timestamp: new Date().toISOString(),
  });

  self.postMessage({ type: 'SCAN_MAIN_LOGS', mainLogs });

  // Scan each root folder
  for (const rootFolder of config.rootFolders) {
    mainLogs.push({
      level: 'info',
      message: `Scanning root folder: ${rootFolder.name} (${rootFolder.path})`,
      timestamp: new Date().toISOString(),
    });

    self.postMessage({ type: 'SCAN_MAIN_LOGS', mainLogs });

    const folders = getFolderList(rootFolder.path, config.scannerMaxRecursionDepth);

    for (const folderPath of folders) {
      const tracks = getTrackList(folderPath);

      if (tracks.length > 0) {
        const task: ScanTask = {
          id: tasks.length + 1,
          title: folderPath.replace(rootFolder.path, '').replace(/^\//, ''),
          folderPath,
          rootFolder: rootFolder.name,
          status: 'pending',
        };

        tasks.push(task);

        // Update tasks in real-time
        self.postMessage({
          type: 'SCAN_TASKS',
          tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
        });
      }
    }
  }

  mainLogs.push({
    level: 'info',
    message: `Found ${tasks.length} works to scan`,
    timestamp: new Date().toISOString(),
  });

  self.postMessage({ type: 'SCAN_MAIN_LOGS', mainLogs });

  // Process each task
  let added = 0;
  const updated = 0;
  let failed = 0;

  for (const task of tasks) {
    try {
      task.status = 'scanning';
      self.postMessage({
        type: 'SCAN_TASKS',
        tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
      });

      // TODO: Implement actual work creation/update logic
      // For now, just simulate processing
      await new Promise(resolve => setTimeout(resolve, 10));

      task.status = 'completed';
      added++;

      mainLogs.push({
        level: 'info',
        message: `Processed: ${task.title}`,
        timestamp: new Date().toISOString(),
      });
    }
    catch (err) {
      task.status = 'failed';
      task.error = String(err);
      failedTasks.push(task);
      failed++;

      mainLogs.push({
        level: 'error',
        message: `Failed: ${task.title} - ${String(err)}`,
        timestamp: new Date().toISOString(),
      });
    }

    // Update progress
    self.postMessage({
      type: 'SCAN_TASKS',
      tasks: tasks.map(t => ({ id: t.id, title: t.title, status: t.status })),
    });
    self.postMessage({ type: 'SCAN_MAIN_LOGS', mainLogs });
  }

  // Send final results
  self.postMessage({
    type: 'SCAN_RESULTS',
    results: {
      total: tasks.length,
      added,
      updated,
      failed,
    },
  });

  if (failedTasks.length > 0) {
    self.postMessage({
      type: 'SCAN_FAILED_TASKS',
      failedTasks: failedTasks.map(t => ({ id: t.id, title: t.title, error: t.error || 'Unknown error' })),
    });
  }
}
