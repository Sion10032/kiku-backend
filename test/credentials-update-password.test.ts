import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
// 4 字用户名：曾因 updatePasswordSchema.name min(5) 导致改密 400（P1-8）
const SHORT_USER = `ab${RUN.slice(-2)}`;
const ADMIN = `upd_admin_${RUN}`;

describe('PUT /api/credentials/user（修改密码）', () => {
  let app: FastifyInstance;
  let adminToken: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await createTestUser(SHORT_USER, 'user', 'old-password');
    await createTestUser(ADMIN, 'administrator', 'test-password');
    adminToken = await signTokenFor(app, ADMIN);
  });

  afterAll(async () => {
    await deleteTestUser(SHORT_USER);
    await deleteTestUser(ADMIN);
    await app.close();
  });

  it('4 字用户名改密成功（200），旧密码失效、新密码可登录', async () => {
    const changeResponse = await app.inject({
      method: 'PUT',
      url: '/api/credentials/user',
      payload: { name: SHORT_USER, newPassword: 'new-password-123' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(changeResponse.statusCode).toBe(200);
    expect(changeResponse.json()).toMatchObject({
      message: 'Password updated',
    });

    const oldLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: SHORT_USER, password: 'old-password' },
    });
    expect(oldLogin.statusCode).toBe(401);

    const newLogin = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: SHORT_USER, password: 'new-password-123' },
    });
    expect(newLogin.statusCode).toBe(200);
    expect(newLogin.json()).toMatchObject({ name: SHORT_USER });
  });

  it('用户不存在时返回 404', async () => {
    const response = await app.inject({
      method: 'PUT',
      url: '/api/credentials/user',
      payload: { name: 'no_such_user', newPassword: 'new-password-123' },
      headers: { authorization: `Bearer ${adminToken}` },
    });
    expect(response.statusCode).toBe(404);
  });
});
