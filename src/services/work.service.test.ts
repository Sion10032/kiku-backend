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
  getCircles,
  getSeries,
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
