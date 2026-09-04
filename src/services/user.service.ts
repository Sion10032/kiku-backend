import { eq } from 'drizzle-orm';
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

export async function createUser(data: {
  name: string;
  password: string;
  group: string;
}) {
  await db.insert(users).values({
    name: data.name,
    password: data.password,
    group: data.group,
  });

  return getUserByName(data.name);
}

export async function updateUserPassword(name: string, newPassword: string) {
  await db
    .update(users)
    .set({ password: newPassword })
    .where(eq(users.name, name));
}

export async function deleteUser(name: string) {
  await db.delete(users).where(eq(users.name, name));
}

export type CreateUserAccountResult =
  | { ok: true; user: { name: string; group: string } }
  | { ok: false; reason: 'conflict' | 'create-failed' };

/** 建户用例：查重 + hash + 创建（hash 细节不再暴露给 route） */
export async function createUserAccount(
  name: string,
  password: string,
  group: 'user' | 'guest',
): Promise<CreateUserAccountResult> {
  if (await getUserByName(name)) {
    return { ok: false, reason: 'conflict' };
  }
  const user = await createUser({
    name,
    password: hashPassword(password),
    group,
  });
  if (!user) {
    return { ok: false, reason: 'create-failed' };
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
