import { Database } from 'bun:sqlite';
import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { sql } from 'drizzle-orm';
import { setupTestEnvironment } from '@test/helpers/setup';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  readStates,
  reviews,
  tagWork,
  tags,
  vaWork,
  users,
  vas,
  works,
} from '../infra/db/main/schema.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { getBlob } from '../infra/db/blob/index.js';
import { detectKikoeruData, migrateFromKikoeru } from './kikoeru.js';

setupTestEnvironment();

/** 构造一个 kikoeru 旧库（fork 或原版 schema）并插样例数据 */
export function makeOldDb(
  oldDataDir: string,
  flavor: 'number178-fork' | 'vanilla',
) {
  const sqliteDir = join(oldDataDir, 'sqlite');
  mkdirSync(sqliteDir, { recursive: true });
  const db = new Database(join(sqliteDir, 'db.sqlite3'));
  db.exec(`
    CREATE TABLE t_circle (id integer not null primary key autoincrement, name varchar(255) not null);
    CREATE TABLE t_work (id integer not null primary key autoincrement,
      root_folder varchar(255) not null, dir varchar(255) not null,
      title varchar(255) not null, circle_id integer not null, nsfw boolean,
      release varchar(255), dl_count integer, price integer, review_count integer,
      rate_count integer, rate_average_2dp float, rate_count_detail text, rank text,
      lyric_status varchar(255), memo json,
      original_work_id integer not null default '0', is_custom_meta integer default '0');
    CREATE TABLE t_tag (id integer not null primary key autoincrement, name varchar(255) not null);
    CREATE TABLE t_va (id varchar(255), name varchar(255) not null, primary key (id));
    CREATE TABLE r_tag_work (tag_id integer, work_id integer, primary key (tag_id, work_id));
    CREATE TABLE r_va_work (va_id varchar(255), work_id integer, primary key (va_id, work_id));
    CREATE TABLE t_user (name varchar(255) not null, password varchar(255) not null, "group" varchar(255) not null, primary key (name));
    CREATE TABLE t_review (user_name varchar(255) not null, work_id varchar(255) not null,
      rating integer, review_text varchar(255), progress varchar(255),
      created_at datetime default CURRENT_TIMESTAMP, updated_at datetime default CURRENT_TIMESTAMP,
      primary key (user_name, work_id));
  `);
  db.exec(`
    INSERT INTO t_circle (id, name) VALUES (1, '社団A');
    INSERT INTO t_work (id, circle_id, root_folder, dir, title, nsfw)
      VALUES (100, 1, '同人音声', 'A/[RJ000100] テスト作品1', 'テスト作品1', 1);
    INSERT INTO t_work (id, circle_id, root_folder, dir, title, nsfw)
      VALUES (200, 1, '同人音声', 'B/[VJ000200] テスト作品2', 'テスト作品2', 0);
    INSERT INTO t_tag (id, name) VALUES (1, 'タグ1');
    INSERT INTO t_va (id, name) VALUES ('uuid-va-1', '声優1');
    INSERT INTO r_tag_work VALUES (1, 100);
    INSERT INTO r_va_work VALUES ('uuid-va-1', 200);
    INSERT INTO t_user VALUES ('admin', 'hash-a', 'administrator');
    INSERT INTO t_user VALUES ('user1', 'hash-b', 'user');
    INSERT INTO t_review (user_name, work_id, rating, review_text, progress)
      VALUES ('user1', '100', 5, '良い', 'listening');
  `);
  if (flavor === 'number178-fork') {
    db.exec(`
      CREATE TABLE t_translate_task (id integer primary key autoincrement);
      CREATE TABLE t_play_histroy (user_name varchar(255) NOT NULL, work_id integer NOT NULL,
        created_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        updated_at datetime NOT NULL DEFAULT CURRENT_TIMESTAMP,
        state json NOT NULL DEFAULT '{}',
        PRIMARY KEY (user_name, work_id));
      INSERT INTO t_play_histroy (user_name, work_id, updated_at)
        VALUES ('user1', 100, '2025-01-02 03:04:05');
    `);
  }
  return db;
}

