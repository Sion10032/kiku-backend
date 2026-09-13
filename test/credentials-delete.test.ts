import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/utils.js';
import { db } from '../src/infra/db/main/index.js';
import { users } from '../src/infra/db/main/schema.js';
import { deleteUsers as deleteUsersService } from '../src/services/user.service.js';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const ADMIN_A = `del_admin_a_${RUN}`;
const ADMIN_B = `del_admin_b_${RUN}`;
const NORMAL_USER = `del_user_${RUN}`;
// 已删除管理员的遗留 token：行先入库签发、再删除，
// 模拟「账号已删但 token 仍在调用方手中未吊销」的真实场景
const STALE_ADMIN = `del_admin_stale_${RUN}`;

describe('DELETE /api/credentials/user（删除保护）', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let staleAdminToken: string;
  // 其他测试文件可能遗留 administrator 行且未清理；本文件的用例依赖
  // 「库内管理员集合可控」（如“唯一管理员”场景），故先备份并移除遗留
  // 管理员，afterAll 恢复原行（token_version 不变 → 其持有 token 的 ver 校验不受影响）。
  // 注意：P1-7 后鉴权会回查用户表，移除期间这些行不可被其他请求引用——
  // bun test 单进程顺序执行各文件，窗口期内无并发请求，安全。
  let leftoverAdmins: (typeof users.$inferSelect)[] = [];

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    leftoverAdmins = await db
      .select()
      .from(users)
      .where(eq(users.group, 'administrator'));
    if (leftoverAdmins.length > 0) {
      await db.delete(users).where(
        inArray(
          users.name,
          leftoverAdmins.map((u) => u.name),
        ),
      );
    }

    await db.insert(users).values([
      {
        name: ADMIN_A,
        password: hashPassword('test-password'),
        group: 'administrator',
      },
      {
        name: ADMIN_B,
        password: hashPassword('test-password'),
        group: 'administrator',
      },
      {
        name: NORMAL_USER,
        password: hashPassword('test-password'),
        group: 'user',
      },
    ]);
    adminToken = await signTokenFor(app, ADMIN_A);
    // stale token：先入库签发（拿到合法 ver 声明），再删除行
    await db.insert(users).values({
      name: STALE_ADMIN,
      password: hashPassword('test-password'),
      group: 'administrator',
    });
    staleAdminToken = await signTokenFor(app, STALE_ADMIN);
    await db.delete(users).where(eq(users.name, STALE_ADMIN));
  });

  afterAll(async () => {
    await db
      .delete(users)
      .where(inArray(users.name, [ADMIN_A, ADMIN_B, NORMAL_USER]));
    // 恢复测试前遗留的管理员行，保持全局测试数据状态不变
    for (const leftover of leftoverAdmins) {
      await db.insert(users).values(leftover);
    }
    await app.close();
  });

  const deleteUsers = (payload: { users: { name: string }[] }, token: string) =>
    app.inject({
      method: 'DELETE',
      url: '/api/credentials/user',
      payload,
      headers: { authorization: `Bearer ${token}` },
    });

  const userExists = async (name: string) => {
    const row = await db.query.users.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, name) },
    });
    return row?.name === name;
  };

  it('删除自己被拒（400），自己仍在', async () => {
    const response = await deleteUsers(
      { users: [{ name: ADMIN_A }] },
      adminToken,
    );
    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
    expect(await userExists(ADMIN_A)).toBe(true);
  });

  it('批次含自己时整批拒绝（400），其他用户也不被删', async () => {
    const response = await deleteUsers(
      { users: [{ name: ADMIN_B }, { name: ADMIN_A }] },
      adminToken,
    );
    expect(response.statusCode).toBe(400);
    expect(await userExists(ADMIN_A)).toBe(true);
    expect(await userExists(ADMIN_B)).toBe(true);
  });

  it('删除两个管理员之一正常（200，仅目标被删）', async () => {
    const response = await deleteUsers(
      { users: [{ name: ADMIN_B }] },
      adminToken,
    );
    expect(response.statusCode).toBe(200);
    expect(await userExists(ADMIN_B)).toBe(false);
    expect(await userExists(ADMIN_A)).toBe(true);
  });

  it('已删除管理员的未吊销 token 被存在性校验拒绝（401），不进入删除用例', async () => {
    const response = await deleteUsers(
      { users: [{ name: ADMIN_A }] },
      staleAdminToken,
    );
    expect(response.statusCode).toBe(401);
    expect(await userExists(ADMIN_A)).toBe(true);
  });

  it('删除服务：批次删光全部管理员被拒（409 last-administrator），整批保留（原子性）', async () => {
    // 补回 ADMIN_B，使库内有两个管理员；409 现在仅在服务层可达
    //（HTTP 调用方必是库内管理员且批次不得含自己，故无法经路由触发）
    await db
      .insert(users)
      .values({
        name: ADMIN_B,
        password: hashPassword('test-password'),
        group: 'administrator',
      })
      .onConflictDoNothing();

    const result = await deleteUsersService([ADMIN_A, ADMIN_B]);
    expect(result).toEqual({ ok: false, reason: 'last-administrator' });
    expect(await userExists(ADMIN_A)).toBe(true);
    expect(await userExists(ADMIN_B)).toBe(true);
  });

  it('删除服务：混合批次删光管理员被拒，整批不动（原子性）', async () => {
    const result = await deleteUsersService([ADMIN_A, ADMIN_B, NORMAL_USER]);
    expect(result).toEqual({ ok: false, reason: 'last-administrator' });
    expect(await userExists(ADMIN_A)).toBe(true);
    expect(await userExists(ADMIN_B)).toBe(true);
    expect(await userExists(NORMAL_USER)).toBe(true);
  });

  it('删除普通用户正常（200，用户被删）', async () => {
    const response = await deleteUsers(
      { users: [{ name: NORMAL_USER }] },
      adminToken,
    );
    expect(response.statusCode).toBe(200);
    expect(await userExists(NORMAL_USER)).toBe(false);
    expect(await userExists(ADMIN_A)).toBe(true);
    expect(await userExists(ADMIN_B)).toBe(true);
  });
});
