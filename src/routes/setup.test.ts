import { beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnvironment } from '@test/helpers/setup';
import { sql } from 'drizzle-orm';
import { buildApp } from '../app.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { users, works } from '../infra/db/main/schema.js';
import { migration } from '../migration/job.js';
import { makeOldDb, writeOldConfig } from '../migration/kikoeru.test.js';

setupTestEnvironment();

const EMPTY_JOB_STATE = {
  running: false,
  imported: 0,
  total: 0,
  stats: null,
  error: null,
};

describe('setup routes', () => {
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
    // 迁移门禁要求 old-data/config/config.json 可解析（md5secret 等）
    writeOldConfig(oldDataDir);
  });

  /** 重建 old-data fixture（旧库 + 旧 config + 可选封面，封面拖长后台迁移窗口） */
  function buildOldData(covers = 0): void {
    rmSync(oldDataDir, { recursive: true, force: true });
    const db0 = makeOldDb(oldDataDir, 'number178-fork');
    db0.close();
    writeOldConfig(oldDataDir);
    if (covers > 0) {
      const coversDir = join(oldDataDir, 'covers');
      mkdirSync(coversDir, { recursive: true });
      const kb = Buffer.alloc(1024, 1);
      for (let i = 1; i <= covers; i++) {
        writeFileSync(
          join(coversDir, `RJ${String(i).padStart(6, '0')}_img_full.jpg`),
          kb,
        );
      }
    }
  }

  /** 清空迁移门禁（新库 works 非空 + config 迁移标记），使下一次 run 可执行 */
  async function resetGates(): Promise<void> {
    await db.run(sql`DELETE FROM t_work`);
    setConfigForTesting({ ...getConfig(), kikoeruMigratedAt: undefined });
  }

  /** 等待后台迁移离开 running 状态 */
  async function waitIdle(): Promise<void> {
    for (let i = 0; i < 400 && migration.getState().running; i++) {
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

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

  it('POST run：后台启动 200 {started}，运行中重复 409，完成后终态保留 stats', async () => {
    buildOldData(50); // 封面拖长运行窗口，保证重复请求落在运行中
    await resetGates();

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()).toEqual({ started: true });
    expect(migration.getState().running).toBe(true);

    const again = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(again.statusCode).toBe(409);
    expect(again.json().error).toBe('迁移正在进行中');

    await waitIdle();
    const s = migration.getState();
    expect(s.running).toBe(false);
    expect(s.error).toBeNull();
    expect(s.stats?.works).toBe(2);
    expect(s.stats?.coversImported).toBe(50);
    expect(Boolean(getConfig().kikoeruMigratedAt)).toBe(true);
  });

  it('无 token 可访问（白名单）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/setup/migration/status',
    });
    expect(res.statusCode).not.toBe(401);
  });

  it('GET /api/setup：空库 → needed=true；POST 创建管理员返回登录态；重复提交 403', async () => {
    // 清空用户表回到未初始化状态（reviews/readStates 对 t_user 级联删除）
    await db.run(sql`DELETE FROM t_work`);
    await db.delete(users);
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });

    const before = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(before.statusCode).toBe(200);
    expect(before.json().needed).toBe(true);

    const input = {
      name: 'admin',
      password: 'admin-password',
      instanceMode: 'private',
      allowRegistration: false,
    };
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: input,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.name).toBe('admin');
    expect(body.group).toBe('administrator');

    const after = await app.inject({ method: 'GET', url: '/api/setup' });
    expect(after.json().needed).toBe(false);

    const again = await app.inject({
      method: 'POST',
      url: '/api/setup',
      headers: { 'accept-language': 'en' },
      payload: input,
    });
    expect(again.statusCode).toBe(403);
    expect(again.json().error).toBe('Setup already completed');
  });

  it('POST /api/setup：不再内联迁移（成功后清空 job 终态），遗留 migrateFromKikoeru 字段被忽略', async () => {
    // 先用 run 端点构造「迁移已完成」的 job 终态
    buildOldData(50);
    await resetGates();
    const run = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(run.statusCode).toBe(200);
    await waitIdle();
    expect(migration.getState().stats).not.toBeNull();

    // 回到未初始化：清用户、撤销迁移标记（若仍有内联迁移，门禁 2「库非空」会 409）
    await db.delete(users);
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        name: 'newadmin',
        password: 'admin-password',
        instanceMode: 'private',
        allowRegistration: false,
        migrateFromKikoeru: true, // 已废弃字段：schema 剥离，不触发迁移
      },
    });
    expect(res.statusCode).toBe(200);
    expect(typeof res.json().token).toBe('string');

    // 未迁移：作品数保持迁移写入的 2 部，未新增用户（仅新管理员）
    const workCount = db.select({ c: sql<number>`count(*)` }).from(works).get();
    expect(workCount?.c).toBe(2);
    const userRows = db
      .select({ name: users.name, group: users.group })
      .from(users)
      .all();
    expect(userRows.map((u) => u.name).sort()).toEqual(['newadmin']);

    // 初始化成功 → job 历史终态被清空（reset）
    expect(migration.getState()).toEqual(EMPTY_JOB_STATE);
  });

  it('前端编排（先 run 后 setup）：迁移用户就位后提交 → 同名改密提权 200', async () => {
    // 重建 old-data 后回到空库未初始化状态
    buildOldData();
    await db.run(sql`DELETE FROM t_work`);
    await db.delete(users);
    setConfigForTesting({
      ...getConfig(),
      kikoeruMigratedAt: undefined,
      kikoeruSetupConsumed: undefined,
    });

    const run = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(run.statusCode).toBe(200);
    await waitIdle();
    expect(migration.getState().error).toBeNull();

    // 迁移已写入用户（admin/user1）；此时提交 setup → 迁移分支接管同名改密
    const res = await app.inject({
      method: 'POST',
      url: '/api/setup',
      payload: {
        name: 'admin',
        password: 'admin-password',
        instanceMode: 'private',
        allowRegistration: false,
      },
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(typeof body.token).toBe('string');
    expect(body.name).toBe('admin');
    expect(body.group).toBe('administrator');

    // 同名改密分支：未新建管理员，迁移用户保留，密码已从旧 hash 更新
    const userRows = db
      .select({ name: users.name, group: users.group })
      .from(users)
      .all();
    expect(userRows.map((u) => u.name).sort()).toEqual(['admin', 'user1']);
    const adminRow = db.select({ password: users.password }).from(users).get();
    expect(adminRow?.password).not.toBe('hash-a');
  });

  it('POST run：old-data 不可识别 → 200 started，失败经 job 呈现 ERROR 终态', async () => {
    // 移除 old-data 使探测返回 null（本用例最后执行，fixture 不再重建）
    rmSync(oldDataDir, { recursive: true, force: true });
    await resetGates();

    const res = await app.inject({
      method: 'POST',
      url: '/api/setup/migration/run',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json<Record<string, unknown>>()).toEqual({ started: true });

    await waitIdle();
    const s = migration.getState();
    expect(s.running).toBe(false);
    expect(s.stats).toBeNull();
    expect(s.error).toContain('未找到可识别');
  });
});
