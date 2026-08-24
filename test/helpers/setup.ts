import { mkdirSync, existsSync, writeFileSync } from 'fs';
import { join } from 'path';

export function setupTestEnvironment(): void {
  // 获取工作目录
  const workDir = process.env.WORK_DIR || process.cwd();

  // 创建数据目录
  const dataDir = join(workDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 创建sqlite目录
  const sqliteDir = join(dataDir, 'sqlite');
  if (!existsSync(sqliteDir)) {
    mkdirSync(sqliteDir, { recursive: true });
  }

  // Create a default config file for testing
  if (!existsSync('./config.json')) {
    const defaultConfig = {
      md5secret: 'test-md5-secret',
      jwtsecret: 'test-jwt-secret',
      databaseFolderDir: './data/sqlite',
    };
    writeFileSync(
      './config.json',
      JSON.stringify(defaultConfig, null, 2),
      'utf-8',
    );
  }
}
