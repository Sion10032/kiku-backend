import { afterAll, beforeEach, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/main/index.js';
import { circles, series, tags, vas, works } from '../src/db/main/schema.js';
import { upsertTrackRow } from '../src/services/track.service.js';
import type { UpsertWorkInput } from '../src/services/work.service.js';
import {
  getWorkById,
  queryWorks,
  softDeleteWork,
  upsertWork,
} from '../src/services/work.service.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// base 取 7 位数字：RJ{base}{1,2,3} 恰为 8 位，符合库内合法 RJ 号格式
// （extractRJCode 只认 6/8 位），使「裸 RJ 号精确匹配」用例走 eq 路径
const base = 1000000 + Math.floor(Math.random() * 2000000);
const CIRCLE_A = `查询测试社团A${base}`;
const CIRCLE_B = `查询测试社团B${base}`;
const TAG_X = `查询测试X${base}`;
const TAG_Y = `查询测试Y${base}`;
const VA_1 = `va-${base}-1`;
const VA_1_NAME = `查询声优${base}`; // compiler 的 va 筛选按姓名匹配（vas.name）
// 系列名含空格：验证引号字面值语义（unquoted 值不允许空格，须引号）
const SERIES_X = `SRIT${base}X`;
const SERIES_X_NAME = `查询测试系列 ${base}`;
const W1 = `RJ${base}1`; // circleA + tagX + tagY + va1 + seriesX，标题含「催眠音声」
const W2 = `RJ${base}2`; // circleA + tagX + seriesX
const W3 = `RJ${base}3`; // circleB + tagY，无系列

async function insertFixtures(): Promise<void> {
  const rows: UpsertWorkInput[] = [
    {
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `催眠音声${base}`,
      circleName: CIRCLE_A,
      ageRating: 'all',
      release: '2024-01-01',
      tags: [TAG_X, TAG_Y],
      vas: [{ id: VA_1, name: VA_1_NAME }],
      series: { id: SERIES_X, name: SERIES_X_NAME },
    },
    {
      id: W2,
      rootFolder: 'testroot',
      dir: `q/${W2}`,
      title: `普通作品${base}`,
      circleName: CIRCLE_A,
      ageRating: 'r18',
      release: '2024-01-02',
      tags: [TAG_X],
      vas: [],
      series: { id: SERIES_X, name: SERIES_X_NAME },
    },
    {
      id: W3,
      rootFolder: 'testroot',
      dir: `q/${W3}`,
      title: `无关作品${base}`,
      circleName: CIRCLE_B,
      ageRating: 'all',
      release: '2024-01-03',
      tags: [TAG_Y],
      vas: [],
    },
  ];
  for (const r of rows) {
    const res = await upsertWork(r);
    if (!res.success) throw new Error(res.error);
  }
}

function ids(result: Awaited<ReturnType<typeof queryWorks>>): string[] {
  return result.works.map((w) => w.id);
}

afterAll(async () => {
  await db
    .delete(works)
    .where(inArray(works.id, [W1, W2, W3]))
    .catch(() => {});
  await db
    .delete(tags)
    .where(eq(tags.name, TAG_X))
    .catch(() => {});
  await db
    .delete(tags)
    .where(eq(tags.name, TAG_Y))
    .catch(() => {});
  await db
    .delete(vas)
    .where(eq(vas.id, VA_1))
    .catch(() => {});
  await db
    .delete(circles)
    .where(eq(circles.name, CIRCLE_A))
    .catch(() => {});
  await db
    .delete(circles)
    .where(eq(circles.name, CIRCLE_B))
    .catch(() => {});
  // series 关联不随 works 级联删除，series 主表需手动清理
  await db
    .delete(series)
    .where(eq(series.id, SERIES_X))
    .catch(() => {});
});

describe('queryWorks', () => {
  it('fixture 全部可查（空 q）', async () => {
    await insertFixtures();
    const r = await queryWorks(undefined, undefined, { pageSize: 500 });
    expect(ids(r)).toContain(W1);
    expect(r.works[0]?.userRating).toBeNull(); // 匿名不注入
  });

  it('tag 精确筛选', async () => {
    const r = await queryWorks(`tag:${TAG_X}`, undefined, { pageSize: 500 });
    expect(ids(r).sort()).toEqual([W1, W2].sort());
  });

  it('circle + tag 组合（隐式 AND）', async () => {
    const r = await queryWorks(`circle:${CIRCLE_A} tag:${TAG_X}`, undefined, {
      pageSize: 500,
    });
    expect(ids(r).sort()).toEqual([W1, W2].sort());
  });

  it('排除 -tag', async () => {
    const r = await queryWorks(`tag:${TAG_X} -tag:${TAG_Y}`, undefined, {
      pageSize: 500,
    });
    expect(ids(r)).toEqual([W2]);
  });

  it('va 筛选与 OR', async () => {
    const r = await queryWorks(
      `va:${VA_1_NAME} OR circle:${CIRCLE_B}`,
      undefined,
      { pageSize: 500 },
    );
    expect(ids(r).sort()).toEqual([W1, W3].sort());
  });

  it('series 精确筛选（引号含空格名称）', async () => {
    const r = await queryWorks(`series:"${SERIES_X_NAME}"`, undefined, {
      pageSize: 500,
    });
    expect(ids(r).sort()).toEqual([W1, W2].sort());
  });

  it('series 前缀通配符', async () => {
    const r = await queryWorks('series:查询测试系列*', undefined, {
      pageSize: 500,
    });
    expect(ids(r).sort()).toEqual([W1, W2].sort());
  });

  it('series 不存在 → 空结果', async () => {
    const r = await queryWorks(`series:"不存在${base}"`, undefined, {
      pageSize: 500,
    });
    expect(r.works).toEqual([]);
  });

  it('裸词标题模糊 + 裸 RJ 号精确', async () => {
    const t = await queryWorks(`催眠音声${base}`, undefined, { pageSize: 500 });
    expect(ids(t)).toEqual([W1]);
    const rj = await queryWorks(W1, undefined, { pageSize: 500 });
    expect(ids(rj)).toEqual([W1]);
  });

  it('age:r18', async () => {
    const r = await queryWorks(`circle:${CIRCLE_A} age:r18`, undefined, {
      pageSize: 500,
    });
    expect(ids(r)).toEqual([W2]);
  });

  it('分页与排序（release asc）', async () => {
    const r = await queryWorks(`circle:${CIRCLE_A}`, undefined, {
      page: 1,
      pageSize: 1,
      orderBy: 'release',
      sortDir: 'asc',
    });
    expect(ids(r)).toEqual([W1]);
    expect(r.pagination.totalCount).toBe(2);
    const r2 = await queryWorks(`circle:${CIRCLE_A}`, undefined, {
      page: 2,
      pageSize: 1,
      orderBy: 'release',
      sortDir: 'asc',
    });
    expect(ids(r2)).toEqual([W2]);
  });

  it('软删作品不可见', async () => {
    await softDeleteWork(W1);
    const r = await queryWorks(`tag:${TAG_X}`, undefined, { pageSize: 500 });
    expect(ids(r)).toEqual([W2]);
  });

  it('不支持的筛选字段抛错', async () => {
    await expect(queryWorks('price:100')).rejects.toThrow('不支持的筛选字段');
  });
});

describe('总时长注入（duration）', () => {
  // 上一个 describe 末尾软删了 W1，insertFixtures 幂等（upsert 清 deletedAt）
  beforeEach(insertFixtures);

  it('列表注入 SUM(duration_sec)：部分 null 取部分和，无音轨行为 null（匿名也注入）', async () => {
    await upsertTrackRow({
      workId: W1,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: 60,
    });
    await upsertTrackRow({
      workId: W1,
      mediaIndex: 'b.mp3',
      title: 'b',
      sizeBytes: 1,
      durationSec: null,
    });
    await upsertTrackRow({
      workId: W2,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: null,
    });

    const r = await queryWorks(undefined, undefined, { pageSize: 500 });
    const byId = new Map(r.works.map((w) => [w.id, w]));
    expect(byId.get(W1)?.duration).toBe(60);
    expect(byId.get(W2)?.duration).toBeNull();
    expect(byId.get(W3)?.duration).toBeNull();
  });

  it('详情同样注入', async () => {
    await upsertTrackRow({
      workId: W1,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: 75.5,
    });
    const w = await getWorkById(W1);
    expect(w.duration).toBe(75.5);
  });
});
