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
import {
  applyEffective,
  type EffectiveWork,
  getOverride,
  OverrideNotFoundError,
  resetField,
  saveOverride,
} from './metadataOverride.service.js';

setupTestEnvironment();

beforeAll(insertOverrideFixtures);
afterAll(cleanupOverrideFixtures);

// 每个用例从「无覆盖」状态出发，互不依赖执行顺序
beforeEach(async () => {
  await db.delete(tagWorkOverride).where(eq(tagWorkOverride.workId, OVR.w1));
  await db.delete(vaWorkOverride).where(eq(vaWorkOverride.workId, OVR.w1));
  await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, OVR.w1));
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

describe('saveOverride / getOverride', () => {
  it('标量覆盖：title + circleName → effective 变、original 不变', async () => {
    await saveOverride(OVR.w1, {
      title: `标题_override_${OVR.base}`,
      circleName: OVR.circleB,
      updatedBy: 'tester',
    });
    const detail = await getOverride(OVR.w1);
    expect(detail?.effective.title).toBe(`标题_override_${OVR.base}`);
    expect(detail?.original.title).toBe(`标题甲_${OVR.base}`);
    expect(detail?.effective.circle?.name).toBe(OVR.circleB);
    expect(detail?.original.circle?.name).toBe(OVR.circleA);
    expect(detail?.overriddenFields).toContain('title');
    expect(detail?.overriddenFields).toContain('circle');
    expect(detail?.overriddenFields).not.toContain('tags');
  });

  it('tag delta：remove 原始 + add 新名 → 生效集变、原始关系表未动', async () => {
    await saveOverride(OVR.w1, {
      addTags: [`标签Z_${OVR.base}`],
      removeTagIds: [await tagIdByName(OVR.tagX)],
    });
    const detail = await getOverride(OVR.w1);
    const names = detail?.effective.tags.map((t) => t.name) ?? [];
    expect(names).not.toContain(OVR.tagX);
    expect(names).toContain(`标签Z_${OVR.base}`);
    expect(names).toContain(OVR.tagY); // 未触碰的原始 tag 保留（delta 语义）
    // 原始关系表未动（scanner 可无差别重写的前提）
    const original = await db
      .select({ id: tagWorkOverride.tagId })
      .from(tagWorkOverride)
      .where(eq(tagWorkOverride.workId, OVR.w1));
    expect(original.length).toBe(2); // 1 remove + 1 add
  });

  it('撤销先前 add：remove 一个原始不存在的 tag → 行删除而非 remove 标记', async () => {
    await saveOverride(OVR.w1, { addTags: [`标签W_${OVR.base}`] });
    await saveOverride(OVR.w1, {
      removeTagIds: [await tagIdByName(`标签W_${OVR.base}`)],
    });
    const detail = await getOverride(OVR.w1);
    expect(detail?.override.tagActions ?? []).toEqual([]);
    expect(detail?.effective.tags.map((t) => t.name)).not.toContain(
      `标签W_${OVR.base}`,
    );
  });

  it('对原始 tag 先 remove 再 add → remove 行被撤销', async () => {
    const x = await tagIdByName(OVR.tagX);
    await saveOverride(OVR.w1, { removeTagIds: [x] });
    await saveOverride(OVR.w1, { addTags: [OVR.tagX] });
    const detail = await getOverride(OVR.w1);
    expect(detail?.override.tagActions ?? []).toEqual([]);
    expect(detail?.effective.tags.map((t) => t.name)).toContain(OVR.tagX);
  });

  it('tagsCleared：生效 tags 清空；解除后恢复', async () => {
    await saveOverride(OVR.w1, { tagsCleared: true });
    expect((await getOverride(OVR.w1))?.effective.tags).toEqual([]);
    expect((await getOverride(OVR.w1))?.overriddenFields).toContain('tags');
    await saveOverride(OVR.w1, { tagsCleared: false });
    expect((await getOverride(OVR.w1))?.effective.tags.length).toBe(2);
  });

  it('resetField：单字段恢复；全部恢复后主行被 prune', async () => {
    await saveOverride(OVR.w1, {
      title: `标题_override_${OVR.base}`,
      tagsCleared: true,
    });
    await resetField(OVR.w1, 'tags');
    let detail = await getOverride(OVR.w1);
    expect(detail?.overriddenFields).toEqual(['title']);
    await resetField(OVR.w1, 'title');
    detail = await getOverride(OVR.w1);
    expect(detail?.overriddenFields).toEqual([]);
    // 「存在即有覆盖」：主行被清理
    const rows = await db
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, OVR.w1));
    expect(rows.length).toBe(0);
  });

  it('saveOverride 不存在的作品 → OverrideNotFoundError', async () => {
    expect(saveOverride('RJ99999999', { title: 'x' })).rejects.toThrow(
      OverrideNotFoundError,
    );
  });
});

describe('applyEffective', () => {
  it('空数组直接返回；无覆盖的作品零改动', async () => {
    await applyEffective([]);
    const items: EffectiveWork[] = [
      {
        id: OVR.w2,
        title: `标题乙_${OVR.base}`,
        circle: { id: 1, name: OVR.circleA },
        series: null,
        ageRating: 'all',
        tags: [],
        vas: [],
      },
    ];
    await applyEffective(items);
    expect(items[0]?.title).toBe(`标题乙_${OVR.base}`);
    expect(items[0]?.overriddenFields).toBeUndefined();
  });

  it('标量替换 + tags delta 合并（原列表 − remove + add 追加）', async () => {
    await saveOverride(OVR.w1, {
      title: `标题_override_${OVR.base}`,
      removeTagIds: [await tagIdByName(OVR.tagX)],
      addTags: [`标签Z_${OVR.base}`],
    });
    const items: EffectiveWork[] = [
      {
        id: OVR.w1,
        title: `标题甲_${OVR.base}`,
        circle: { id: 1, name: OVR.circleA },
        series: null,
        ageRating: 'all',
        tags: [
          { id: await tagIdByName(OVR.tagX), name: OVR.tagX },
          { id: await tagIdByName(OVR.tagY), name: OVR.tagY },
        ],
        vas: [],
      },
      {
        id: OVR.w2,
        title: `标题乙_${OVR.base}`,
        circle: { id: 1, name: OVR.circleA },
        series: null,
        ageRating: 'all',
        tags: [],
        vas: [],
      },
    ];
    await applyEffective(items);
    expect(items[0]?.title).toBe(`标题_override_${OVR.base}`);
    expect(items[0]?.tags.map((t) => t.name)).toEqual([
      OVR.tagY,
      `标签Z_${OVR.base}`,
    ]);
    expect(items[0]?.overriddenFields).toEqual(['title', 'tags']);
    expect(items[1]?.overriddenFields).toBeUndefined(); // 无覆盖行 → 未标记未改动
  });

  it('cleared=1：生效 tags 只剩 add 行', async () => {
    await saveOverride(OVR.w1, {
      tagsCleared: true,
      addTags: [`标签Z_${OVR.base}`],
    });
    const items: EffectiveWork[] = [
      {
        id: OVR.w1,
        title: 't',
        circle: { id: 1, name: 'c' },
        series: null,
        ageRating: 'all',
        tags: [{ id: await tagIdByName(OVR.tagX), name: OVR.tagX }],
        vas: [],
      },
    ];
    await applyEffective(items);
    expect(items[0]?.tags.map((t) => t.name)).toEqual([`标签Z_${OVR.base}`]);
  });
});
