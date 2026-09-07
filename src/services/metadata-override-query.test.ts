import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  cleanupOverrideFixtures,
  insertOverrideFixtures,
  OVR,
} from '@test/fixtures/override';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  tags,
  tagWorkOverride,
  vaWorkOverride,
  workMetaOverride,
} from '../infra/db/main/schema.js';
import { saveOverride } from './metadataOverride.service.js';
import { queryWorks } from './work.service.js';

setupTestEnvironment();

beforeAll(insertOverrideFixtures);
afterAll(cleanupOverrideFixtures);

beforeEach(async () => {
  for (const id of [OVR.w1, OVR.w2, OVR.w3]) {
    await db.delete(tagWorkOverride).where(eq(tagWorkOverride.workId, id));
    await db.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, id));
    await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, id));
  }
});

function ids(result: Awaited<ReturnType<typeof queryWorks>>): string[] {
  return result.works.map((w) => w.id).sort();
}

async function tagIdByName(name: string): Promise<number> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);
  if (!rows[0]) throw new Error(`fixture tag missing: ${name}`);
  return rows[0].id;
}

describe('LQL 命中生效值', () => {
  it('无覆盖回归：tag:X 命中 W1+W2，与原始行为一致', async () => {
    const r = await queryWorks(`tag:${OVR.tagX}`, undefined, { pageSize: 500 });
    expect(ids(r)).toEqual([OVR.w1, OVR.w2]);
  });

  it('tag add：覆盖新增的 tag 可被 tag: 命中（rescan 语义无关，delta add 行）', async () => {
    await saveOverride(OVR.w3, { addTags: [`标签Z_${OVR.base}`] });
    const r = await queryWorks(`tag:标签Z_${OVR.base}`, undefined, {
      pageSize: 500,
    });
    expect(ids(r)).toEqual([OVR.w3]);
  });

  it('tag remove：被移除的不再命中；-tag: 取反包含它', async () => {
    await saveOverride(OVR.w2, { removeTagIds: [await tagIdByName(OVR.tagX)] });
    const hit = await queryWorks(`tag:${OVR.tagX}`, undefined, {
      pageSize: 500,
    });
    expect(ids(hit)).toEqual([OVR.w1]);
    // -tag: 是全库集合成员查询（同进程共享库含其它用例的 works），
    // 断言成员性质而非全集，保证任意文件运行顺序下封闭
    const not = await queryWorks(`-tag:${OVR.tagX}`, undefined, {
      pageSize: 500,
    });
    const notIds = ids(not);
    expect(notIds).toContain(OVR.w2); // W2 已不再有效持有 X
    expect(notIds).toContain(OVR.w3);
    expect(notIds).not.toContain(OVR.w1); // W1 仍有效持有 X
  });

  it('cleared：清空全部标签后原 tag 不再命中', async () => {
    await saveOverride(OVR.w2, { tagsCleared: true });
    const r = await queryWorks(`tag:${OVR.tagX}`, undefined, { pageSize: 500 });
    expect(ids(r)).toEqual([OVR.w1]);
  });

  it('circle override：覆盖后的社团被 circle: 命中，原始社团不再命中', async () => {
    await saveOverride(OVR.w3, { circleName: OVR.circleA });
    const hit = await queryWorks(`circle:${OVR.circleA}`, undefined, {
      pageSize: 500,
    });
    expect(ids(hit)).toEqual([OVR.w1, OVR.w2, OVR.w3]);
    const miss = await queryWorks(`circle:${OVR.circleB}`, undefined, {
      pageSize: 500,
    });
    expect(ids(miss)).toEqual([]);
  });

  it('series override：覆盖后的系列被 series: 命中', async () => {
    await saveOverride(OVR.w3, { seriesName: OVR.seriesXName });
    const r = await queryWorks(`series:${OVR.seriesXName}`, undefined, {
      pageSize: 500,
    });
    expect(ids(r)).toEqual([OVR.w1, OVR.w2, OVR.w3]);
  });

  it('age override：覆盖后的分级被 age: 命中', async () => {
    await saveOverride(OVR.w3, { ageRating: 'r18' });
    const r = await queryWorks('age:r18', undefined, { pageSize: 500 });
    expect(ids(r)).toEqual([OVR.w2, OVR.w3]);
  });

  it('裸词命中覆盖后的标题；原标题不再命中；未覆盖作品搜索不受影响', async () => {
    await saveOverride(OVR.w2, { title: `标题_override_${OVR.base}` });
    const hit = await queryWorks(`标题_override_${OVR.base}`, undefined, {
      pageSize: 500,
    });
    expect(ids(hit)).toEqual([OVR.w2]);
    const miss = await queryWorks(`标题乙_${OVR.base}`, undefined, {
      pageSize: 500,
    });
    expect(ids(miss)).toEqual([]);
    const untouched = await queryWorks(`标题甲_${OVR.base}`, undefined, {
      pageSize: 500,
    });
    expect(ids(untouched)).toEqual([OVR.w1]);
  });

  it('通配符模糊路径：tag:标签* 通配仍工作（LIKE + ESCAPE 不回归）', async () => {
    await saveOverride(OVR.w3, { addTags: [`标签Z_${OVR.base}`] });
    const r = await queryWorks('tag:标签*', undefined, { pageSize: 500 });
    expect(ids(r)).toEqual([OVR.w1, OVR.w2, OVR.w3]);
  });
});
