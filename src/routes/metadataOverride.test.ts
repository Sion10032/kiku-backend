import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  cleanupOverrideFixtures,
  insertOverrideFixtures,
  OVR,
} from '@test/fixtures/override';
import { setupTestEnvironment } from '@test/helpers/setup';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/utils.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';

setupTestEnvironment();

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';
let userToken = '';

beforeAll(async () => {
  app = await buildApp();
  // 直接建用户 + 手工签 token（测试只需鉴权，不测登录流程本身）
  await db
    .insert(users)
    .values([
      {
        name: 'meta-admin',
        password: hashPassword('test-password'),
        group: 'administrator',
      },
      {
        name: 'meta-user',
        password: hashPassword('test-password'),
        group: 'user',
      },
    ])
    .onConflictDoNothing();
  adminToken = app.jwt.sign({ name: 'meta-admin', group: 'administrator' });
  userToken = app.jwt.sign({ name: 'meta-user', group: 'user' });
  await insertOverrideFixtures();
});
afterAll(cleanupOverrideFixtures);

function auth(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` };
}

describe('元数据覆盖路由', () => {
  it('PATCH 无 token → 401', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/work/${OVR.w1}/metadata`,
      payload: { title: `标题_override_${OVR.base}` },
    });
    // private 模式全局守卫拦截未认证请求
    expect(res.statusCode).toBe(401);
  });

  it('PATCH 非管理员 → 403', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/work/${OVR.w1}/metadata`,
      headers: auth(userToken),
      payload: { title: `标题_override_${OVR.base}` },
    });
    expect(res.statusCode).toBe(403);
  });

  it('PATCH 管理员：标量 + tags 动作列表 → 200 且生效', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/work/${OVR.w1}/metadata`,
      headers: auth(adminToken),
      payload: {
        title: `标题_override_${OVR.base}`,
        addTags: [`标签Z_${OVR.base}`],
      },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true });
    const detail = await app.inject({
      method: 'GET',
      url: `/api/work/${OVR.w1}/metadata/override`,
      headers: auth(adminToken),
    });
    expect(detail.statusCode).toBe(200);
    const body = detail.json();
    expect(body.effective.title).toBe(`标题_override_${OVR.base}`);
    expect(body.overriddenFields).toEqual(['title', 'tags']);
  });

  it('PATCH 空对象 → 400（zod 拒绝空覆盖）', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: `/api/work/${OVR.w1}/metadata`,
      headers: auth(adminToken),
      payload: {},
    });
    expect(res.statusCode).toBe(400);
  });

  it('PATCH 不存在作品 → 404', async () => {
    const res = await app.inject({
      method: 'PATCH',
      url: '/api/work/RJ99999999/metadata',
      headers: auth(adminToken),
      payload: { title: 'x' },
    });
    expect(res.statusCode).toBe(404);
  });

  it('DELETE 单字段恢复 → 200；非法 field → 400', async () => {
    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/work/${OVR.w1}/metadata/title`,
      headers: auth(adminToken),
    });
    expect(ok.statusCode).toBe(200);
    const detail = await app.inject({
      method: 'GET',
      url: `/api/work/${OVR.w1}/metadata/override`,
      headers: auth(adminToken),
    });
    expect(detail.json().overriddenFields).toEqual(['tags']);
    const bad = await app.inject({
      method: 'DELETE',
      url: `/api/work/${OVR.w1}/metadata/release`,
      headers: auth(adminToken),
    });
    expect(bad.statusCode).toBe(400); // release 不在可编辑字段清单
  });

  it('GET 回显匿名 → 401（管理员端点不公开）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/work/${OVR.w1}/metadata/override`,
    });
    expect(res.statusCode).toBe(401);
  });
});
