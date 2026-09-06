import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { setupTestEnvironment } from '@test/helpers/setup';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { hashPassword } from '../auth/utils.js';
import { setupInstance } from './auth.service.js';

setupTestEnvironment();

/** 场景基线：用户表已有迁移导入的旧账号（group=user 模拟提权场景） */
async function seedMigratedUsers() {
  await db.run(sql`DELETE FROM t_user`);
  await db.insert(users).values([
    { name: 'oldadmin', password: 'old-hash', group: 'user' },
    { name: 'other', password: 'h', group: 'user' },
  ]);
  setConfigForTesting({
    ...getConfig(),
    kikoeruMigratedAt: new Date().toISOString(),
    kikoeruSetupConsumed: undefined,
  });
}

describe('setupInstance（迁移后场景）', () => {
  beforeAll(async () => {
    await seedMigratedUsers();
  });

  afterAll(async () => {
    // 清理：用户表 + 迁移标记，避免污染同进程后续测试
    await db.run(sql`DELETE FROM t_user`);
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });
  });

  it('同名旧用户 → 更新密码 + 提权 administrator', async () => {
    const result = await setupInstance({
      name: 'oldadmin',
      password: 'newpass',
      instanceMode: 'private',
      allowRegistration: false,
    });
    expect(result).toEqual({ name: 'oldadmin', group: 'administrator' });

    const row = await db.query.users.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, 'oldadmin') },
    });
    expect(row?.password).toBe(hashPassword('newpass'));
    expect(row?.group).toBe('administrator');
  });

  it('不同名 → 新建 administrator，返回登录态', async () => {
    // 前一用例已消费 setup，重置后重试本用例场景
    setConfigForTesting({ ...getConfig(), kikoeruSetupConsumed: undefined });
    const result = await setupInstance({
      name: 'brandnew',
      password: 'newpass',
      instanceMode: 'private',
      allowRegistration: false,
    });
    expect(result?.group).toBe('administrator');
    const row = await db.query.users.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, 'brandnew') },
    });
    expect(row?.password).toBe(hashPassword('newpass'));
  });

  it('用户表非空且未迁移过 → null（真已初始化，403 语义）', async () => {
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });
    const result = await setupInstance({
      name: 'someone',
      password: 'newpass',
      instanceMode: 'private',
      allowRegistration: false,
    });
    expect(result).toBeNull();
  });

  it('setup 已消费（kikoeruSetupConsumed）→ 返回 null 且用户数据不变', async () => {
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: new Date().toISOString(),
      kikoeruSetupConsumed: true,
    });
    const before = await db.select().from(users);

    const result = await setupInstance({
      name: 'oldadmin',
      password: 'changed-pass',
      instanceMode: 'public',
      allowRegistration: true,
    });
    expect(result).toBeNull();

    const after = await db.select().from(users);
    // 用户数据完全不变（未被改密/提权，也未新建 intruder）
    expect(after).toEqual(before);
    // 不同名也不允许新建
    expect(after.find((u) => u.name === 'intruder')).toBeUndefined();

    // 清理消费标记，避免污染后续用例
    setConfigForTesting({ ...getConfig(), kikoeruSetupConsumed: undefined });
  });
});
