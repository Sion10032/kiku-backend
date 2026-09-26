import { eq } from 'drizzle-orm';
import { db } from '../../src/infra/db/main/index.js';
import { rootFolders } from '../../src/infra/db/main/schema.js';

/**
 * 确保根目录行存在（works.root_folder 的 FK 前置）。name 相同则复用，返回 name。
 * 原 `setConfigForTesting({ ...rootFolders })` 夹具的替代品：根目录现在住在
 * t_root_folder 表里（见 plans/2026-09-25-root-folders-table.md）。
 *
 * 注意：performScan / performUpdate 会遍历表里**全部**根目录，所以创建了根目录行的
 * 测试文件应在 afterAll 里删掉自己创建的行（先删 works 再删 rootFolders，FK restrict），
 * 否则同进程后续测试文件的扫描会看到指向已删临时目录的残留根目录。
 */
export async function ensureRootFolder(
  name: string,
  path: string | null = `/tmp/kiku-${name}`,
): Promise<string> {
  await db.insert(rootFolders).values({ name, path }).onConflictDoNothing();
  return name;
}

/** 删除根目录行（调用方需先删/清空引用它的 works）。 */
export async function removeRootFolder(name: string): Promise<void> {
  await db.delete(rootFolders).where(eq(rootFolders.name, name));
}
