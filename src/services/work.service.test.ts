import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ensureRootFolder, removeRootFolder } from '@test/helpers/rootFolder';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  favourites,
  series,
  tags,
  tagWork,
  tagWorkOverride,
  users,
  vas,
  vaWork,
  vaWorkOverride,
  workMetaOverride,
  works,
} from '../infra/db/main/schema.js';
import {
  getCircles,
  getSeries,
  getTags,
  getVas,
  liveWorkExists,
  workExists,
} from './work.service.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;
const DELETED_ID = `RJDEL${RUN}`;
const MISSING_ID = `RJmissing${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG96${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

describe('workExists / liveWorkExists 的软删语义差异', () => {
  let circleId: string;

  beforeAll(async () => {
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `workExists 测试社团_${RUN}` })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    circleId = circleRow.id;

    await ensureRootFolder('test');
    await db.insert(works).values([
      {
        id: WORK_ID,
        rootFolder: 'test',
        dir: `test/${WORK_ID}`,
        title: 'workExists 测试作品',
        circleId,
      },
      {
        id: DELETED_ID,
        rootFolder: 'test',
        dir: `test/${DELETED_ID}`,
        title: 'workExists 测试作品（已软删）',
        circleId,
        deletedAt: new Date().toISOString(),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.id, WORK_ID));
    await db.delete(works).where(eq(works.id, DELETED_ID));
    await removeRootFolder('test');
    await db.delete(circles).where(eq(circles.id, circleId));
  });

  it('liveWorkExists：在库作品 → true', async () => {
    expect(await liveWorkExists(WORK_ID)).toBe(true);
  });

  it('liveWorkExists：库中不存在的 id → false', async () => {
    expect(await liveWorkExists(MISSING_ID)).toBe(false);
  });

  it('liveWorkExists：已软删作品视为不存在 → false', async () => {
    expect(await liveWorkExists(DELETED_ID)).toBe(false);
  });

  // 对照组：workExists 是「行存在」，含软删行（workAdmin 删除路由判 404 用）
  it('workExists：软删行仍算存在 → true', async () => {
    expect(await workExists(DELETED_ID)).toBe(true);
    expect(await workExists(MISSING_ID)).toBe(false);
  });
});

describe('实体列表内联 favourited（getCircles/getVas/getSeries）', () => {
  const USER = `list_fav_${RUN}`;
  const SERIES_ID = `SRI${RUN}`;
  const VA_ID = `VA${RUN}`;
  const CIRCLE_FAV = `RG98${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const CIRCLE_PLAIN = `RG99${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

  beforeAll(async () => {
    await db.insert(users).values({ name: USER, password: 'x', group: 'user' });
    await db.insert(circles).values([
      { id: CIRCLE_FAV, name: `favourited 社团_${RUN}` },
      { id: CIRCLE_PLAIN, name: `未收藏社团_${RUN}` },
    ]);
    await db
      .insert(series)
      .values({ id: SERIES_ID, name: `favourited 系列_${RUN}` });
    await db.insert(vas).values({ id: VA_ID, name: `favourited 声优_${RUN}` });
    await db.insert(favourites).values([
      { userName: USER, targetType: 'circle', targetId: CIRCLE_FAV },
      { userName: USER, targetType: 'series', targetId: SERIES_ID },
      { userName: USER, targetType: 'va', targetId: VA_ID },
    ]);
  });

  afterAll(async () => {
    await db.delete(favourites).where(eq(favourites.userName, USER));
    await db.delete(users).where(eq(users.name, USER));
    await db.delete(circles).where(eq(circles.id, CIRCLE_FAV));
    await db.delete(circles).where(eq(circles.id, CIRCLE_PLAIN));
    await db.delete(series).where(eq(series.id, SERIES_ID));
    await db.delete(vas).where(eq(vas.id, VA_ID));
  });

  it('已登录：收藏的实体 favourited=true，未收藏为 false', async () => {
    const circlesRows = await getCircles(USER);
    expect(circlesRows.find((r) => r.id === CIRCLE_FAV)?.favourited).toBe(true);
    expect(circlesRows.find((r) => r.id === CIRCLE_PLAIN)?.favourited).toBe(
      false,
    );
    expect(
      (await getSeries(USER)).find((r) => r.id === SERIES_ID)?.favourited,
    ).toBe(true);
    expect((await getVas(USER)).find((r) => r.id === VA_ID)?.favourited).toBe(
      true,
    );
  });

  it('匿名（不传 username）：全部 favourited=false', async () => {
    expect(
      (await getCircles()).find((r) => r.id === CIRCLE_FAV)?.favourited,
    ).toBe(false);
    expect(
      (await getSeries()).find((r) => r.id === SERIES_ID)?.favourited,
    ).toBe(false);
    expect((await getVas()).find((r) => r.id === VA_ID)?.favourited).toBe(
      false,
    );
  });
});

describe('实体列表 workCount（生效口径，覆盖感知）', () => {
  // circle 主键是 maker_id 形态 text；series/va 用 RUN 后缀保证跨文件唯一
  const C_NONE = `RG91${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const C_TWO = `RG92${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const C_DEL = `RG93${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const C_OLD = `RG94${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const C_NEW = `RG95${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
  const S_NONE = `SRIWCA${RUN}`;
  const S_LIVE = `SRIWCB${RUN}`; // w1 原始系列
  const S_OLD = `SRIWCC${RUN}`; // w3 原始系列（被覆盖改挂）
  const S_NEW = `SRIWCD${RUN}`; // w3 覆盖目标系列
  const V_NONE = `VAWCA${RUN}`;
  const V_LIVE = `VAWCB${RUN}`; // w1 原始关联
  const V_CLEARED = `VAWCC${RUN}`; // w4 原始关联 + vas_cleared
  const V_ADDED = `VAWCD${RUN}`; // 仅覆盖 add
  const V_REMOVED = `VAWCE${RUN}`; // w1 原始关联 + remove 行
  const TAG_BASE = 9_000_000 + (Number.parseInt(RUN, 36) % 100_000) * 10;
  const T_NONE = TAG_BASE;
  const T_LIVE = TAG_BASE + 1; // w1 + w4 均有原始关联，w4 被 cleared → 只计 w1
  const T_REMOVED = TAG_BASE + 2; // w1 原始关联 + remove 行 → 0
  const T_ADDED = TAG_BASE + 3; // 仅覆盖 add（w4）→ 1
  const T_DELETED = TAG_BASE + 4; // 挂在软删作品 w2 上 → 0
  const W1 = `RJWC1${RUN}`;
  const W2 = `RJWC2${RUN}`; // 软删
  const W3 = `RJWC3${RUN}`; // circle/series 均被覆盖改挂
  const W4 = `RJWC4${RUN}`; // tags/vas 被清空 + 覆盖新增

  beforeAll(async () => {
    await ensureRootFolder('test');
    await db.insert(circles).values([
      { id: C_NONE, name: `workCount 无关联社团_${RUN}` },
      { id: C_TWO, name: `workCount 两作品社团_${RUN}` },
      { id: C_DEL, name: `workCount 软删社团_${RUN}` },
      { id: C_OLD, name: `workCount 被改挂社团_${RUN}` },
      { id: C_NEW, name: `workCount 覆盖目标社团_${RUN}` },
    ]);
    await db.insert(series).values([
      { id: S_NONE, name: `workCount 无关联系列_${RUN}` },
      { id: S_LIVE, name: `workCount 在库系列_${RUN}` },
      { id: S_OLD, name: `workCount 被改挂系列_${RUN}` },
      { id: S_NEW, name: `workCount 覆盖目标系列_${RUN}` },
    ]);
    await db.insert(vas).values([
      { id: V_NONE, name: `workCount 无关联声优_${RUN}` },
      { id: V_LIVE, name: `workCount 在库声优_${RUN}` },
      { id: V_CLEARED, name: `workCount 被清空声优_${RUN}` },
      { id: V_ADDED, name: `workCount 覆盖新增声优_${RUN}` },
      { id: V_REMOVED, name: `workCount 被移除声优_${RUN}` },
    ]);
    await db.insert(tags).values([
      { id: T_NONE, name: `workCount 无关联标签_${RUN}` },
      { id: T_LIVE, name: `workCount 在库标签_${RUN}` },
      { id: T_REMOVED, name: `workCount 被移除标签_${RUN}` },
      { id: T_ADDED, name: `workCount 覆盖新增标签_${RUN}` },
      { id: T_DELETED, name: `workCount 软删作品标签_${RUN}` },
    ]);
    await db.insert(works).values([
      {
        id: W1,
        rootFolder: 'test',
        dir: `test/${W1}`,
        title: 'workCount 作品1',
        circleId: C_TWO,
        seriesId: S_LIVE,
      },
      {
        id: W2,
        rootFolder: 'test',
        dir: `test/${W2}`,
        title: 'workCount 作品2（软删）',
        circleId: C_DEL,
        deletedAt: new Date().toISOString(),
      },
      {
        id: W3,
        rootFolder: 'test',
        dir: `test/${W3}`,
        title: 'workCount 作品3（改挂）',
        circleId: C_OLD,
        seriesId: S_OLD,
      },
      {
        id: W4,
        rootFolder: 'test',
        dir: `test/${W4}`,
        title: 'workCount 作品4（清空）',
        circleId: C_TWO,
      },
    ]);
    // 标量覆盖：w3 的 circle/series 改挂；w4 仅清空 tags/vas（标量不变）
    await db.insert(workMetaOverride).values([
      { workId: W3, circleId: C_NEW, seriesId: S_NEW },
      { workId: W4, tagsCleared: 1, vasCleared: 1 },
    ]);
    // 原始关系：w1 双标签双声优（其一稍后 remove）；w2 挂软删标签；w4 与 w1 同标签 + 被清空声优
    await db.insert(tagWork).values([
      { workId: W1, tagId: T_LIVE },
      { workId: W1, tagId: T_REMOVED },
      { workId: W2, tagId: T_DELETED },
      { workId: W4, tagId: T_LIVE },
    ]);
    await db.insert(vaWork).values([
      { workId: W1, vaId: V_LIVE },
      { workId: W1, vaId: V_REMOVED },
      { workId: W4, vaId: V_CLEARED },
    ]);
    // 关系覆盖 delta：remove 屏蔽原始，add 无中生有
    await db.insert(tagWorkOverride).values([
      { workId: W1, tagId: T_REMOVED, action: 'remove' },
      { workId: W4, tagId: T_ADDED, action: 'add' },
    ]);
    await db.insert(vaWorkOverride).values([
      { workId: W1, vaId: V_REMOVED, action: 'remove' },
      { workId: W4, vaId: V_ADDED, action: 'add' },
    ]);
  });

  afterAll(async () => {
    // 先删关系/覆盖与作品，再删实体与根目录（FK restrict/cascade 顺序）
    for (const id of [W1, W2, W3, W4]) {
      await db.delete(tagWorkOverride).where(eq(tagWorkOverride.workId, id));
      await db.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, id));
      await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, id));
      await db.delete(tagWork).where(eq(tagWork.workId, id));
      await db.delete(vaWork).where(eq(vaWork.workId, id));
      await db.delete(works).where(eq(works.id, id));
    }
    for (const id of [C_NONE, C_TWO, C_DEL, C_OLD, C_NEW]) {
      await db.delete(circles).where(eq(circles.id, id));
    }
    for (const id of [S_NONE, S_LIVE, S_OLD, S_NEW]) {
      await db.delete(series).where(eq(series.id, id));
    }
    for (const id of [V_NONE, V_LIVE, V_CLEARED, V_ADDED, V_REMOVED]) {
      await db.delete(vas).where(eq(vas.id, id));
    }
    for (const id of [T_NONE, T_LIVE, T_REMOVED, T_ADDED, T_DELETED]) {
      await db.delete(tags).where(eq(tags.id, id));
    }
    await removeRootFolder('test');
  });

  it('getCircles：生效口径计数（改挂后归目标社团，软删不计）', async () => {
    const rows = await getCircles();
    expect(rows.find((r) => r.id === C_NONE)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === C_TWO)?.workCount).toBe(2);
    expect(rows.find((r) => r.id === C_DEL)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === C_OLD)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === C_NEW)?.workCount).toBe(1);
  });

  it('getSeries：生效口径计数（覆盖改挂后归目标系列）', async () => {
    const rows = await getSeries();
    expect(rows.find((r) => r.id === S_NONE)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === S_LIVE)?.workCount).toBe(1);
    expect(rows.find((r) => r.id === S_OLD)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === S_NEW)?.workCount).toBe(1);
  });

  it('getTags：生效口径计数（remove/cleared/软删均不计，add 计入）', async () => {
    const rows = await getTags();
    expect(rows.find((r) => r.id === T_NONE)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === T_LIVE)?.workCount).toBe(1);
    expect(rows.find((r) => r.id === T_REMOVED)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === T_ADDED)?.workCount).toBe(1);
    expect(rows.find((r) => r.id === T_DELETED)?.workCount).toBe(0);
  });

  it('getVas：生效口径计数（remove/cleared/软删均不计，add 计入）', async () => {
    const rows = await getVas();
    expect(rows.find((r) => r.id === V_NONE)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === V_LIVE)?.workCount).toBe(1);
    expect(rows.find((r) => r.id === V_CLEARED)?.workCount).toBe(0);
    expect(rows.find((r) => r.id === V_ADDED)?.workCount).toBe(1);
    expect(rows.find((r) => r.id === V_REMOVED)?.workCount).toBe(0);
  });
});
