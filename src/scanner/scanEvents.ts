import type { CoverType } from '../services/cover.service.js';

/** 扫描器模式：scan 扫盘发现新作品；update 遍历数据库刷新既有作品元数据。 */
export type ScanMode = 'scan' | 'update';

export interface ScanTask {
  id: number;
  title: string;
  relativePath: string;
  rootFolder: string;
  /** 作品代码（RJ/VJ/UW…，保持原样不规范化） */
  workCode: string;
  dirName: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
  /** 作品目录绝对路径（根目录绝对路径 + relativePath；手动分支导入本地封面用） */
  absDir?: string;
  /**
   * moved：DB 已有未软删记录、仅路径变更（如文件夹打包成 zip）。
   * 跳过 DLsite 元数据抓取，只更新路径 + 按需补封面 + 音轨 diff。
   */
  moved?: boolean;
  /** moved 任务封面补图用的 DB 既有 sourceId */
  knownSourceId?: string;
}

/** 扫描时确保存在的封面类型 */
export const SCAN_COVER_TYPES: CoverType[] = ['main', 'sam', '240x240'];

/** 单个任务快照（增量推送，避免整表传输） */
export interface ScanTaskPayload {
  id: number;
  title: string;
  status: 'pending' | 'scanning' | 'completed' | 'failed';
  error?: string;
}

/** 单条扫描日志 */
export interface ScanLogPayload {
  level: string;
  message: string;
  timestamp: string;
}

export type ScanEvent =
  | { type: 'SCAN_TASK'; task: ScanTaskPayload }
  | { type: 'SCAN_LOG'; log: ScanLogPayload }
  | {
      type: 'SCAN_RESULTS';
      results: {
        total: number;
        added: number;
        updated: number;
        failed: number;
        /** 本次因已扫描完成而跳过的作品数 */
        skipped: number;
        /** 源缺失被软删的作品数 */
        removed: number;
        /** 软删超期被物理清理的作品数 */
        purged: number;
      };
    }
  | { type: 'SCAN_FINISHED'; message: string }
  | { type: 'SCAN_ERROR'; error: string };

/** 重连时通过 SCAN_INIT_STATE 下发的状态快照 */
export interface ScanSnapshot {
  /** 非终态任务（pending/scanning） */
  tasks: ScanTaskPayload[];
  failedTasks: ScanTaskPayload[];
  completed: number;
  /** 最近 SCAN_LOG_CAP 条日志 */
  logs: ScanLogPayload[];
  /** 产出该快照的运行模式；缺省视为 'scan' */
  mode?: ScanMode;
}

/** 日志快照保留条数上限 */
export const SCAN_LOG_CAP = 500;

export function emptySnapshot(mode: ScanMode = 'scan'): ScanSnapshot {
  return { tasks: [], failedTasks: [], completed: 0, logs: [], mode };
}

/** 将事件应用到快照（ScannerManager 维护重连补播用；纯函数便于测试） */
export function applyScanEvent(
  snapshot: ScanSnapshot,
  event: ScanEvent,
): ScanSnapshot {
  switch (event.type) {
    case 'SCAN_TASK': {
      const { task } = event;
      // completed/failed 的任务可能仍在非终态列表中，先按 id 移除
      const tasks = snapshot.tasks.filter((t) => t.id !== task.id);
      if (task.status === 'completed') {
        return { ...snapshot, tasks, completed: snapshot.completed + 1 };
      }
      if (task.status === 'failed') {
        return {
          ...snapshot,
          tasks,
          failedTasks: [...snapshot.failedTasks, task],
        };
      }
      // pending / scanning：upsert，保持发现顺序
      const idx = tasks.findIndex((t) => t.id === task.id);
      if (idx === -1) return { ...snapshot, tasks: [...tasks, task] };
      const next = [...tasks];
      next[idx] = task;
      return { ...snapshot, tasks: next };
    }
    case 'SCAN_LOG': {
      const logs = [...snapshot.logs, event.log];
      return {
        ...snapshot,
        logs: logs.length > SCAN_LOG_CAP ? logs.slice(-SCAN_LOG_CAP) : logs,
      };
    }
    default:
      return snapshot;
  }
}

/** 单条日志事件构造（模块级，scan/update 两模式共享；顺序 yield* 与并发收集共用）。 */
export const logEvent = (level: string, message: string): ScanEvent => ({
  type: 'SCAN_LOG',
  log: { level, message, timestamp: new Date().toISOString() },
});

/** 单条日志事件 generator（logEvent 的 yield* 包装）。 */
export const emitLog = function* (
  level: string,
  message: string,
): Generator<ScanEvent, void, unknown> {
  yield logEvent(level, message);
};

/** 任务快照（模块级，两模式共享）。 */
export const stripTask = (t: ScanTask): ScanTaskPayload => ({
  id: t.id,
  title: t.title,
  status: t.status,
  error: t.error,
});
