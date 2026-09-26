import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getConfig } from '../../config/index.js';
import { resolveMigrationsFolder } from '../migrations.js';
import { relations } from './relations.js';

// 获取数据库路径
function getDatabasePath(): string {
  const config = getConfig();
  const workDir = process.env.WORK_DIR || process.cwd();
  const dbDir = config.databaseFolderDir.startsWith('/')
    ? config.databaseFolderDir
    : join(workDir, config.databaseFolderDir);

  // 确保数据库目录存在
  if (!existsSync(dbDir)) {
    mkdirSync(dbDir, { recursive: true });
  }

  return join(dbDir, 'kiku.db');
}

const sqlite = new Database(getDatabasePath(), {
  strict: true,
});

sqlite.run('PRAGMA journal_mode = WAL');
sqlite.run('PRAGMA busy_timeout = 1000');

export const db = drizzle({ client: sqlite, relations });

/** 事务回调句柄（bun:sqlite 同步方言，回调必须同步执行）。 */
export type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/** 查询执行器：事务句柄或 db 本身。二者都能 .get()/.all()/.run() 同步终结，
 * 数据访问原语用它作首参，调用方显式表达执行上下文（事务内传 tx，事务外传 db）。 */
export type DbExecutor = typeof db | Tx;

// Run pending migrations on startup (idempotent via __drizzle_migrations table).
// 必须在 PRAGMA foreign_keys = ON 之前执行：SQLite 的表重建（DROP + RENAME）在
// FK 开启时会因隐式 DELETE 触发子表 ON DELETE CASCADE，清空评论/进度/音轨；
// 而迁移内的 PRAGMA 在事务内无效（见对应 migration.sql 顶部注释）。
migrate(db, { migrationsFolder: resolveMigrationsFolder('main') });

// 迁移完成后再打开外键（运行时需要 ON UPDATE CASCADE 与删除级联）。
sqlite.run('PRAGMA foreign_keys = ON');
