import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { getConfig, setConfigForTesting } from '../src/infra/config/index.js';
import { db } from '../src/infra/db/main/index.js';
import { updateUserGroup } from '../src/services/user.service.js';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const USER = `rev_user_${RUN}`;
const PWCH_USER = `rev_pwch_${RUN}`;
const ADMIN = `rev_admin_${RUN}`;

describe('token 吊销：存在性回查 / ver 改密吊销 / group 以库为准', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await createTestUser(USER);
    await createTestUser(PWCH_USER);
    await createTestUser(ADMIN, 'administrator');
  });

  afterAll(async () => {
    await deleteTestUser(USER);
    await deleteTestUser(PWCH_USER);
    await deleteTestUser(ADMIN);
    // 清空配置缓存（下次 getConfig 重新读盘），避免模式切换污染同进程后续测试
    setConfigForTesting();
    await app.close();
  });

  describe('回归：正常用户 / 管理员 token 行为不变（私有模式钩子路径）', () => {
    it('普通用户 token 访问 /api/auth/me 返回 200', async () => {
      const token = await signTokenFor(app, USER);
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toMatchObject({ name: USER, group: 'user' });
    });

    it('管理员 token 访问管理路由 GET /api/config/admin 返回 200', async () => {
      const adminToken = await signTokenFor(app, ADMIN);
      const res = await app.inject({
        method: 'GET',
        url: '/api/config/admin',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('删除用户后旧 token 吊销', () => {
    it('私有模式全局钩子路径：删除用户后旧 token → 401', async () => {
      const token = await signTokenFor(app, USER);
      await deleteTestUser(USER);
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      // 重建用户行供 afterAll 清理与其他用例使用
      await createTestUser(USER);
    });

    it('preHandler 路径（public 模式跳过钩子）：删除用户后旧 token → 401', async () => {
      const token = await signTokenFor(app, USER);
      await deleteTestUser(USER);
      setConfigForTesting({ ...getConfig(), instanceMode: 'public' });
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(401);
      await createTestUser(USER);
      setConfigForTesting();
    });

    it('写路由（POST /api/favourites）用已删除用户 token → 401 而非外键 500', async () => {
      const token = await signTokenFor(app, USER);
      await deleteTestUser(USER);
      setConfigForTesting({ ...getConfig(), instanceMode: 'public' });
      const res = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'work', targetId: 'RJ00000001' },
      });
      expect(res.statusCode).toBe(401);
      await createTestUser(USER);
      setConfigForTesting();
    });
  });

  describe('改密后旧 token 吊销（ver 声明）', () => {
    it('管理员为用户改密后旧 token → 401，重新登录的新 token 可用', async () => {
      const oldToken = await signTokenFor(app, PWCH_USER);
      const adminToken = await signTokenFor(app, ADMIN);

      // 管理员改密
      const changeRes = await app.inject({
        method: 'PUT',
        url: '/api/credentials/user',
        headers: { authorization: `Bearer ${adminToken}` },
        payload: { name: PWCH_USER, newPassword: 'new-password-123' },
      });
      expect(changeRes.statusCode).toBe(200);

      // 旧 token 被吊销
      const staleRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${oldToken}` },
      });
      expect(staleRes.statusCode).toBe(401);

      // 重新登录签发的新 token 可用
      const loginRes = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { name: PWCH_USER, password: 'new-password-123' },
      });
      expect(loginRes.statusCode).toBe(200);
      const newToken = loginRes.json<{ token: string }>().token;
      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${newToken}` },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json()).toMatchObject({ name: PWCH_USER, group: 'user' });
    });
  });

  describe('管理员降级即时生效（group 以库为准）', () => {
    it('降级后旧 admin token 访问管理路由 → 403（不是 401）', async () => {
      const adminToken = await signTokenFor(app, ADMIN);
      await updateUserGroup(ADMIN, 'user');

      const res = await app.inject({
        method: 'GET',
        url: '/api/config/admin',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(res.statusCode).toBe(403);

      // 恢复管理员供 afterAll 清理语义
      await updateUserGroup(ADMIN, 'administrator');
    });

    it('降级后普通路由仍 200，且 group 以库为准返回 user', async () => {
      const adminToken = await signTokenFor(app, ADMIN);
      await updateUserGroup(ADMIN, 'user');

      const meRes = await app.inject({
        method: 'GET',
        url: '/api/auth/me',
        headers: { authorization: `Bearer ${adminToken}` },
      });
      expect(meRes.statusCode).toBe(200);
      expect(meRes.json()).toMatchObject({ name: ADMIN, group: 'user' });

      await updateUserGroup(ADMIN, 'administrator');
    });
  });

  describe('authenticateAdmin 赋值 request.user（public 模式回归锁）', () => {
    it('public 模式下管理员删除用户 → 200 且目标被删', async () => {
      // public 模式跳过全局钩子，authenticateAdmin 必须自行赋值 request.user，
      // 否则 DELETE /user 的 self 检查读 request.user.name 直接 500
      const DEL_USER = `rev_del_${RUN}`;
      await createTestUser(DEL_USER);
      setConfigForTesting({ ...getConfig(), instanceMode: 'public' });
      try {
        const adminToken = await signTokenFor(app, ADMIN);
        const res = await app.inject({
          method: 'DELETE',
          url: '/api/credentials/user',
          headers: { authorization: `Bearer ${adminToken}` },
          payload: { users: [{ name: DEL_USER }] },
        });
        expect(res.statusCode).toBe(200);
        const row = await db.query.users.findFirst({
          where: { RAW: (t, op) => op.eq(t.name, DEL_USER) },
        });
        expect(row).toBeUndefined();
      } finally {
        await deleteTestUser(DEL_USER);
        setConfigForTesting();
      }
    });
  });
});
