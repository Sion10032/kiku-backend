import { eq, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/utils.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';

export async function getUserByName(name: string) {
  return db.query.users.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, name) },
  });
}

export async function getUsers() {
  return db.query.users.findMany({
    columns: {
      name: true,
      group: true,
    },
  });
}

/** 建户：重名由数据库唯一约束裁决（不抛异常），返回 undefined 表示该名已存在。
 * target 限定在 name，所以「返回空行」只可能来自 name 唯一约束冲突；
 * NOT NULL / CHECK / 外键 / 其他唯一列冲突 / 写锁 / 磁盘错误一律照旧抛出（已实测）。 */
export async function createUser(data: {
  name: string;
  password: string;
  group: string;
}) {
  const [created] = await db
    .insert(users)
    .values({
      name: data.name,
      password: data.password,
      group: data.group,
    })
    .onConflictDoNothing({ target: users.name })
    .returning();

  return created;
}

export async function updateUserGroup(name: string, group: string) {
  await db.update(users).set({ group }).where(eq(users.name, name));
}

export async function updateUserPassword(name: string, newPassword: string) {
  await db
    .update(users)
    .set({
      password: newPassword,
      // 改密即 bump token 版本，旧 JWT 的 ver 声明不匹配而被吊销
      tokenVersion: sql`${users.tokenVersion} + 1`,
    })
    .where(eq(users.name, name));
}

export type DeleteUsersResult =
  | { ok: true }
  | { ok: false; reason: 'last-administrator' };

/**
 * 删除用户用例（批量）：先整批校验、再执行删除，保证原子性——
 * 要么整批成功，要么一个都不动，不允许删光管理员后留下不一致状态。
 */
export async function deleteUsers(names: string[]): Promise<DeleteUsersResult> {
  const admins = await db
    .select({ name: users.name })
    .from(users)
    .where(eq(users.group, 'administrator'));
  if (admins.length > 0) {
    const requested = new Set(names);
    const remaining = admins.filter((admin) => !requested.has(admin.name));
    if (remaining.length === 0) {
      return { ok: false, reason: 'last-administrator' };
    }
  }
  for (const name of new Set(names)) {
    await db.delete(users).where(eq(users.name, name));
  }
  return { ok: true };
}

export type CreateUserAccountResult =
  | { ok: true; user: { name: string; group: string } }
  | { ok: false; reason: 'conflict' };

/** 建户用例：hash + 创建（hash 细节不再暴露给 route）。
 * 重名交给数据库唯一约束判定（先查后插有 TOCTOU 竞态），createUser 返回 undefined 即 conflict。 */
export async function createUserAccount(
  name: string,
  password: string,
  group: 'user' | 'guest',
): Promise<CreateUserAccountResult> {
  const user = await createUser({
    name,
    password: hashPassword(password),
    group,
  });
  if (!user) {
    return { ok: false, reason: 'conflict' };
  }
  return { ok: true, user: { name: user.name, group: user.group } };
}

/** 改密用例：查存在 + hash + 更新 */
export async function changePassword(
  name: string,
  newPassword: string,
): Promise<'not-found' | 'ok'> {
  if (!(await getUserByName(name))) return 'not-found';
  await updateUserPassword(name, hashPassword(newPassword));
  return 'ok';
}
