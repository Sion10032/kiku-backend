import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { signTokenFor } from '@test/helpers/token';
import { eq, inArray } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/utils.js';
import { db } from '../infra/db/main/index.js';
import { circles, rootFolders, users, works } from '../infra/db/main/schema.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const ADMIN = `rf-admin-${RUN}`;
const CIRCLE = `rg-rf-${RUN}`;

/** 含 '/'、空格与日文：放进 URL path 段会被路由拆断，只能走 query string */
const UNICODE_NAME = `同人/音声 ${RUN}`;
const RENAMED_NAME = `改名後 ${RUN}`;
const CREATED_NAME = `rf-created-${RUN}`;
const CREATED_PATH = `/tmp/rf-created-${RUN}`;
const RENAMED_PATH = `/tmp/rf-renamed-${RUN}`;
const MISSING_NAME = `rf-missing-${RUN}`;

const ACTIVE_WORK = `rj-rf-a-${RUN}`;
const DELETED_WORK = `rj-rf-d-${RUN}`;

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';

beforeAll(async () => {
  app = await buildApp();
  await db
    .insert(users)
    .values({
      name: ADMIN,
      password: hashPassword('test-password'),
      group: 'administrator',
    })
    .onConflictDoNothing();
  adminToken = await signTokenFor(app, ADMIN);
  await db
    .insert(circles)
    .values({ id: CIRCLE, name: `rf-circle-${RUN}` })
    .onConflictDoNothing();
});

afterAll(async () => {
  // FK：先删 works（同时引用 circles 与 rootFolders），再删 rootFolders / circles
  await db.delete(works).where(eq(works.circleId, CIRCLE));
  await db
    .delete(rootFolders)
    .where(
      inArray(rootFolders.name, [CREATED_NAME, UNICODE_NAME, RENAMED_NAME]),
    );
  await db.delete(circles).where(eq(circles.id, CIRCLE));
});

function auth(extra: Record<string, string> = {}): Record<string, string> {
  return { authorization: `Bearer ${adminToken}`, ...extra };
}

/** 当前名字放 query string（name 是任意用户文本） */
function nameQuery(name: string): string {
  return new URLSearchParams({ name }).toString();
}

describe('root folder admin endpoints', () => {
  it('未带 admin token → 401', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/root-folders',
    });
    expect(res.statusCode).toBe(401);
  });

  it('POST 创建成功返回 {name, path}；同名再 POST → 409 + 本地化文案', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/config/root-folders',
      headers: auth({ 'accept-language': 'zh-CN' }),
      payload: { name: CREATED_NAME, path: CREATED_PATH },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; path: string }>()).toEqual({
      name: CREATED_NAME,
      path: CREATED_PATH,
    });

    const dup = await app.inject({
      method: 'POST',
      url: '/api/config/root-folders',
      headers: auth({ 'accept-language': 'zh-CN' }),
      payload: { name: CREATED_NAME, path: '/tmp/other' },
    });
    expect(dup.statusCode).toBe(409);
    expect(dup.json().error).toContain('同名');
  });

  it('GET 列表包含刚创建的根目录', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/config/root-folders',
      headers: auth(),
    });
    expect(res.statusCode).toBe(200);
    const names = (res.json().folders as { name: string }[]).map((f) => f.name);
    expect(names).toContain(CREATED_NAME);
  });

  it('PUT ?name=含 /、空格、日文 的名字 → 改名成功且 works.root_folder 级联跟随', async () => {
    // 先备好数据：一条根目录 + 一正常一软删的作品（都指向 unicode 名）
    await db
      .insert(rootFolders)
      .values({ name: UNICODE_NAME, path: `/tmp/rf-unicode-${RUN}` });
    await db.insert(works).values([
      {
        id: ACTIVE_WORK,
        rootFolder: UNICODE_NAME,
        dir: `d/${ACTIVE_WORK}`,
        title: 'active',
        circleId: CIRCLE,
      },
      {
        id: DELETED_WORK,
        rootFolder: UNICODE_NAME,
        dir: `d/${DELETED_WORK}`,
        title: 'deleted',
        circleId: CIRCLE,
        deletedAt: '2026-01-01T00:00:00.000Z',
      },
    ]);

    const res = await app.inject({
      method: 'PUT',
      url: `/api/config/root-folders?${nameQuery(UNICODE_NAME)}`,
      headers: auth(),
      payload: { name: RENAMED_NAME, path: RENAMED_PATH },
    });
    // 200 即证明 name 未被 URL path 段拆断
    expect(res.statusCode).toBe(200);
    expect(res.json<{ name: string; path: string }>()).toEqual({
      name: RENAMED_NAME,
      path: RENAMED_PATH,
    });

    // 核心卖点：外键 ON UPDATE CASCADE 把两行（含软删）一并改写
    const rows = await db
      .select({ id: works.id, rootFolder: works.rootFolder })
      .from(works)
      .where(eq(works.circleId, CIRCLE));
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.rootFolder === RENAMED_NAME)).toBe(true);

    const oldRow = await db
      .select()
      .from(rootFolders)
      .where(eq(rootFolders.name, UNICODE_NAME));
    expect(oldRow).toHaveLength(0);
  });

  it('PUT 改成已存在名字 → 409，原行不变', async () => {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/config/root-folders?${nameQuery(CREATED_NAME)}`,
      headers: auth(),
      payload: { name: RENAMED_NAME, path: '/tmp/x' },
    });
    expect(res.statusCode).toBe(409);

    const row = await db
      .select()
      .from(rootFolders)
      .where(eq(rootFolders.name, CREATED_NAME));
    expect(row).toHaveLength(1);
  });

  it('DELETE 名下有作品（含软删）→ 409，文案带作品数', async () => {
    const res = await app.inject({
      method: 'DELETE',
      url: `/api/config/root-folders?${nameQuery(RENAMED_NAME)}`,
      headers: auth({ 'accept-language': 'zh-CN' }),
    });
    expect(res.statusCode).toBe(409);
    // {{count}} 真被插值：断言包含作品数 2
    expect(res.json().error).toContain('2');
  });

  it('DELETE 不存在 → 404；DELETE 空目录 → 200 {success:true}', async () => {
    const missing = await app.inject({
      method: 'DELETE',
      url: `/api/config/root-folders?${nameQuery(MISSING_NAME)}`,
      headers: auth(),
    });
    expect(missing.statusCode).toBe(404);

    const ok = await app.inject({
      method: 'DELETE',
      url: `/api/config/root-folders?${nameQuery(CREATED_NAME)}`,
      headers: auth(),
    });
    expect(ok.statusCode).toBe(200);
    expect(ok.json<{ success: boolean }>()).toEqual({ success: true });
  });
});
