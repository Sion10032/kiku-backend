import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

let testRoot: string | null = null;

/**
 * 测试环境隔离：CONFIG_PATH 指向临时目录内的专用配置与数据库。
 *
 * 后端真实配置在 ./data/config.json、库在 ./data/sqlite/kiku.db（blob.db），
 * 若不隔离，测试会直接读写真实库（历史遗留行为，曾因真实扫描数据进入
 * 库导致 /works 分页断言失败）。
 *
 * - 每个测试进程首次调用时创建 mkdtemp 临时目录，写入专用 config
 *   （databaseFolderDir 用绝对路径指向临时子目录），并设置 CONFIG_PATH
 * - 同进程内模块（db/client 等）是共享单例，故幂等：已设置则跳过
 * - 进程退出时清理临时目录
 */
export function setupTestEnvironment(): void {
  if (process.env.CONFIG_PATH) return;

  testRoot = join(
    tmpdir(),
    `kiku-test-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const sqliteDir = join(testRoot, 'sqlite');
  mkdirSync(sqliteDir, { recursive: true });

  // 与真实配置同结构的最小测试配置；其余字段走 schema 默认值
  writeFileSync(
    join(testRoot, 'config.json'),
    JSON.stringify(
      {
        md5secret: 'test-md5-secret',
        jwtsecret: 'test-jwt-secret',
        databaseFolderDir: sqliteDir,
      },
      null,
      2,
    ),
    'utf-8',
  );

  process.env.CONFIG_PATH = join(testRoot, 'config.json');

  // 兼容：部分代码依赖 ./data 目录存在（如 app.ts 静态目录）
  const workDir = process.env.WORK_DIR || process.cwd();
  const dataDir = join(workDir, 'data');
  if (!existsSync(dataDir)) {
    mkdirSync(dataDir, { recursive: true });
  }

  // 进程退出清理（尽力而为；tmpdir 即使残留也会被系统清理）
  process.on('exit', () => {
    if (testRoot) {
      try {
        rmSync(testRoot, { recursive: true, force: true });
      } catch {
        /* WAL 文件句柄未释放时可能失败，忽略 */
      }
    }
  });
}