describe('detectKikoeruData', () => {
  let dir: string;

  beforeAll(() => {
    dir = join(tmpdir(), `kiku-old-${Date.now().toString(36)}`);
  });
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* WAL 句柄 */
    }
  });

  it('db.sqlite3 不存在 → null', () => {
    expect(detectKikoeruData(dir)).toBeNull();
  });

  it('fork 旧库 → 判定 number178-fork 且统计正确', () => {
    const forkDir = join(dir, 'fork');
    const db = makeOldDb(forkDir, 'number178-fork');
    db.close();
    const det = detectKikoeruData(forkDir);
    expect(det?.flavor).toBe('number178-fork');
    expect(det?.stats).toEqual({
      works: 2,
      users: 2,
      reviews: 1,
      playHistory: 1,
      covers: 0,
    });
  });

  it('原版旧库（无 fork 表）→ 判定 vanilla，playHistory 为 0', () => {
    const vanillaDir = join(dir, 'vanilla');
    const db = makeOldDb(vanillaDir, 'vanilla');
    db.close();
    const det = detectKikoeruData(vanillaDir);
    expect(det?.flavor).toBe('vanilla');
    expect(det?.stats.playHistory).toBe(0);
    expect(det?.stats.works).toBe(2);
  });
});

/** 清空新库业务表 + 重置迁移标记（每个迁移用例独立起点） */
async function cleanNewDb() {
  await db.delete(readStates);
  await db.delete(reviews);
  await db.delete(tagWork);
  await db.delete(vaWork);
  await db.delete(works);
  await db.delete(tags);
  await db.delete(vas);
  await db.delete(circles);
  await db.run(sql`DELETE FROM t_user`);
  setConfigForTesting({ ...getConfig(), kikoeruMigratedAt: undefined });
}

describe('migrateFromKikoeru（元数据）', () => {
  let dir: string;

  beforeAll(() => {
    dir = join(tmpdir(), `kiku-mig-${Date.now().toString(36)}`);
  });
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* WAL 句柄 */
    }
  });

  it('fork 库全量迁移：works id 映射正确、ageRating=r18', async () => {
    await cleanNewDb();
    const forkDir = join(dir, 'fork');
    const old = makeOldDb(forkDir, 'number178-fork');
    old.close();

    const result = migrateFromKikoeru(forkDir);
    expect(result.ok).toBe(true);
    expect(result.stats?.works).toBe(2);
    expect(result.stats?.worksSkipped).toBe(0);

    const w1 = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, 'RJ000100') },
    });
    expect(w1?.title).toBe('テスト作品1');
    expect(w1?.ageRating).toBe('r18');
    expect(w1?.rootFolder).toBe('同人音声');
    expect(w1?.dir).toBe('A/[RJ000100] テスト作品1');
    expect(w1?.circleId).toBe(1);

    const w2 = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, 'VJ000200') },
    });
    expect(w2?.title).toBe('テスト作品2');

    const circleRows = await db.select().from(circles);
    expect(circleRows).toHaveLength(1);
    expect(circleRows[0]?.name).toBe('社団A');

    const tagRows = await db.select().from(tags);
    expect(tagRows).toHaveLength(1);
    const vaRows = await db.select().from(vas);
    expect(vaRows).toHaveLength(1);
    expect(vaRows[0]?.id).toBe('uuid-va-1');

    // 关联重映射：tag→work100(RJ000100)，va→work200(VJ000200)
    const tw = await db.select().from(tagWork);
    expect(tw).toHaveLength(1);
    expect(tw[0]?.workId).toBe('RJ000100');
    const vw = await db.select().from(vaWork);
    expect(vw).toHaveLength(1);
    expect(vw[0]?.workId).toBe('VJ000200');
  });

  it('dir 无 RJ/VJ 码的作品跳过并计数', async () => {
    await cleanNewDb();
    const vanillaDir = join(dir, 'vanilla');
    const old = makeOldDb(vanillaDir, 'vanilla');
    old.exec(
      `INSERT INTO t_work (id, circle_id, root_folder, dir, title) VALUES (300, 1, '同人音声', 'C/提取不出码的作品', 'x')`,
    );
    old.close();

    const result = migrateFromKikoeru(vanillaDir);
    expect(result.ok).toBe(true);
    expect(result.stats?.works).toBe(2);
    expect(result.stats?.worksSkipped).toBe(1);
    expect(
      await db.query.works.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, 'RJ000100') },
      }),
    ).toBeTruthy();
  });
});

