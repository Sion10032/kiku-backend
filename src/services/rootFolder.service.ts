import { eq, sql } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  type RootFolder,
  rootFolders,
  works,
} from '../infra/db/main/schema.js';

export type { RootFolder };

export async function listRootFolders(): Promise<RootFolder[]> {
  return db.select().from(rootFolders).orderBy(rootFolders.name);
}

export async function getRootFolderByName(
  name: string,
): Promise<RootFolder | null> {
  const rows = await db
    .select()
    .from(rootFolders)
    .where(eq(rootFolders.name, name))
    .limit(1);
  return rows[0] ?? null;
}

/**
 * 解析根目录路径（全部读取点的统一入口）。null = 行不存在或路径未配置，
 * 两者对调用方等价于旧的 root-folder-not-found。
 */
export async function getRootFolderPathByName(
  name: string,
): Promise<string | null> {
  return (await getRootFolderByName(name))?.path ?? null;
}

export async function createRootFolder(input: {
  name: string;
  path: string;
}): Promise<
  { ok: true; folder: RootFolder } | { ok: false; reason: 'name-taken' }
> {
  if (await getRootFolderByName(input.name))
    return { ok: false, reason: 'name-taken' };
  const result = await db.insert(rootFolders).values(input).returning();
  const folder = result[0];
  if (!folder) throw new Error(`root folder create failed: ${input.name}`);
  return { ok: true, folder };
}

/**
 * 更新 / 重命名。name 是主键，改名就是 PK 更新：works.root_folder 由
 * FK ON UPDATE CASCADE 自动跟随（**依赖运行期 foreign_keys = ON**，见 main/index.ts）。
 * 互换两个目录的名字需要中间名过渡，本接口不做特殊处理。
 */
export async function updateRootFolder(
  currentName: string,
  input: { name: string; path: string },
): Promise<
  | { ok: true; folder: RootFolder }
  | { ok: false; reason: 'not-found' | 'name-taken' }
> {
  if (!(await getRootFolderByName(currentName)))
    return { ok: false, reason: 'not-found' };
  if (input.name !== currentName && (await getRootFolderByName(input.name))) {
    return { ok: false, reason: 'name-taken' };
  }
  const result = await db
    .update(rootFolders)
    .set({ name: input.name, path: input.path })
    .where(eq(rootFolders.name, currentName))
    .returning();
  const folder = result[0];
  if (!folder) throw new Error(`root folder update failed: ${currentName}`);
  return { ok: true, folder };
}

/**
 * 删除根目录。名下有作品（**含软删**）一律拒绝：软删行仍需要 root_folder 参与 prune 与
 * 宽限期恢复。统计与 DELETE 放同一事务，避免先查后删的竞态。
 */
export async function deleteRootFolder(
  name: string,
): Promise<
  | { ok: true }
  | { ok: false; reason: 'not-found' | 'has-works'; workCount: number }
> {
  return db.transaction((tx) => {
    if (
      !tx.select().from(rootFolders).where(eq(rootFolders.name, name)).get()
    ) {
      return { ok: false as const, reason: 'not-found' as const, workCount: 0 };
    }
    const [row] = tx
      .select({ count: sql<number>`count(*)` })
      .from(works)
      .where(eq(works.rootFolder, name))
      .all();
    const workCount = row?.count ?? 0;
    if (workCount > 0) {
      return { ok: false as const, reason: 'has-works' as const, workCount };
    }
    tx.delete(rootFolders).where(eq(rootFolders.name, name)).run();
    return { ok: true as const };
  });
}
