import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnvironment } from '@test/helpers/setup';
import { sql } from 'drizzle-orm';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { MIGRATION_EVENT, type MigrationJobEvent, migration } from './job.js';
import { makeOldDb, writeOldConfig } from './kikoeru.test.js';

setupTestEnvironment();

/** job 专用 WORK_DIR（目录名唯一，避免与其他测试文件的 old-data 互相污染） */
const workDir = join(tmpdir(), `kiku-job-${Date.now().toString(36)}`);
const oldDataDir = join(workDir, 'old-data');

async function waitIdle(): Promise<void> {
  for (let i = 0; i < 400 && migration.getState().running; i++) {
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** 重建 old-data fixture：旧库 + 可选旧 config + 可选封面（封面产生进度事件并拖长运行窗口） */
function buildOldData(opts: { withConfig?: boolean; covers?: number } = {}) {
  rmSync(oldDataDir, { recursive: true, force: true });
  const db0 = makeOldDb(oldDataDir, 'number178-fork');
  db0.close();
  if (opts.withConfig !== false) writeOldConfig(oldDataDir);
  if (opts.covers) {
    const coversDir = join(oldDataDir, 'covers');
    mkdirSync(coversDir, { recursive: true });
    const kb = Buffer.alloc(1024, 1);
    for (let i = 1; i <= opts.covers; i++) {
      writeFileSync(
        join(coversDir, `RJ${String(i).padStart(6, '0')}_img_full.jpg`),
        kb,
      );
    }
  }
}

/** 清空迁移门禁（新库 works 非空 + config 迁移标记），使下一次 start 可执行 */
async function resetGates(): Promise<void> {
  await db.run(sql`DELETE FROM t_work`);
  setConfigForTesting({ ...getConfig(), kikoeruMigratedAt: undefined });
}

beforeAll(() => {
  // getOldDataDir = WORK_DIR/old-data，在 beforeAll 覆盖以隔离本文件的 fixture
  process.env.WORK_DIR = workDir;
});

afterAll(() => {
  // 恢复 config，避免 md5secret/迁移标记污染同进程其他测试
  setConfigForTesting({
    ...getConfig(),
    md5secret: 'test-md5-secret',
    kikoeruMigratedAt: undefined,
  });
  try {
    rmSync(workDir, { recursive: true, force: true });
  } catch {
    /* WAL 文件句柄未释放时可能失败，忽略 */
  }
});

describe('migration job', () => {
  it('start→完成：终态保留 stats，事件含 PROGRESS/DONE', async () => {
    migration.reset();
    buildOldData({ covers: 250 }); // 250 张 200/批 → 至少两批进度
    await resetGates();
    const events: MigrationJobEvent[] = [];
    const handler = (e: MigrationJobEvent): void => {
      events.push(e);
    };
    migration.on(MIGRATION_EVENT, handler);
    expect(migration.start()).toBe(true);
    await waitIdle();
    migration.off(MIGRATION_EVENT, handler);

    const s = migration.getState();
    expect(s.running).toBe(false);
    expect(s.stats).not.toBeNull();
    expect(s.stats?.works).toBe(2);
    expect(s.error).toBeNull();
    // 进度写回 state（封面全部导入后的终值）
    expect(s.imported).toBe(250);
    expect(s.total).toBe(250);
    // 事件序列：首个进度 = 首批 200 张，末尾为 DONE（携带 stats）
    expect(events[0]).toEqual({
      type: 'MIGRATION_PROGRESS',
      imported: 200,
      total: 250,
    });
    expect(events.filter((e) => e.type === 'MIGRATION_PROGRESS')).toHaveLength(
      2,
    );
    // DONE 事件携带与终态一致的 stats
    const done = events.find(
      (e): e is Extract<MigrationJobEvent, { type: 'MIGRATION_DONE' }> =>
        e.type === 'MIGRATION_DONE',
    );
    expect(done?.stats ?? null).toEqual(s.stats);
  });

  it('运行中重复 start 返回 false（不重入）', async () => {
    migration.reset();
    buildOldData({ covers: 250 }); // 较大 covers 拖长运行窗口
    await resetGates();
    expect(migration.start()).toBe(true);
    expect(migration.getState().running).toBe(true);
    expect(migration.start()).toBe(false);
    await waitIdle();
    expect(migration.getState().running).toBe(false);
  });

  it('reset 清空终态', async () => {
    migration.reset();
    expect(migration.getState()).toEqual({
      running: false,
      imported: 0,
      total: 0,
      stats: null,
      error: null,
    });
  });

  it('失败路径：old-data 缺 config → error 终态保留 + MIGRATION_ERROR', async () => {
    migration.reset();
    buildOldData({ withConfig: false }); // 只放旧库，不放 config/config.json（门禁 3 拒绝）
    await resetGates();
    const events: MigrationJobEvent[] = [];
    const handler = (e: MigrationJobEvent): void => {
      events.push(e);
    };
    migration.on(MIGRATION_EVENT, handler);
    expect(migration.start()).toBe(true);
    await waitIdle();
    migration.off(MIGRATION_EVENT, handler);

    const s = migration.getState();
    expect(s.running).toBe(false);
    expect(s.stats).toBeNull();
    expect(s.error).toContain('config/config.json');
    expect(events.map((e) => e.type)).toContain('MIGRATION_ERROR');
    // 终态保留：直到下次 start / reset 才清空
    expect(migration.getState().error).not.toBeNull();
  });
});
