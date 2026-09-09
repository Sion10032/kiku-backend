import { beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/utils.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';

setupTestEnvironment();

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';

const FOLDERS = [
  { name: '主音声库', path: '/library/main' },
  { name: '备份', path: '/library/backup' },
];

beforeAll(async () => {
  app = await buildApp();
  await db
    .insert(users)
    .values({
      name: 'config-admin',
      password: hashPassword('test-password'),
      group: 'administrator',
    })
    .onConflictDoNothing();
  adminToken = app.jwt.sign({ name: 'config-admin', group: 'administrator' });
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}

/** 预置配置：非默认的 rootFolders + pageSize，验证部分更新不互相覆盖 */
function seedConfig(): void {
  setConfigForTesting({ ...getConfig(), rootFolders: FOLDERS, pageSize: 48 });
}

describe('PUT /api/config/admin 部分更新', () => {
  it('只改高级字段：rootFolders 不被清空', async () => {
    seedConfig();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/admin',
      headers: auth(),
      payload: { pageSize: 24 },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/config/admin',
      headers: auth(),
    });
    const cfg = after.json();
    expect(cfg.pageSize).toBe(24);
    expect(cfg.rootFolders).toEqual(FOLDERS);
  });

  it('只改 rootFolders：其他高级字段不被重置为默认值', async () => {
    seedConfig();

    const next = [...FOLDERS, { name: '新加', path: '/library/new' }];
    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/admin',
      headers: auth(),
      payload: { rootFolders: next },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/config/admin',
      headers: auth(),
    });
    const cfg = after.json();
    expect(cfg.rootFolders).toEqual(next);
    expect(cfg.pageSize).toBe(48);
    expect(cfg.listenPort).toBe(getConfig().listenPort);
  });
});
