import { beforeAll, describe, expect, it } from 'bun:test';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnvironment } from '@test/helpers/setup';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { makeOldDb } from '../migration/kikoeru.test.js';

setupTestEnvironment();

describe('setup migration routes', () => {
  let app: Awaited<ReturnType<typeof buildApp>>;
  /** 备份真实 old-data 解析结果，测试内用环境变量指向临时目录 */
  let oldDataDir: string;

  beforeAll(async () => {
    app = await buildApp();
    oldDataDir = join(tmpdir(), 'old-data');
    process.env.WORK_DIR = tmpdir(); // getOldDataDir = WORK_DIR/old-data
    // 构造 WORK_DIR 下的 old-data（不污染真实 ./old-data）
    rmSync(oldDataDir, { recursive: true, force: true });
    const db0 = makeOldDb(oldDataDir, 'number178-fork');
    db0.close();
  });

  it('GET /api/setup/migration/status：old-data 存在 → available=true + flavor + stats', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/setup/migration/status',
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.available).toBe(true);
    expect(body.flavor).toBe('number178-fork');
    expect(body.stats.works).toBe(2);
  });

  it('POST run：迁移成功返回 stats；重复执行 409', async () => {
    // 清库 + 重置标记保证起点干净
    await db.run(sql`DELETE FROM t_work`);
    setConfigForTesting({ ...getConfig(), kikoeruMigratedAt: undefined });

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().stats.works).toBe(2);

    const again = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(again.statusCode).toBe(409);
  });

  it('无 token 可访问（白名单）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/setup/migration/status',
    });
    expect(res.statusCode).not.toBe(401);
  });
});
