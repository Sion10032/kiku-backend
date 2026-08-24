import { drizzle } from 'drizzle-orm/bun-sqlite';
import { migrate } from 'drizzle-orm/bun-sqlite/migrator';
import { Database } from 'bun:sqlite';
import * as schema from './schema.js';
import * as relations from './relations.js';
import { getConfig } from '../../config/index.js';
import { join } from 'path';
import { existsSync, mkdirSync } from 'fs';

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

export const db = drizzle(sqlite, { schema: { ...schema, ...relations } });

// Run pending migrations on startup (idempotent via __drizzle_migrations table)
migrate(db, { migrationsFolder: './src/db/main/migrations' });
