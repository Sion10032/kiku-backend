import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { InferInsertModel } from 'drizzle-orm';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { initAdminFromEnv } from '../src/auth/init.js';
import { verifyPassword } from '../src/auth/utils.js';
import { getConfig, updateConfig } from '../src/config/index.js';
import { db } from '../src/db/main/index.js';
import { users } from '../src/db/main/schema.js';
import { deleteUser, getUserByName } from '../src/services/user.service.js';
import { expectNotNull } from './helpers/assert';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

/**
 * 本文件需要「用户表为空」的前提，与其他测试文件共享同一数据库，
 * 因此 beforeAll 备份并清空用户表、记录共享配置，afterAll 恢复。
 */

const RUN = Date.now().toString(36);
const ADMIN = `setup_admin_${RUN}`;
const REG_USER = `reg_user_${RUN}`;
const ENV_ADMIN = `env_admin_${RUN}`;

type UserRow = InferInsertModel<typeof users>;

describe('Setup / Register / Private-mode', () => {
  let app: FastifyInstance;
  let adminToken: string;
  let savedUsers: UserRow[];
  let savedInstanceMode: string;
  let savedAllowRegistration: boolean;

  beforeAll(async () => {
    // 备份用户表与共享配置，清空用户表以模拟首次部署
    savedUsers = await db.query.users.findMany();
    savedInstanceMode = getConfig().instanceMode;
    savedAllowRegistration = getConfig().allowRegistration;
    for (const u of savedUsers) {
      await deleteUser(u.name);
    }

    app = await buildApp();
    await app.ready();
  });

  afterAll(async () => {
    // 清理本文件创建的用户，恢复备份用户与配置
    await deleteUser(ADMIN);
    await deleteUser(REG_USER);
    await deleteUser(ENV_ADMIN);
    for (const u of savedUsers) {
      await db.insert(users).values(u).onConflictDoNothing();
    }
    updateConfig({
      instanceMode: savedInstanceMode as 'private' | 'public',
      allowRegistration: savedAllowRegistration,
    });
    await app.close();
  });

  it('GET /api/auth/setup：空库 → needed = true', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/setup' });
    expect(res.statusCode).toBe(200);
    expect(JSON.parse(res.payload)).toEqual({ needed: true });
  });

  it('POST /api/auth/setup：创建管理员 + 写配置 + 返回登录态', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        name: ADMIN,
        password: 'admin-pass-123',
        instanceMode: 'public',
        allowRegistration: true,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.name).toBe(ADMIN);
    expect(body.group).toBe('administrator');
    expect(typeof body.token).toBe('string');
    adminToken = body.token;

    const user = await getUserByName(ADMIN);
    expect(user?.group).toBe('administrator');
    expect(getConfig().instanceMode).toBe('public');
    expect(getConfig().allowRegistration).toBe(true);
  });

  it('GET /api/auth/setup：非空库 → needed = false；重复 POST → 403', async () => {
    const res = await app.inject({ method: 'GET', url: '/api/auth/setup' });
    expect(JSON.parse(res.payload)).toEqual({ needed: false });

    const post = await app.inject({
      method: 'POST',
      url: '/api/auth/setup',
      payload: {
        name: `other_${RUN}`,
        password: 'whatever-123',
        instanceMode: 'private',
        allowRegistration: false,
      },
    });
    expect(post.statusCode).toBe(403);
  });

  it('注册：开关开启 → 创建 user 用户并返回 token；重名 → 409', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: REG_USER, password: 'reg-pass-123' },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.group).toBe('user');
    expect(typeof body.token).toBe('string');

    const dup = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: REG_USER, password: 'reg-pass-123' },
    });
    expect(dup.statusCode).toBe(409);
  });

  it('注册：开关关闭 → 403（运行时立即生效）', async () => {
    updateConfig({ allowRegistration: false });
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/register',
      payload: { name: `closed_${RUN}`, password: 'reg-pass-123' },
    });
    expect(res.statusCode).toBe(403);
  });

  it('私有模式：匿名 /api/works → 401；header token → 200；?token= → 200；白名单匿名 → 200', async () => {
    updateConfig({ instanceMode: 'private' });

    const anon = await app.inject({ method: 'GET', url: '/api/works' });
    expect(anon.statusCode).toBe(401);

    const header = await app.inject({
      method: 'GET',
      url: '/api/works',
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(header.statusCode).toBe(200);

    const query = await app.inject({
      method: 'GET',
      url: `/api/works?token=${adminToken}`,
    });
    expect(query.statusCode).toBe(200);

    const health = await app.inject({ method: 'GET', url: '/api/health' });
    expect(health.statusCode).toBe(200);

    const shared = await app.inject({
      method: 'GET',
      url: '/api/config/shared',
    });
    expect(shared.statusCode).toBe(200);
  });

  it('公开模式：匿名读类 → 200；需鉴权端点匿名 → 401', async () => {
    updateConfig({ instanceMode: 'public' });

    const anon = await app.inject({ method: 'GET', url: '/api/works' });
    expect(anon.statusCode).toBe(200);

    const me = await app.inject({ method: 'GET', url: '/api/auth/me' });
    expect(me.statusCode).toBe(401);
  });

  it('环境变量初始化：非空库 → 跳过（不覆盖、不报错）', async () => {
    process.env.KIKU_ADMIN_USER = ENV_ADMIN;
    process.env.KIKU_ADMIN_PASSWORD = 'env-pass-123';
    try {
      await initAdminFromEnv();
      const user = await getUserByName(ENV_ADMIN);
      expect(user).toBeUndefined();
    } finally {
      delete process.env.KIKU_ADMIN_USER;
      delete process.env.KIKU_ADMIN_PASSWORD;
    }
  });

  it('环境变量初始化：只设置其一 → 抛错', async () => {
    process.env.KIKU_ADMIN_USER = ENV_ADMIN;
    try {
      await expect(initAdminFromEnv()).rejects.toThrow();
    } finally {
      delete process.env.KIKU_ADMIN_USER;
    }
  });

  it('环境变量初始化：格式非法 → 抛错', async () => {
    process.env.KIKU_ADMIN_USER = 'ab';
    process.env.KIKU_ADMIN_PASSWORD = '12345';
    try {
      await expect(initAdminFromEnv()).rejects.toThrow();
    } finally {
      delete process.env.KIKU_ADMIN_USER;
      delete process.env.KIKU_ADMIN_PASSWORD;
    }
  });

  it('环境变量初始化：空库 + 两变量 → 创建 administrator', async () => {
    // 清空用户表以模拟空库（beforeAll 备份会在 afterAll 恢复）
    const current = await db.query.users.findMany({ columns: { name: true } });
    for (const u of current) await deleteUser(u.name);

    process.env.KIKU_ADMIN_USER = ENV_ADMIN;
    process.env.KIKU_ADMIN_PASSWORD = 'env-pass-123';
    try {
      await initAdminFromEnv();
      const user = await getUserByName(ENV_ADMIN);
      expect(user?.group).toBe('administrator');
      expectNotNull(user);
      expect(verifyPassword('env-pass-123', user.password)).toBe(true);
    } finally {
      delete process.env.KIKU_ADMIN_USER;
      delete process.env.KIKU_ADMIN_PASSWORD;
      await db.delete(users).where(eq(users.name, ENV_ADMIN));
      // 恢复本文件 setup 阶段创建的用户（afterAll 清理依赖）
      await db
        .insert(users)
        .values({
          name: ADMIN,
          password: 'x',
          group: 'administrator',
        })
        .onConflictDoNothing();
      await db
        .insert(users)
        .values({
          name: REG_USER,
          password: 'x',
          group: 'user',
        })
        .onConflictDoNothing();
    }
  });
});