describe('migrateFromKikoeru（用户数据）', () => {
  let dir: string;

  beforeAll(() => {
    dir = join(tmpdir(), `kiku-mig-user-${Date.now().toString(36)}`);
  });
  afterAll(() => {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* WAL 句柄 */
    }
  });

  it('users 全量导入，reviews 重映射，play_histroy → read_states（readAt=updated_at）', async () => {
    await cleanNewDb();
    const forkDir = join(dir, 'fork4');
    const old = makeOldDb(forkDir, 'number178-fork');
    old.close();

    const result = migrateFromKikoeru(forkDir);
    expect(result.ok).toBe(true);

    const userRows = await db.select().from(users);
    expect(userRows).toHaveLength(2);
    expect(userRows.find((u) => u.name === 'admin')?.group).toBe('administrator');
    expect(userRows.find((u) => u.name === 'admin')?.password).toBe('hash-a');

    const rev = await db.select().from(reviews);
    expect(rev).toHaveLength(1);
    expect(rev[0]?.workId).toBe('RJ000100');
    expect(rev[0]?.rating).toBe(5);
    expect(rev[0]?.progress).toBe('listening');

    const rs = await db.select().from(readStates);
    expect(rs).toHaveLength(1);
    expect(rs[0]?.userName).toBe('user1');
    expect(rs[0]?.workId).toBe('RJ000100');
    expect(rs[0]?.readAt).toBe('2025-01-02 03:04:05');
  });

  it('同名用户已存在 → 保留已有行（不覆盖），计数入 usersSkipped', async () => {
    await cleanNewDb();
    // 预置同名用户（模拟迁移前已有账号）
    await db.insert(users).values({ name: 'admin', password: 'new-hash', group: 'user' });
    const forkDir = join(dir, 'fork-skip');
    const old = makeOldDb(forkDir, 'number178-fork');
    old.close();

    const result = migrateFromKikoeru(forkDir);
    expect(result.ok).toBe(true);
    expect(result.stats?.users).toBe(1);
    expect(result.stats?.usersSkipped).toBe(1);

    const admin = await db.query.users.findFirst({
      where: { RAW: (t, op) => op.eq(t.name, 'admin') },
    });
    expect(admin?.password).toBe('new-hash'); // 未被旧 hash 覆盖
  });

  it('原版库（无 t_play_histroy）→ readStates 为 0', async () => {
    await cleanNewDb();
    const vanillaDir = join(dir, 'vanilla-rs');
    const old = makeOldDb(vanillaDir, 'vanilla');
    old.close();

    const result = migrateFromKikoeru(vanillaDir);
    expect(result.ok).toBe(true);
    expect(result.stats?.readStates).toBe(0);
    expect(await db.select().from(readStates)).toHaveLength(0);
  });

  it('review 指向的作品提取不出码 → 该行跳过计数', async () => {
    await cleanNewDb();
    const vanillaDir = join(dir, 'vanilla-orphan');
    const old = makeOldDb(vanillaDir, 'vanilla');
    old.exec(
      `INSERT INTO t_review (user_name, work_id, rating, review_text) VALUES ('user1', '999', 3, '孤儿评论')`,
    );
    old.close();

    const result = migrateFromKikoeru(vanillaDir);
    expect(result.ok).toBe(true);
    expect(result.stats?.reviews).toBe(1);
    expect(result.stats?.reviewsSkipped).toBe(1);
  });
});

