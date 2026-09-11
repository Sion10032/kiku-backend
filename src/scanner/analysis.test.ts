import { beforeEach, describe, expect, it } from 'bun:test';
import { memorySource } from '@test/helpers/memorySource.js';
import { setupTestEnvironment } from '@test/helpers/setup.js';
import { eq } from 'drizzle-orm';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';
import { db } from '../infra/db/main/index.js';
import { tracks, works } from '../infra/db/main/schema.js';
import { getTrackRows, upsertTrackRow } from '../services/track.service.js';
import { upsertWork } from '../services/work.service.js';
import { performAnalysis } from './analysis.js';

setupTestEnvironment();

const WORK = 'RJ00000003';

beforeEach(async () => {
  // preload 仅隔离进程（临时库单例），用例间需自行清残留音轨行
  // （上一用例写入的 loudness 会让 analyzeWork 的待分析过滤清空队列）
  await db.delete(tracks).where(eq(tracks.workId, WORK));
});

async function collect<T>(
  gen: AsyncGenerator<unknown, T>,
): Promise<{ events: unknown[]; ret: T }> {
  const events: unknown[] = [];
  let r = await gen.next();
  while (!r.done) {
    events.push(r.value);
    r = await gen.next();
  }
  return { events, ret: r.value };
}

describe('performAnalysis（注入 fake measure）', () => {
  it('分析音轨、写行、算作品响度、发 RESULTS', async () => {
    // analyzeWork 在调 openSource 前会查 config.rootFolders，需预置；path 不需真实存在（openSource 为注入的 fake）
    setConfigForTesting({
      ...getConfig(),
      rootFolders: [{ name: 'lib', path: '/tmp/kiku-analysis-test' }],
    });
    await upsertWork({
      id: WORK,
      rootFolder: 'lib',
      dir: 'd',
      title: 'T',
      circleName: 'C',
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.wav',
      title: 'a.wav',
      sizeBytes: 10,
      durationSec: 60,
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'b.wav',
      title: 'b.wav',
      sizeBytes: 10,
      durationSec: 60,
    });

    const fakeMeasure = async () => ({
      lufs: -18.5,
      truePeakDb: -1.2,
      curve: [-70, null, -18.5],
    });
    // folder 源走拼路径分支，measure 为 fake 不真读内容，空 memorySource 即可
    const fakeOpenSource = async () => memorySource({});
    const { events } = await collect(
      performAnalysis(getConfig(), new AbortController().signal, {
        workIds: [WORK],
        measure: fakeMeasure,
        openSource: fakeOpenSource,
      }),
    );

    const rows = await getTrackRows(WORK);
    expect(rows.every((r) => r.loudnessLufs === -18.5)).toBe(true);
    expect(rows.map((r) => JSON.parse(r.loudnessCurve ?? '[]'))).toEqual([
      [-70, null, -18.5],
      [-70, null, -18.5],
    ]);
    // Task 4 阶段 formatWork 尚未带响度字段（Task 6 才加），直接断言 t_work 行
    const [row] = await db
      .select({ lufs: works.loudnessLufs })
      .from(works)
      .where(eq(works.id, WORK));
    expect(row?.lufs).toBeCloseTo(-18.5, 5);
    expect(
      events.some((e) => (e as { type: string }).type === 'ANALYSIS_RESULTS'),
    ).toBe(true);
    expect(
      events.some((e) => (e as { type: string }).type === 'ANALYSIS_FINISHED'),
    ).toBe(true);
  });

  it('测量抛错 → 该轨 analyzeError，其余照常', async () => {
    setConfigForTesting({
      ...getConfig(),
      rootFolders: [{ name: 'lib', path: '/tmp/kiku-analysis-test' }],
    });
    await upsertWork({
      id: WORK,
      rootFolder: 'lib',
      dir: 'd',
      title: 'T',
      circleName: 'C',
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.wav',
      title: 'a.wav',
      sizeBytes: 10,
      durationSec: 60,
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'b.wav',
      title: 'b.wav',
      sizeBytes: 10,
      durationSec: 60,
    });

    const fakeMeasure = async () => {
      throw new Error('boom');
    };
    const fakeOpenSource = async () => memorySource({});
    await collect(
      performAnalysis(getConfig(), new AbortController().signal, {
        workIds: [WORK],
        measure: fakeMeasure,
        openSource: fakeOpenSource,
      }),
    );
    const rows = await getTrackRows(WORK);
    expect(rows.every((r) => r.analyzeError === 'boom')).toBe(true);
    expect(rows.every((r) => r.loudnessLufs === null)).toBe(true);
  });
});
