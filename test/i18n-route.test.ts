import { describe, expect, it } from 'bun:test';
import { buildApp } from '../src/app';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

describe('i18n 路由本地化', () => {
  it('无 Accept-Language 头回退 zh-CN', async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      payload: { name: 'nobody-here', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('用户名或密码错误');
    await app.close();
  });

  it('Accept-Language: en 返回英文', async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'accept-language': 'en-US,en;q=0.9' },
      payload: { name: 'nobody-here', password: 'wrong-password' },
    });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toBe('Invalid credentials');
    await app.close();
  });

  it('zod 校验错误按请求语言返回合并消息', async () => {
    const app = await buildApp();
    await app.ready();
    const res = await app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'accept-language': 'en' },
      payload: { name: 'x', password: 'x' },
    });
    expect(res.statusCode).toBe(400);
    expect(res.json().error).toContain('Invalid request parameters');
    await app.close();
  });
});