describe('migrateFromKikoeru（门禁 + 封面 + config）', () => {
  let dir: string;

  beforeAll(() => {
    dir = join(tmpdir(), `kiku-mig-side-${Date.now().toString(36)}`);
  });
  afterAll(() => {
    // 恢复 config，避免 md5secret/rootFolders/迁移标记污染同进程其他测试
    setConfigForTesting({
      ...getConfig(),
      md5secret: 'test-md5-secret',
      jwtsecret: 'test-jwt-secret',
      rootFolders: [],
      kikoeruMigratedAt: undefined,
    });
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      /* WAL 句柄 */
    }
  });

  it('已迁移过（config 有标记）→ ok=false 且不重复迁移', async () => {
    await cleanNewDb();
    const sub = join(dir, 'gate1');
    const old = makeOldDb(sub, 'vanilla');
    old.close();
    expect(migrateFromKikoeru(sub).ok).toBe(true);

    // 第二次：清空 works 模拟「新库已空但标记还在」→ 仍应被门禁 1 拒绝
    await db.delete(works);
    const again = migrateFromKikoeru(sub);
    expect(again.ok).toBe(false);
    expect(again.error).toContain('已迁移');
  });

  it('新库 works 非空 → 拒绝迁移', async () => {
    await cleanNewDb();
    await db.insert(circles).values({ id: 900, name: '占位' });
    await db.insert(works).values({
      id: 'RJ999999', rootFolder: 'x', dir: 'x', title: '占位', circleId: 900,
    });
    const sub = join(dir, 'gate2');
    const old = makeOldDb(sub, 'vanilla');
    old.close();

    const result = migrateFromKikoeru(sub);
    expect(result.ok).toBe(false);
    expect(result.error).toContain('非空');
    // 清理占位
    await db.delete(works);
    await db.delete(circles);
  });

  it('封面导入 blob.db：RJ..._img_main.jpg → cover:RJ..._main', async () => {
    await cleanNewDb();
    const sub = join(dir, 'covers');
    const old = makeOldDb(sub, 'vanilla');
    old.close();
    const coversDir = join(sub, 'covers');
    mkdirSync(coversDir, { recursive: true });
    writeFileSync(join(coversDir, 'RJ000100_img_main.jpg'), Buffer.from('jpeg-bytes'));
    writeFileSync(join(coversDir, 'readme.txt'), 'not a cover');

    const result = migrateFromKikoeru(sub);
    expect(result.ok).toBe(true);
    expect(result.stats?.coversImported).toBe(1);

    const blob = getBlob('cover', 'RJ000100_main');
    expect(blob).not.toBeNull();
    expect(blob?.mimeType).toBe('image/jpeg');
    expect(Buffer.from(blob!.data).toString()).toBe('jpeg-bytes');
    rmSync(coversDir, { recursive: true, force: true });
  });

  it('md5secret 覆盖 + rootFolders 按 name 合并 + 写迁移标记', async () => {
    await cleanNewDb();
    // 预置已有 rootFolder：name 相同 → 迁移时保留原 path
    setConfigForTesting({
      ...getConfig(),
      rootFolders: [{ name: 'test', path: '/keep-existing' }],
    });
    const sub = join(dir, 'config-side');
    const old = makeOldDb(sub, 'vanilla');
    old.close();
    mkdirSync(join(sub, 'config'), { recursive: true });
    writeFileSync(
      join(sub, 'config', 'config.json'),
      JSON.stringify({
        version: '0.6.14',
        md5secret: 'old-md5-secret',
        rootFolders: [
          { name: '同人音声', path: '/usr/src/kikoeru/VoiceWork' },
          { name: 'test', path: '/should-not-override' },
        ],
      }),
      'utf-8',
    );

    const result = migrateFromKikoeru(sub);
    expect(result.ok).toBe(true);

    const cfg = getConfig();
    expect(cfg.kikoeruMigratedAt).toBeTruthy();
    expect(cfg.md5secret).toBe('old-md5-secret');
    // test 是已有 name → 保留原 path
    const testFolder = cfg.rootFolders.find((r) => r.name === 'test');
    expect(testFolder?.path).toBe('/keep-existing');
    // 同人音声为新增
    const added = cfg.rootFolders.find((r) => r.name === '同人音声');
    expect(added?.path).toBe('/usr/src/kikoeru/VoiceWork');

    rmSync(join(sub, 'config'), { recursive: true, force: true });
  });

  it('old-data 无 config.json 也能迁移（仅写标记）', async () => {
    await cleanNewDb();
    const sub = join(dir, 'no-config');
    const old = makeOldDb(sub, 'vanilla');
    old.close();

    const result = migrateFromKikoeru(sub);
    expect(result.ok).toBe(true);
    expect(getConfig().kikoeruMigratedAt).toBeTruthy();
  });

  it('旧 config 畸形值（path 非字符串 / md5secret 非字符串）按不存在跳过，不砖死迁移', async () => {
    await cleanNewDb();
    // 预置基线 md5secret，断言畸形值未覆盖（前一用例可能已改写 config）
    setConfigForTesting({ ...getConfig(), md5secret: 'baseline-md5' });
    const sub = join(dir, 'malformed-config');
    const old = makeOldDb(sub, 'vanilla');
    old.close();
    mkdirSync(join(sub, 'config'), { recursive: true });
    writeFileSync(
      join(sub, 'config', 'config.json'),
      JSON.stringify({
        md5secret: 12345, // 非字符串 → 不并入
        rootFolders: [
          { name: 'bad', path: 123 }, // path 非字符串 → 丢弃
          { name: 'good', path: '/valid/path' }, // 合法 → 并入
        ],
      }),
      'utf-8',
    );

    const result = migrateFromKikoeru(sub);
    expect(result.ok).toBe(true);

    const cfg = getConfig();
    expect(cfg.kikoeruMigratedAt).toBeTruthy();
    expect(cfg.md5secret).toBe('baseline-md5'); // 畸形 md5secret 未并入
    expect(cfg.rootFolders.find((r) => r.name === 'good')?.path).toBe('/valid/path');
    expect(cfg.rootFolders.find((r) => r.name === 'bad')).toBeUndefined();

    rmSync(join(sub, 'config'), { recursive: true, force: true });
  });
});
