import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ensureRootFolder, removeRootFolder } from '@test/helpers/rootFolder';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { tags, tagWork, works } from '../infra/db/main/schema.js';
import {
  getWorkById,
  hardDeleteWork,
  queryWorks,
  softDeleteWork,
  softDeleteWorks,
  upsertWork,
} from './work.service.js';

setupTestEnvironment();

beforeAll(async () => {
  await ensureRootFolder('testroot');
});

const base = 300000 + Math.floor(Math.random() * 500000);
const ID = `RJ${base}`;
const CIRCLE = `软删测试社团${base}`;
const TAG = `tag-${base}`;

async function insertFixture(): Promise<void> {
  const r = await upsertWork({
    id: ID,
    rootFolder: 'testroot',
    dir: `folder/${ID}`,
    title: `软删测试作品 ${ID}`,
    circleName: CIRCLE,
    ageRating: 'all',
    release: '2024-01-01',
    tags: [TAG],
    vas: [],
  });
  if (!r.success) throw new Error(r.error);
}

afterAll(async () => {
  await db
    .delete(works)
    .where(eq(works.id, ID))
    .catch(() => {});
  await removeRootFolder('testroot');
  await db
    .delete(tags)
    .where(eq(tags.name, TAG))
    .catch(() => {});
});

describe('软删除 / 恢复 / 物理删除', () => {
  it('软删前：getWorkById / 列表 / 搜索均可见', async () => {
    await insertFixture();
    const w = await getWorkById(ID);
    expect(w.id).toBe(ID);
    const page = await queryWorks(undefined, undefined, { pageSize: 100 });
    expect(page.works.some((x) => x.id === ID)).toBe(true);
    const s = await queryWorks(ID, undefined, { pageSize: 100 });
    expect(s.works.some((x) => x.id === ID)).toBe(true);
  });

  it('softDeleteWork 后：查询全部不可见，记录仍在库中（仅置标记）', async () => {
    await softDeleteWork(ID);
    await expect(getWorkById(ID)).rejects.toThrow('not found');
    const page = await queryWorks(undefined, undefined, { pageSize: 100 });
    expect(page.works.some((x) => x.id === ID)).toBe(false);
    const s = await queryWorks(ID, undefined, { pageSize: 100 });
    expect(s.works.some((x) => x.id === ID)).toBe(false);
    const row = (
      await db.select().from(works).where(eq(works.id, ID)).limit(1)
    )[0];
    expect(row?.deletedAt).not.toBeNull();
  });

  it('源恢复后 upsertWork：deletedAt 清空，重新可见（不产生新记录）', async () => {
    const r = await upsertWork({
      id: ID,
      rootFolder: 'testroot',
      dir: `folder/${ID}`,
      title: `软删测试作品 ${ID}`,
      circleName: CIRCLE,
      ageRating: 'all',
      release: '2024-01-01',
      tags: [],
      vas: [],
    });
    expect(r.success).toBe(true);
    expect(r.created).toBe(false);
    const row = (
      await db.select().from(works).where(eq(works.id, ID)).limit(1)
    )[0];
    expect(row?.deletedAt).toBeNull();
    expect((await getWorkById(ID)).id).toBe(ID);
  });

  it('hardDeleteWork：记录物理删除，级联清关联，共享 tag 保留', async () => {
    await hardDeleteWork(ID);
    const row = (
      await db.select().from(works).where(eq(works.id, ID)).limit(1)
    )[0];
    expect(row).toBeUndefined();
    const tw = (
      await db.select().from(tagWork).where(eq(tagWork.workId, ID)).limit(1)
    )[0];
    expect(tw).toBeUndefined(); // 级联清理
    const tag = (
      await db.select().from(tags).where(eq(tags.name, TAG)).limit(1)
    )[0];
    expect(tag).toBeDefined(); // 共享 tag 主记录不误删
    await expect(getWorkById(ID)).rejects.toThrow('not found');
  });
});

describe('softDeleteWorks 批量软删除', () => {
  const ID2 = `RJ${base + 1}`;
  const ID3 = `RJ${base + 2}`;

  const insertBatchFixture = async (id: string): Promise<void> => {
    const r = await upsertWork({
      id,
      rootFolder: 'testroot',
      dir: `folder/${id}`,
      title: `批量软删测试作品 ${id}`,
      circleName: CIRCLE,
      ageRating: 'all',
      release: '2024-01-01',
      tags: [],
      vas: [],
    });
    if (!r.success) throw new Error(r.error);
  };

  afterAll(async () => {
    await db
      .delete(works)
      .where(inArray(works.id, [ID2, ID3]))
      .catch(() => {});
  });

  const rowOf = async (id: string) =>
    (await db.select().from(works).where(eq(works.id, id)).limit(1))[0];

  it('批量软删：返回受影响数，全部不可见、deletedAt 置位', async () => {
    await insertBatchFixture(ID2);
    await insertBatchFixture(ID3);

    const deleted = await softDeleteWorks([ID2, ID3, 'RJ99999999']);
    expect(deleted).toBe(2); // 不存在的 id 不计入

    for (const id of [ID2, ID3]) {
      await expect(getWorkById(id)).rejects.toThrow('not found');
      expect((await rowOf(id))?.deletedAt).not.toBeNull();
    }
  });

  it('含已软删 id：幂等跳过，不刷新其删除时间', async () => {
    const before = (await rowOf(ID2))?.deletedAt;
    expect(before).not.toBeNull();

    // ISO 时间串毫秒精度：留出间隔，若被刷新则必不同
    await new Promise((r) => setTimeout(r, 5));
    const deleted = await softDeleteWorks([ID2, ID3]);
    expect(deleted).toBe(0); // 均已软删
    expect((await rowOf(ID2))?.deletedAt).toBe(before);
  });
});
