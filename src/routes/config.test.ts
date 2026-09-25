import { beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { signTokenFor } from '@test/helpers/token';
import { buildApp } from '../app.js';
import { hashPassword } from '../auth/utils.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';

setupTestEnvironment();

let app: Awaited<ReturnType<typeof buildApp>>;
let adminToken = '';

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
  adminToken = await signTokenFor(app, 'config-admin');
});

function auth(): Record<string, string> {
  return { authorization: `Bearer ${adminToken}` };
}

/** 预置非默认标量配置，验证部分更新不互相覆盖 */
function seedConfig(): void {
  setConfigForTesting({ ...getConfig(), pageSize: 48, rewindSeekTime: 12 });
}

describe('PUT /api/config/admin 部分更新', () => {
  it('只改一个字段：其余字段不被重置为默认值', async () => {
    seedConfig();

    const res = await app.inject({
      method: 'PUT',
      url: '/api/config/admin',
      headers: auth(),
      payload: { forwardSeekTime: 60 },
    });
    expect(res.statusCode).toBe(200);

    const after = await app.inject({
      method: 'GET',
      url: '/api/config/admin',
      headers: auth(),
    });
    const cfg = after.json();
    expect(cfg.forwardSeekTime).toBe(60);
    expect(cfg.pageSize).toBe(48);
    expect(cfg.rewindSeekTime).toBe(12);
    // rootFolders 已搬进 t_root_folder，config 契约里不该再有这个键
    expect(cfg).not.toHaveProperty('rootFolders');
  });
});
