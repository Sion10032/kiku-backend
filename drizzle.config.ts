import { defineConfig } from 'drizzle-kit';
import { getConfig } from './src/config/index.js';
import { join } from 'path';

// 获取数据库路径
function getDatabasePath(): string {
  const config = getConfig();
  const workDir = process.env.WORK_DIR || process.cwd();
  const dbDir = config.databaseFolderDir.startsWith('/')
    ? config.databaseFolderDir
    : join(workDir, config.databaseFolderDir);

  return join(dbDir, 'kiku.db');
}

export default defineConfig({
  schema: './src/db/schema.ts',
  out: './src/db/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || getDatabasePath(),
  },
});
