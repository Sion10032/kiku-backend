import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { getConfig } from './src/infra/config/index.js';

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
  schema: './src/infra/db/main/schema.ts',
  out: './src/infra/db/main/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: process.env.DATABASE_URL || getDatabasePath(),
  },
});
