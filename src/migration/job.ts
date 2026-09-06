import { EventEmitter } from 'node:events';
import {
  getOldDataDir,
  type KikoeruMigrationStats,
  migrateFromKikoeru,
} from './kikoeru.js';

export const MIGRATION_EVENT = 'migration';

export type MigrationJobEvent =
  | { type: 'MIGRATION_PROGRESS'; imported: number; total: number }
  | { type: 'MIGRATION_DONE'; stats: KikoeruMigrationStats }
  | { type: 'MIGRATION_ERROR'; error: string };

export interface MigrationJobState {
  running: boolean;
  imported: number;
  total: number;
  stats: KikoeruMigrationStats | null;
  error: string | null;
}

function emptyState(): MigrationJobState {
  return { running: false, imported: 0, total: 0, stats: null, error: null };
}

/**
 * kikoeru 迁移后台 job（一次性操作，仅 setup 使用）：
 * - 终态（DONE/ERROR）保留，供 SSE 重连重放；重置仅两个时机：下次 start、setup 提交成功。
 * - 持久真相是 config.kikoeruMigratedAt，内存态丢失（重启）不影响正确性。
 */
export class MigrationJob extends EventEmitter {
  private state: MigrationJobState = emptyState();

  getState(): MigrationJobState {
    return this.state;
  }

  /** 启动迁移；运行中返回 false（不重入）。 */
  start(): boolean {
    if (this.state.running) return false;
    this.state = { ...emptyState(), running: true };
    void this.run();
    return true;
  }

  /** 清空终态（running 时不允许）。 */
  reset(): void {
    if (!this.state.running) this.state = emptyState();
  }

  private async run(): Promise<void> {
    try {
      const result = await migrateFromKikoeru(getOldDataDir(), (p) => {
        this.state.imported = p.imported;
        this.state.total = p.total;
        this.emit(MIGRATION_EVENT, {
          type: 'MIGRATION_PROGRESS',
          imported: p.imported,
          total: p.total,
        } satisfies MigrationJobEvent);
      });
      if (result.ok && result.stats) {
        this.state = { ...this.state, running: false, stats: result.stats };
        this.emit(MIGRATION_EVENT, {
          type: 'MIGRATION_DONE',
          stats: result.stats,
        } satisfies MigrationJobEvent);
      } else {
        const error = result.error ?? '迁移失败';
        this.state = { ...this.state, running: false, error };
        this.emit(MIGRATION_EVENT, {
          type: 'MIGRATION_ERROR',
          error,
        } satisfies MigrationJobEvent);
      }
    } catch (err) {
      const error = `迁移失败：${String(err)}`;
      this.state = { ...this.state, running: false, error };
      this.emit(MIGRATION_EVENT, {
        type: 'MIGRATION_ERROR',
        error,
      } satisfies MigrationJobEvent);
    }
  }
}

export const migration = new MigrationJob();
