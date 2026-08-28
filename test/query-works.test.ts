import { afterAll, describe, expect, it } from 'bun:test';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../src/db/main/index.js';
import { circles, tags, vas, works } from '../src/db/main/schema.js';
import {
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
const W1 = `RJ${base}1`; // circleA + tagX + tagY + va1，标题含「催眠音声」
const W2 = `RJ${base}2`; // circleA + tagX
const W3 = `RJ${base}3`; // circleB + tagY

async function insertFixtures(): Promise<void> {
  const rows = [
    {
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `催眠音声${base}`,
      circleName: CIRCLE_A,
      nsfw: false,
      release: '2024-01-01',
      tags: [TAG_X, TAG_Y],
      vas: [{ id: VA_1, name: VA_1_NAME }],
    },
    {
      id: W2,
      rootFolder: 'testroot',
      dir: `q/${W2}`,
      title: `普通作品${base}`,
      circleName: CIRCLE_A,
      nsfw: true,
      release: '2024-01-02',
      tags: [TAG_X],
      vas: [],
    },
    {
      id: W3,
      rootFolder: 'testroot',
      dir: `q/${W3}`,
      title: `无关作品${base}`,
      circleName: CIRCLE_B,
      nsfw: false,
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

  it('裸词标题模糊 + 裸 RJ 号精确', async () => {
    const t = await queryWorks(`催眠音声${base}`, undefined, { pageSize: 500 });
    expect(ids(t)).toEqual([W1]);
    const rj = await queryWorks(W1, undefined, { pageSize: 500 });
    expect(ids(rj)).toEqual([W1]);
  });

  it('nsfw:true', async () => {
    const r = await queryWorks(`circle:${CIRCLE_A} nsfw:true`, undefined, {
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
