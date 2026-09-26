import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ensureRootFolder, removeRootFolder } from '@test/helpers/rootFolder';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  favourites,
  series,
  users,
  vas,
  works,
} from '../infra/db/main/schema.js';
import {
  addFavourite,
  listFavourites,
  removeFavourite,
  statusFavourites,
} from './favourite.service.js';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const USER = `fav_svc_${RUN}`;
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;
const SERIES_ID = `SRI${RUN}`;
const VA_ID = `VA${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text（真实形态而非递增整数）；
// RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG97${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

describe('favourite.service', () => {
  let circleId: string;

  beforeAll(async () => {
    await db.insert(users).values({ name: USER, password: 'x', group: 'user' });
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `测试社团_${RUN}` })
      .returning();
    // biome-ignore lint/style/noNonNullAssertion: 测试前置数据必须存在，插入失败时用例本身会失败
    circleId = circle[0]!.id;
    await db.insert(series).values({ id: SERIES_ID, name: `测试系列_${RUN}` });
    await db.insert(vas).values({ id: VA_ID, name: `测试声优_${RUN}` });
    await ensureRootFolder('test');
    await db.insert(works).values({
      id: WORK_ID,
      rootFolder: 'test',
      dir: `test/${WORK_ID}`,
      title: '收藏测试作品',
      circleId,
      seriesId: SERIES_ID,
    });
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.id, WORK_ID));
    await removeRootFolder('test');
    await db.delete(favourites).where(eq(favourites.userName, USER));
    await db.delete(users).where(eq(users.name, USER));
    await db.delete(series).where(eq(series.id, SERIES_ID));
    await db.delete(vas).where(eq(vas.id, VA_ID));
    await db.delete(circles).where(eq(circles.id, circleId));
  });

  it('收藏四类目标均成功；重复收藏幂等', async () => {
    expect(await addFavourite(USER, 'work', WORK_ID)).toBe(true);
    expect(await addFavourite(USER, 'series', SERIES_ID)).toBe(true);
    expect(await addFavourite(USER, 'va', VA_ID)).toBe(true);
    expect(await addFavourite(USER, 'circle', String(circleId))).toBe(true);

    // 幂等：重复添加不报错也不重复
    expect(await addFavourite(USER, 'work', WORK_ID)).toBe(true);
    const rows = await db
      .select()
      .from(favourites)
      .where(eq(favourites.userName, USER));
    expect(rows.length).toBe(4);
  });

  // Task 4 review 发现：circle 分支曾带 Number.isInteger 守卫，maker_id 转数字为 NaN，
  // 导致所有合法社团收藏都查不到。这里用真实形态的 maker_id 断言可收藏、可读回、
  // 状态映射为 true——把 id 当数字比较时这三条都会失败。
  it('circle 收藏用 maker_id 字符串：可加、可读回、状态为 true', async () => {
    expect(await addFavourite(USER, 'circle', CIRCLE_ID)).toBe(true);

    const { favourites: items } = await listFavourites(USER, 'circle');
    const circle = items.find((i) => i.targetType === 'circle');
    expect(circle?.targetId).toBe(CIRCLE_ID);
    expect(circle?.target).toMatchObject({
      id: CIRCLE_ID,
      name: `测试社团_${RUN}`,
      workCount: 1,
    });

    expect(await statusFavourites(USER, 'circle', [CIRCLE_ID])).toEqual({
      [CIRCLE_ID]: true,
    });
  });

  it('目标不存在时返回 false', async () => {
    expect(await addFavourite(USER, 'work', 'RJ99999999')).toBe(false);
    expect(await addFavourite(USER, 'circle', 'RG99999')).toBe(false);
    expect(await addFavourite(USER, 'circle', 'not-a-number')).toBe(false);
  });

  it('listFavourites 返回目标摘要（work / entity 两形态）', async () => {
    const { favourites: items } = await listFavourites(USER);
    expect(items.length).toBe(4);

    const work = items.find((i) => i.targetType === 'work');
    expect(work).toMatchObject({
      targetId: WORK_ID,
      target: {
        id: WORK_ID,
        title: '收藏测试作品',
        circleName: `测试社团_${RUN}`,
      },
    });

    const seriesItem = items.find((i) => i.targetType === 'series');
    expect(seriesItem).toMatchObject({
      target: { id: SERIES_ID, name: `测试系列_${RUN}`, workCount: 1 },
    });

    const va = items.find((i) => i.targetType === 'va');
    expect(va).toMatchObject({
      target: { id: VA_ID, name: `测试声优_${RUN}`, workCount: 0 },
    });

    const circle = items.find((i) => i.targetType === 'circle');
    expect(circle).toMatchObject({
      target: { id: circleId, name: `测试社团_${RUN}`, workCount: 1 },
    });

    // 按 targetType 过滤
    const onlySeries = await listFavourites(USER, 'series');
    expect(onlySeries.favourites.length).toBe(1);
    expect(onlySeries.favourites[0]?.targetId).toBe(SERIES_ID);
  });

  it('statusFavourites 批量返回布尔映射', async () => {
    const status = await statusFavourites(USER, 'work', [
      WORK_ID,
      'RJ00000000',
    ]);
    expect(status).toEqual({ [WORK_ID]: true, RJ00000000: false });
  });

  it('removeFavourite 删除后列表与状态同步消失', async () => {
    await removeFavourite(USER, 'va', VA_ID);
    const { favourites: items } = await listFavourites(USER);
    expect(items.find((i) => i.targetType === 'va')).toBeUndefined();
    const status = await statusFavourites(USER, 'va', [VA_ID]);
    expect(status).toEqual({ [VA_ID]: false });
  });
});
