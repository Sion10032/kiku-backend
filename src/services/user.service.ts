import { db } from '../db/main/index.js';
import { users } from '../db/main/schema.js';
import { eq } from 'drizzle-orm';

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
  await db.update(users)
    .set({ password: newPassword })
    .where(eq(users.name, name));
}

export async function deleteUser(name: string) {
  await db.delete(users).where(eq(users.name, name));
}
