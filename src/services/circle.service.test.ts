import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { and, eq, inArray } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  favourites,
  users,
  workMetaOverride,
  works,
} from '../infra/db/main/schema.js';
import { normalizeMakerId, resolveCircle } from './circle.service.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const U1 = `circle-svc-a-${RUN}`;
const U2 = `circle-svc-b-${RUN}`;
// RUN 的 base36 串可能不含足够数字，补齐到 3 位以保证 maker_id 合法
const DIGITS = RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3);
const UPGRADED_ID = `RG99${DIGITS}`;
const CONFLICT_TARGET = `RG77${DIGITS}`;
const resolve = (name: string, circleId?: string) =>
  db.transaction((tx) => resolveCircle(tx, { name, circleId }));

describe('normalizeMakerId', () => {
  it('接受 5 位与 8 位的 RG/VG', () => {
    expect(normalizeMakerId('RG12345')).toBe('RG12345');
    expect(normalizeMakerId('VG12345678')).toBe('VG12345678');
  });
  it('拒绝空串、纯数字、位数不合法与大小写变体', () => {
    for (const v of [
      '',
      '   ',
      '12345',
      'rg12345',
      'RG1234',
      'RG1234567',
      'RG123456789',
    ])
      expect(normalizeMakerId(v)).toBeUndefined();
  });
});

describe('resolveCircle', () => {
  beforeAll(async () => {
    await db.insert(users).values([
      { name: U1, password: 'x', group: 'user' },
      { name: U2, password: 'x', group: 'user' },
    ]);
    await db.insert(circles).values([
      { id: `n${RUN}`, name: `占位数字_${RUN}` }, // 模拟 CAST 出来的纯数字串
      { id: 'RG11111', name: `已迁移_${RUN}` },
    ]);
  });

  afterAll(async () => {
    await db.delete(favourites).where(inArray(favourites.userName, [U1, U2]));
    await db.delete(works).where(eq(works.rootFolder, `circletest-${RUN}`));
    await db.delete(users).where(inArray(users.name, [U1, U2]));
    await db
      .delete(circles)
      .where(
        inArray(circles.name, [
          `占位数字_${RUN}`,
          `已迁移_${RUN}`,
          `新社团_${RUN}`,
          `同名不同社_${RUN}`,
          `升级_${RUN}`,
        ]),
      );
  });

  it('无 maker_id：按名命中已有行；未命中则以 name 作 id 新建', async () => {
    const hit = resolve(`占位数字_${RUN}`);
    expect(hit.id).toBe(`n${RUN}`);
    const created = resolve(`新社团_${RUN}`);
    expect(created.id).toBe(`新社团_${RUN}`);
    expect(
      await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, `新社团_${RUN}`) },
      }),
    ).toBeTruthy();
  });

  it('占位 id + 真实 maker_id → 原地升级，works/override/favourite 全部改指', async () => {
    const before = resolve(`升级_${RUN}`); // 先以 name 身份建占位行
    const workId = `RJCIR${RUN}`.slice(0, 12);
    await db.insert(works).values({
      id: workId,
      rootFolder: `circletest-${RUN}`,
      dir: `d/${RUN}`,
      title: 't',
      circleId: before.id,
    });
    await db.insert(workMetaOverride).values({
      workId,
      circleId: before.id,
    });
    await db.insert(favourites).values([
      { userName: U1, targetType: 'circle', targetId: before.id },
      { userName: U2, targetType: 'circle', targetId: before.id },
    ]);

    const after = resolve(`升级_${RUN}`, UPGRADED_ID);
    expect(after.id).toBe(UPGRADED_ID);
    expect(
      await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, before.id) },
      }),
    ).toBeFalsy();
    const row = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, workId) },
    });
    expect(row?.circleId).toBe(after.id);
    const override = await db.query.workMetaOverride.findFirst({
      where: { RAW: (t, op) => op.eq(t.workId, workId) },
    });
    expect(override?.circleId).toBe(after.id);
    const favs = await db
      .select()
      .from(favourites)
      .where(inArray(favourites.userName, [U1, U2]));
    expect(favs.map((f) => f.targetId)).toEqual([after.id, after.id]);
  });

  it('同一用户新旧 id 都收藏过 → 保留目标行、旧行被丢弃，无 PK 冲突', async () => {
    const placeholder = resolve(`冲突_${RUN}`);
    const target = CONFLICT_TARGET;
    await db.insert(favourites).values([
      { userName: U1, targetType: 'circle', targetId: placeholder.id },
      { userName: U1, targetType: 'circle', targetId: target },
    ]);
    const out = resolve(`冲突_${RUN}`, target);
    expect(out.id).toBe(target);
    // 断言只覆盖本用例涉及的两个 id：U1 还持有上一个用例升级后的收藏
    const favs = await db
      .select()
      .from(favourites)
      .where(
        and(
          eq(favourites.userName, U1),
          inArray(favourites.targetId, [placeholder.id, target]),
        ),
      );
    expect(favs.map((f) => f.targetId)).toEqual([target]);
  });

  it('同名但已是另一个合法 maker_id → 不合并、不升级，按新 id 另建行', async () => {
    const existing = resolve(`同名不同社_${RUN}`, 'RG55555');
    const other = resolve(`同名不同社_${RUN}`, 'RG66666');
    expect(existing.id).toBe('RG55555');
    expect(other.id).toBe('RG66666');
    expect(
      await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, 'RG55555') },
      }),
    ).toBeTruthy();
    expect(
      await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, 'RG66666') },
      }),
    ).toBeTruthy();
  });

  it('已有 maker_id 行再次解析 → 幂等，且回写名字变更', async () => {
    const first = resolve(`已迁移_${RUN}`, 'RG22222');
    expect(first.id).toBe('RG22222');
    const renamed = resolve(`已迁移改名_${RUN}`, 'RG22222');
    expect(renamed.id).toBe('RG22222');
    expect(
      (
        await db.query.circles.findFirst({
          where: { RAW: (t, op) => op.eq(t.id, 'RG22222') },
        })
      )?.name,
    ).toBe(`已迁移改名_${RUN}`);
  });
});
