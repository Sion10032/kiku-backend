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
  tagWorkOverride,
  vaWorkOverride,
  workMetaOverride,
} from '../infra/db/main/schema.js';
import { saveOverride } from './metadataOverride.service.js';
import { getWorkById, queryWorks } from './work.service.js';

setupTestEnvironment();

beforeAll(insertOverrideFixtures);
afterAll(cleanupOverrideFixtures);

beforeEach(async () => {
  await db.delete(tagWorkOverride).where(eq(tagWorkOverride.workId, OVR.w1));
  await db.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, OVR.w1));
  await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, OVR.w1));
});

describe('列表/详情返回生效值', () => {
  it('queryWorks 返回合并后的生效值；无覆盖作品不变', async () => {
    await saveOverride(OVR.w1, { title: `标题_override_${OVR.base}` });
    const r = await queryWorks(undefined, undefined, { pageSize: 500 });
    const w1 = r.works.find((w) => w.id === OVR.w1);
    const w2 = r.works.find((w) => w.id === OVR.w2);
    expect(w1?.title).toBe(`标题_override_${OVR.base}`);
    expect(w1?.overriddenFields).toEqual(['title']);
    expect(w2?.title).toBe(`标题乙_${OVR.base}`);
    expect(w2?.overriddenFields ?? []).toEqual([]);
  });

  it('排序回归：有覆盖与无覆盖时 release 排序的 id 序列完全一致', async () => {
    const before = await queryWorks(undefined, undefined, { pageSize: 500 });
    const beforeIds = before.works.map((w) => w.id);
    await saveOverride(OVR.w1, { title: `标题_override_${OVR.base}` });
    await saveOverride(OVR.w2, { tagsCleared: true });
    const after = await queryWorks(undefined, undefined, { pageSize: 500 });
    expect(after.works.map((w) => w.id)).toEqual(beforeIds); // 排序键不可覆盖 → 顺序恒不变
  });

  it('getWorkById 返回生效值 + overriddenFields', async () => {
    await saveOverride(OVR.w1, {
      title: `标题_override_${OVR.base}`,
      addTags: [`标签Z_${OVR.base}`],
    });
    const work = await getWorkById(OVR.w1);
    expect(work.title).toBe(`标题_override_${OVR.base}`);
    expect(work.tags.map((t) => t.name)).toContain(`标签Z_${OVR.base}`);
    expect(work.overriddenFields).toEqual(['title', 'tags']);
  });
});
