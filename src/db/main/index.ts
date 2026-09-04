import { Database } from 'bun:sqlite';
import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { getConfig } from '../../infra/config/index.js';
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

sqlite.exec('PRAGMA journal_mode = WAL');
sqlite.exec('PRAGMA busy_timeout = 1000');
sqlite.exec('PRAGMA foreign_keys = ON');

export const db = drizzle({ client: sqlite, relations });

// Run pending migrations on startup (idempotent via __drizzle_migrations table)
migrate(db, { migrationsFolder: './src/db/main/migrations' });
