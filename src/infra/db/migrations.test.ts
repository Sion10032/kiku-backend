import { afterEach, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveMigrationsFolder } from './migrations';

const tempRoots: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'kiku-migrations-'));
  tempRoots.push(dir);
  return dir;
}

/** 造一个 drizzle 迁移目录：`<dir>/<timestamp>_<name>/migration.sql` */
function writeMigrationFolder(
  dir: string,
  name = '20260101000000_initial',
): void {
  mkdirSync(join(dir, name), { recursive: true });
  writeFileSync(join(dir, name, 'migration.sql'), 'SELECT 1;');
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop() as string, { recursive: true, force: true });
  }
});

describe('resolveMigrationsFolder', () => {
  it('命中源码态布局（baseDir 为 src/infra/db，迁移在 <db>/migrations）', () => {
    const dbRoot = tempDir();
    writeMigrationFolder(join(dbRoot, 'main', 'migrations'));

    expect(resolveMigrationsFolder('main', dbRoot)).toBe(
      join(dbRoot, 'main', 'migrations'),
    );
  });

  it('命中打包态布局（baseDir 为 dist，迁移在 dist/migrations/<db>）', () => {
    const dist = tempDir();
    writeMigrationFolder(join(dist, 'migrations', 'blob'));

    expect(resolveMigrationsFolder('blob', dist)).toBe(
      join(dist, 'migrations', 'blob'),
    );
  });

  it('两种布局并存时优先源码态', () => {
    const base = tempDir();
    writeMigrationFolder(
      join(base, 'main', 'migrations'),
      '20260101000000_source',
    );
    writeMigrationFolder(
      join(base, 'migrations', 'main'),
      '20260101000000_bundled',
    );

    expect(resolveMigrationsFolder('main', base)).toBe(
      join(base, 'main', 'migrations'),
    );
  });

  it('目录存在但没有 migration.sql 时视为未命中', () => {
    const dist = tempDir();
    mkdirSync(join(dist, 'migrations', 'main'), { recursive: true });

    expect(() => resolveMigrationsFolder('main', dist)).toThrow(
      /Migrations folder for "main" not found/,
    );
  });

  it('都不命中时抛出错误，错误信息带上尝试过的路径', () => {
    const base = tempDir();

    expect(() => resolveMigrationsFolder('main', base)).toThrow(
      join(base, 'migrations', 'main'),
    );
  });
});
