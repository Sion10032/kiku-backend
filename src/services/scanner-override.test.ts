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
import { queryWorks, upsertWork } from './work.service.js';

setupTestEnvironment();

beforeAll(insertOverrideFixtures);
afterAll(cleanupOverrideFixtures);

const TAG_RESCAN = `标签rescan_${1000000 + Math.floor(Math.random() * 2000000)}`;

beforeEach(async () => {
  for (const id of [OVR.w1, OVR.w2, OVR.w3]) {
    await db.delete(tagWorkOverride).where(eq(tagWorkOverride.workId, id));
    await db.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, id));
    await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, id));
  }
});

async function tagIdByName(name: string): Promise<number> {
  const rows = await db
    .select({ id: tags.id })
    .from(tags)
    .where(eq(tags.name, name))
    .limit(1);
  if (!rows[0]) throw new Error(`fixture tag missing: ${name}`);
  return rows[0].id;
}

describe('scanner 共存（rescan 后 delta 吸收）', () => {
  it('rescan 重写原始关系后：新 tag 流入、被 remove 的持续隐藏、管理员添加保留', async () => {
    await saveOverride(OVR.w1, {
      removeTagIds: [await tagIdByName(OVR.tagX)],
      addTags: [`标签Z_${OVR.base}`],
    });

    // 覆盖行数快照（rescan 不得触碰覆盖表）
    const ovrBefore = await db
      .select({ id: tagWorkOverride.tagId })
      .from(tagWorkOverride)
      .where(eq(tagWorkOverride.workId, OVR.w1));

    // 模拟 rescan：upsertWork 全量重写 W1 原始关系（新增 TAG_RESCAN，保留 X/Y）
    const res = await upsertWork({
      id: OVR.w1,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w1}`,
      title: `标题甲_${OVR.base}`,
      circleName: OVR.circleA,
      ageRating: 'all',
      release: '2024-01-01',
      tags: [OVR.tagX, OVR.tagY, TAG_RESCAN],
      vas: [],
      series: { id: OVR.seriesX, name: OVR.seriesXName },
    });
    if (!res.success) throw new Error(res.error);

    const ovrAfter = await db
      .select({ id: tagWorkOverride.tagId })
      .from(tagWorkOverride)
      .where(eq(tagWorkOverride.workId, OVR.w1));
    expect(ovrAfter.map((r) => r.id).sort()).toEqual(
      ovrBefore.map((r) => r.id).sort(),
    );

    const r = await queryWorks(undefined, undefined, { pageSize: 500 });
    const w1 = r.works.find((w) => w.id === OVR.w1);
    const names = w1?.tags.map((t) => t.name) ?? [];
    expect(names).toContain(OVR.tagY); // 未触碰的原始 tag 保留
    expect(names).toContain(TAG_RESCAN); // rescan 新增自动流入（delta 核心收益）
    expect(names).not.toContain(OVR.tagX); // 管理员移除持续隐藏
    expect(names).toContain(`标签Z_${OVR.base}`); // 管理员添加保留
  });

  it('cleared 作品：rescan 新增的 tag 被屏蔽', async () => {
    await saveOverride(OVR.w2, { tagsCleared: true });
    const res = await upsertWork({
      id: OVR.w2,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w2}`,
      title: `标题乙_${OVR.base}`,
      circleName: OVR.circleA,
      ageRating: 'r18',
      release: '2024-01-02',
      tags: [TAG_RESCAN],
      vas: [],
      series: { id: OVR.seriesX, name: OVR.seriesXName },
    });
    if (!res.success) throw new Error(res.error);
    const r = await queryWorks(undefined, undefined, { pageSize: 500 });
    const w2 = r.works.find((w) => w.id === OVR.w2);
    expect(w2?.tags).toEqual([]); // cleared 对 rescan 未来新增免疫
    const search = await queryWorks(`tag:${TAG_RESCAN}`, undefined, {
      pageSize: 500,
    });
    expect(search.works.map((w) => w.id)).not.toContain(OVR.w2);
  });

  it('失效 remove 行：原始关系被 rescan 删除后，saveOverride 顺手清理', async () => {
    await saveOverride(OVR.w3, { removeTagIds: [await tagIdByName(OVR.tagY)] });
    // rescan 不再含 tagY → 原有 remove 行失效
    const res = await upsertWork({
      id: OVR.w3,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w3}`,
      title: `标题丙_${OVR.base}`,
      circleName: OVR.circleB,
      ageRating: 'all',
      release: '2024-01-03',
      tags: [TAG_RESCAN],
      vas: [],
    });
    if (!res.success) throw new Error(res.error);
    await saveOverride(OVR.w3, { title: `标题_override_${OVR.base}` }); // 任意保存触发清理
    const stale = await db
      .select()
      .from(tagWorkOverride)
      .where(eq(tagWorkOverride.workId, OVR.w3));
    expect(stale).toEqual([]); // 失效 remove 行已清
  });
});
