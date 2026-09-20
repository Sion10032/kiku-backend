import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 迁移目录归属的库名。 */
export type MigrationTarget = 'main' | 'blob';

/**
 * 目录是否为 drizzle 迁移目录（含 `<timestamp>_<name>/migration.sql`）。
 * drizzle-kit 1.0 起不再生成 `meta/_journal.json`，故直接看目录内容。
 */
function isMigrationFolder(dir: string): boolean {
  if (!existsSync(dir)) {
    return false;
  }
  return readdirSync(dir, { withFileTypes: true }).some(
    (entry) =>
      entry.isDirectory() && existsSync(join(dir, entry.name, 'migration.sql')),
  );
}

/**
 * 定位迁移目录，抹平源码运行与打包运行的布局差异。
 *
 * - 源码态：`<baseDir>/<db>/migrations`（如 `src/infra/db/main/migrations`）
 * - 打包态：`<baseDir>/migrations/<db>`（`build.ts` 拷到 `dist/migrations/<db>`）
 *
 * @param target 库名
 * @param baseDir 基准目录，默认取本模块所在目录——源码态是 `src/infra/db/`，
 *   打包态本模块被内联进 `dist/index.js`，故为 `dist/`
 */
export function resolveMigrationsFolder(
  target: MigrationTarget,
  baseDir: string = import.meta.dir,
): string {
  const candidates = [
    join(baseDir, target, 'migrations'),
    join(baseDir, 'migrations', target),
  ];

  const found = candidates.find(isMigrationFolder);
  if (!found) {
    throw new Error(
      `Migrations folder for "${target}" not found (tried: ${candidates.join(', ')})`,
    );
  }
  return found;
}
