import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { inArray, sql } from 'drizzle-orm';
import { hashPassword } from '../auth/utils.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';
import { register, setupInstance } from './auth.service.js';

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

// 服务层并发回归：route 层的 app.inject 会把请求串行化、复现不出竞态，
// 这里直接并发调用 register 才能触发「先查后插」的 TOCTOU 窗口。
describe('register（并发同名注册）', () => {
  const created: string[] = [];
  let savedAllowRegistration: boolean;

  beforeAll(() => {
    savedAllowRegistration = getConfig().allowRegistration;
    setConfigForTesting({ ...getConfig(), allowRegistration: true });
  });

  afterAll(async () => {
    await db.delete(users).where(inArray(users.name, created));
    setConfigForTesting({
      ...getConfig(),
      allowRegistration: savedAllowRegistration,
    });
  });

  it('并发同名：一个成功、一个 name-taken，不抛 UNIQUE 约束错误', async () => {
    const name = `reg_race_${Date.now().toString(36)}_${Math.random()
      .toString(36)
      .slice(2, 8)}`;
    created.push(name);

    // 改动前（先查后插）会走到第二个 insert 撞主键抛错、整个 Promise.all reject → 用例失败；
    // 现在重名由唯一约束用「返回值」裁决，不经过异常。
    const results = await Promise.all([
      register(name, 'reg-pass-123'),
      register(name, 'reg-pass-123'),
    ]);

    expect(results.filter((r) => r.ok)).toHaveLength(1);
    const failures = results.filter((r) => !r.ok);
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ reason: 'name-taken' });
  });
});

// 未初始化（用户表为空）时注册：豁免 allowRegistration 开关，首个注册者成为管理员。
// 空表 + 开关关闭下「判定 + 建户」必须原子，否则会出现双管理员。
describe('register（未初始化实例）', () => {
  let savedAllowRegistration: boolean;

  beforeAll(() => {
    savedAllowRegistration = getConfig().allowRegistration;
  });

  afterAll(async () => {
    await db.run(sql`DELETE FROM t_user`);
    setConfigForTesting({
      ...getConfig(),
      allowRegistration: savedAllowRegistration,
    });
  });

  beforeEach(async () => {
    await db.run(sql`DELETE FROM t_user`);
    setConfigForTesting({ ...getConfig(), allowRegistration: false });
  });

  it('空表 + 开关关闭：注册成功且 group=administrator，开关不被改写', async () => {
    const result = await register('first_admin', 'reg-pass-123');

    expect(result).toMatchObject({
      ok: true,
      user: { name: 'first_admin', group: 'administrator' },
    });
    expect(getConfig().allowRegistration).toBe(false);
  });

  // bun:sqlite 同步驱动下 Promise.all 的两次调用顺序化：race_a 的同步事务提交后
  // race_b 才开始，看到非空表 + 开关关 → registration-disabled。
  // 不变式：不能双管理员、不能零管理员（恰有一个 administrator）。
  it('空表 + 并发两个不同名（同步事务顺序化）：恰好一个 administrator，另一个 registration-disabled', async () => {
    const [a, b] = await Promise.all([
      register('race_a', 'reg-pass-123'),
      register('race_b', 'reg-pass-123'),
    ]);

    expect(a).toMatchObject({
      ok: true,
      user: { name: 'race_a', group: 'administrator' },
    });
    expect(b).toEqual({ ok: false, reason: 'registration-disabled' });

    // race_b 被拒绝且不建户：恰有 1 行，且恰有一个 administrator（无双管理员、无零管理员）
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ name: 'race_a', group: 'administrator' });
  });

  it('非空表 + 开关关闭：registration-disabled，且不建户', async () => {
    await db.insert(users).values({
      name: 'existing',
      password: hashPassword('reg-pass-123'),
      group: 'user',
    });

    const result = await register('late_comer', 'reg-pass-123');

    expect(result).toEqual({ ok: false, reason: 'registration-disabled' });
    const rows = await db.select().from(users);
    expect(rows.map((r) => r.name)).toEqual(['existing']);
  });

  it('非空表 + 开关开启：仍建普通用户（回归）', async () => {
    await db.insert(users).values({
      name: 'existing2',
      password: hashPassword('reg-pass-123'),
      group: 'user',
    });
    setConfigForTesting({ ...getConfig(), allowRegistration: true });

    const result = await register('normal_user', 'reg-pass-123');

    expect(result).toMatchObject({
      ok: true,
      user: { name: 'normal_user', group: 'user' },
    });
  });
});

// setupInstance 与 register 的用户操作各自在单一同步事务内：判定 + 建户/提权原子完成。
// 事务化前：两个并发 setup 的 await getUsers() 都判空 → 各自建户 → 双管理员。
describe('setupInstance（事务化：并发与交叠）', () => {
  let savedAllowRegistration: boolean;

  beforeAll(() => {
    savedAllowRegistration = getConfig().allowRegistration;
  });

  afterAll(async () => {
    await db.run(sql`DELETE FROM t_user`);
    setConfigForTesting({
      ...getConfig(),
      allowRegistration: savedAllowRegistration,
    });
  });

  beforeEach(async () => {
    await db.run(sql`DELETE FROM t_user`);
    setConfigForTesting({
      ...getConfig(),
      allowRegistration: false,
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });
  });

  it('并发两个不同名 setup → 恰一成功，表里恰一个 administrator', async () => {
    const [a, b] = await Promise.all([
      setupInstance({
        name: 'setup_a',
        password: 'setup-pass-123',
        instanceMode: 'private',
        allowRegistration: false,
      }),
      setupInstance({
        name: 'setup_b',
        password: 'setup-pass-123',
        instanceMode: 'private',
        allowRegistration: false,
      }),
    ]);

    const successes = [a, b].filter((r) => r !== null);
    expect(successes).toHaveLength(1);
    const rows = await db.select().from(users);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.group).toBe('administrator');
  });

  it('空表被 register 抢先建户后 → setup 返回 null（已初始化）', async () => {
    await register('early_admin', 'reg-pass-123');

    const result = await setupInstance({
      name: 'late_setup',
      password: 'setup-pass-123',
      instanceMode: 'private',
      allowRegistration: false,
    });

    expect(result).toBeNull();
    const rows = await db.select().from(users);
    expect(rows.map((r) => r.name)).toEqual(['early_admin']);
  });
});
