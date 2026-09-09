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
import { workMetaOverride } from '../infra/db/main/schema.js';
import { saveOverride } from './metadataOverride.service.js';
import { QueryParseError } from './query/parser.js';
import {
  InvalidRegexError,
  type SanitizeTitlesPreview,
  sanitizeTitles,
} from './title-sanitize.service.js';

setupTestEnvironment();

beforeAll(insertOverrideFixtures);
afterAll(cleanupOverrideFixtures);

beforeEach(async () => {
  for (const id of [OVR.w1, OVR.w2, OVR.w3]) {
    await db.delete(workMetaOverride).where(eq(workMetaOverride.workId, id));
  }
});

describe('sanitizeTitles', () => {
  it('dryRun：基准是 original title；overridden 计数与标注正确；不写库', async () => {
    // w2 已有 title 覆盖（生效值≠original）；w1 未覆盖
    await saveOverride(OVR.w2, { title: `手工改过_${OVR.base}` });
    const r = (await sanitizeTitles({
      pattern: '^标题乙',
      replacement: '乙',
      q: `circle:${OVR.circleA}`,
      dryRun: true,
    })) as SanitizeTitlesPreview;
    expect(r.matched).toBe(1); // w1 标题甲不匹配；w2 命中
    expect(r.overridden).toBe(1); // w2 已有覆盖
    const sample = r.samples[0];
    expect(sample?.id).toBe(OVR.w2);
    expect(sample?.before).toBe(`标题乙_${OVR.base}`); // 原始值，不是覆盖值
    expect(sample?.after).toBe(`乙_${OVR.base}`);
    expect(sample?.overridden).toBe(true);
    // 未写库
    const meta = await db
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, OVR.w2))
      .get();
    expect(meta?.title).toBe(`手工改过_${OVR.base}`);
  });

  it('dryRun=false：事务批量落覆盖，updatedBy 记录；无变化作品不产生覆盖行', async () => {
    const r = await sanitizeTitles({
      pattern: '^标题乙',
      replacement: '乙',
      q: `circle:${OVR.circleA}`,
      dryRun: false,
      updatedBy: 'sanitize-admin',
    });
    expect(r).toEqual({ success: true, matched: 1, overridden: 0 });
    const w2 = await db
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, OVR.w2))
      .get();
    expect(w2?.title).toBe(`乙_${OVR.base}`);
    expect(w2?.updatedBy).toBe('sanitize-admin');
    const w1 = await db
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, OVR.w1))
      .get();
    expect(w1).toBeUndefined(); // 标题甲无变化 → 忽略
  });

  it('非法正则 → InvalidRegexError（消息来自 RegExp 引擎）', async () => {
    await expect(
      sanitizeTitles({ pattern: '(', replacement: '', dryRun: true }),
    ).rejects.toBeInstanceOf(InvalidRegexError);
  });

  it('非法 LQL → QueryParseError 透传（路由层映射 400）', async () => {
    await expect(
      sanitizeTitles({
        pattern: 'a',
        replacement: '',
        q: 'price:1',
        dryRun: true,
      }),
    ).rejects.toBeInstanceOf(QueryParseError);
  });

  it('q 缺省 = 全库；替换结果与原值相同 → matched 0', async () => {
    const r = (await sanitizeTitles({
      pattern: '标题',
      replacement: '标题',
      dryRun: true,
    })) as SanitizeTitlesPreview;
    expect(r.matched).toBe(0);
    expect(r.samples).toEqual([]);
  });

  it('overridden:title 圈定后执行：覆盖已有 title 覆盖的作品', async () => {
    await saveOverride(OVR.w2, { title: `上次净化_${OVR.base}` });
    await sanitizeTitles({
      pattern: '^标题乙',
      replacement: '乙',
      q: `circle:${OVR.circleA} overridden:title`,
      dryRun: false,
      updatedBy: 'sanitize-admin',
    });
    const w2 = await db
      .select()
      .from(workMetaOverride)
      .where(eq(workMetaOverride.workId, OVR.w2))
      .get();
    expect(w2?.title).toBe(`乙_${OVR.base}`); // 覆盖了上次的覆盖
  });
});
