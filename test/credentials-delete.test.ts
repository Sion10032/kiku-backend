import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { hashPassword } from '../src/auth/utils.js';
import { db } from '../src/infra/db/main/index.js';
import { users } from '../src/infra/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const ADMIN_A = `del_admin_a_${RUN}`;
const ADMIN_B = `del_admin_b_${RUN}`;
const NORMAL_USER = `del_user_${RUN}`;
// 不入库的管理员 token，模拟「已删除但 token 未吊销」的调用方
//（合法管理员批次永不含自己，最后一个管理员保护只在该场景下可达）
const STALE_ADMIN = `del_admin_stale_${RUN}`;

describe('DELETE /api/credentials/user（删除保护）', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let staleAdminToken: string;
  // 其他测试文件可能遗留 administrator 行且未清理；本文件的用例依赖
  // 「库内管理员集合可控」（如“唯一管理员”场景），故先备份并移除遗留
  // 管理员，afterAll 恢复（auth 插件只读 JWT payload，不读库内 group，
  // 临时移除不影响其他测试的鉴权）
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
    adminToken = app.jwt.sign({ name: ADMIN_A, group: 'administrator' });
    staleAdminToken = app.jwt.sign({
      name: STALE_ADMIN,
      group: 'administrator',
    });
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

  it('已删除管理员的未吊销 token 删最后一个管理员被拒（409），管理员仍在', async () => {
    // 前置：ADMIN_B 已被上一用例删除，ADMIN_A 是唯一管理员
    const response = await deleteUsers(
      { users: [{ name: ADMIN_A }] },
      staleAdminToken,
    );
    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: expect.any(String) });
    expect(await userExists(ADMIN_A)).toBe(true);
  });

  it('未吊销 token 一次请求删光全部管理员被拒，整批保留（原子性）', async () => {
    // 补回 ADMIN_B，使库内有两个管理员
    await db
      .insert(users)
      .values({
        name: ADMIN_B,
        password: hashPassword('test-password'),
        group: 'administrator',
      })
      .onConflictDoNothing();

    const response = await deleteUsers(
      { users: [{ name: ADMIN_A }, { name: ADMIN_B }] },
      staleAdminToken,
    );
    expect(response.statusCode).toBe(409);
    expect(await userExists(ADMIN_A)).toBe(true);
    expect(await userExists(ADMIN_B)).toBe(true);
  });

  it('未吊销 token 混合批次删光管理员被拒，整批不动（原子性）', async () => {
    const response = await deleteUsers(
      { users: [{ name: ADMIN_A }, { name: ADMIN_B }, { name: NORMAL_USER }] },
      staleAdminToken,
    );
    expect(response.statusCode).toBe(409);
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
