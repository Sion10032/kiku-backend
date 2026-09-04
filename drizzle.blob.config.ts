import { join } from 'node:path';
import { defineConfig } from 'drizzle-kit';
import { getConfig } from './src/infra/config/index.js';

// 获取二进制数据库路径（与主库同目录，文件名不同）
function getBlobDatabasePath(): string {
  const config = getConfig();
  const workDir = process.env.WORK_DIR || process.cwd();
  const dbDir = config.databaseFolderDir.startsWith('/')
    ? config.databaseFolderDir
    : join(workDir, config.databaseFolderDir);

  return join(dbDir, 'blob.db');
}

export default defineConfig({
  schema: './src/infra/db/blob/schema.ts',
  out: './src/infra/db/blob/migrations',
  dialect: 'sqlite',
  dbCredentials: {
    url: getBlobDatabasePath(),
  },
});
