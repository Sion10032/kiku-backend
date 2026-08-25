import { afterAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/main/index.js';
import { tags, tagWork, works } from '../src/db/main/schema.js';
import {
  getWorkById,
  getWorksPaginated,
  hardDeleteWork,
  searchWorks,
  softDeleteWork,
  upsertWork,
} from '../src/services/work.service.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

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
    nsfw: false,
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
    const page = await getWorksPaginated({ pageSize: 100 });
    expect(page.works.some((x) => x.id === ID)).toBe(true);
    const s = await searchWorks(ID);
    expect(s.works.some((x) => x.id === ID)).toBe(true);
  });

  it('softDeleteWork 后：查询全部不可见，记录仍在库中（仅置标记）', async () => {
    await softDeleteWork(ID);
    await expect(getWorkById(ID)).rejects.toThrow('not found');
    const page = await getWorksPaginated({ pageSize: 100 });
    expect(page.works.some((x) => x.id === ID)).toBe(false);
    const s = await searchWorks(ID);
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
      nsfw: false,
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
