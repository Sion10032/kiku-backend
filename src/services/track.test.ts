import { beforeEach, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { tracks } from '../infra/db/main/schema.js';
import {
  computeWorkLoudness,
  deleteTrackRows,
  getPendingAnalysisWorkIds,
  getTotalDurations,
  getTrackRows,
  planTrackSync,
  setTrackLoudness,
  upsertTrackRow,
} from './track.service.js';
import { upsertWork } from './work.service.js';

setupTestEnvironment();

const WORK = 'RJ00000001';

async function seedWork(): Promise<void> {
  const r = await upsertWork({
    id: WORK,
    rootFolder: 'lib',
    dir: 'RJ00000001',
    title: 'T',
    circleName: 'C',
    tags: [],
    vas: [],
  });
  expect(r.success).toBe(true);
}

describe('planTrackSync（纯函数）', () => {
  it('新增/大小变更/消失 三分类，未变更不计', () => {
    const plan = planTrackSync(
      [
        { mediaIndex: 'a.mp3', title: 'a.mp3', sizeBytes: 100 },
        { mediaIndex: 'b.mp3', title: 'b.mp3', sizeBytes: 200 }, // 变更
        { mediaIndex: 'c.mp3', title: 'c.mp3', sizeBytes: 300 }, // 新增
      ],
      [
        { mediaIndex: 'a.mp3', sizeBytes: 100 },
        { mediaIndex: 'b.mp3', sizeBytes: 999 },
        { mediaIndex: 'gone.mp3', sizeBytes: 1 },
      ],
    );
    expect(plan.toUpsert.map((t) => t.mediaIndex)).toEqual(['b.mp3', 'c.mp3']);
    expect(plan.toUpsert[0]?.revalidate).toBe(true); // size 变化（姊妹计划据此失效响度）
    expect(plan.toUpsert[1]?.revalidate).toBe(false); // 新增
    expect(plan.toDelete).toEqual(['gone.mp3']);
    expect(plan.unchanged).toBe(1);
  });
});

describe('track.service（DB）', () => {
  beforeEach(async () => {
    // preload 仅隔离进程（临时库单例），用例间需自行清残留音轨行
    await db.delete(tracks).where(eq(tracks.workId, WORK));
    await seedWork();
  });

  it('upsert 插入后更新同键行', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a.mp3',
      sizeBytes: 100,
      durationSec: 12.5,
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a.mp3',
      sizeBytes: 200,
      durationSec: 13,
    });
    const rows = await getTrackRows(WORK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.sizeBytes).toBe(200);
    expect(rows[0]?.durationSec).toBe(13);
  });

  it('deleteTrackRows 删除指定行', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'x.mp3',
      title: 'x.mp3',
      sizeBytes: 1,
      durationSec: 1,
    });
    await deleteTrackRows(WORK, ['x.mp3']);
    expect(await getTrackRows(WORK)).toEqual([]);
  });

  it('upsert + resetLoudness 清空响度与曲线', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a.mp3',
      sizeBytes: 100,
      durationSec: 12.5,
    });
    await setTrackLoudness(WORK, 'a.mp3', {
      lufs: -18.2,
      truePeakDb: -1.5,
      curve: [-70, null, -18.4],
    });
    await upsertTrackRow(
      {
        workId: WORK,
        mediaIndex: 'a.mp3',
        title: 'a.mp3',
        sizeBytes: 200,
        durationSec: 13,
      },
      { resetLoudness: true },
    );
    const rows = await getTrackRows(WORK);
    expect(rows[0]?.sizeBytes).toBe(200);
    expect(rows[0]?.loudnessLufs).toBeNull();
    expect(rows[0]?.loudnessCurve).toBeNull();
  });

  it('setTrackLoudness 记录错误分支', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'e.mp3',
      title: 'e.mp3',
      sizeBytes: 1,
      durationSec: null,
    });
    await setTrackLoudness(WORK, 'e.mp3', { error: 'boom' });
    expect((await getTrackRows(WORK))[0]?.analyzeError).toBe('boom');
  });

  it('setTrackLoudness 存曲线（JSON 序列化，空段 null）', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'c.mp3',
      title: 'c.mp3',
      sizeBytes: 1,
      durationSec: 10,
    });
    await setTrackLoudness(WORK, 'c.mp3', {
      lufs: -19,
      truePeakDb: -2,
      curve: [-70, null, -19.3],
    });
    expect(
      JSON.parse((await getTrackRows(WORK))[0]?.loudnessCurve ?? '[]'),
    ).toEqual([-70, null, -19.3]);
  });

  it('computeWorkLoudness 按时长加权 + true peak 取最大', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a.mp3',
      sizeBytes: 1,
      durationSec: 100,
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'b.mp3',
      title: 'b.mp3',
      sizeBytes: 1,
      durationSec: 300,
    });
    await setTrackLoudness(WORK, 'a.mp3', { lufs: -20, truePeakDb: -2 });
    await setTrackLoudness(WORK, 'b.mp3', { lufs: -16, truePeakDb: -0.5 });
    const w = await computeWorkLoudness(WORK);
    // (100×-20 + 300×-16)/400 = -17
    expect(w?.lufs).toBeCloseTo(-17, 5);
    expect(w?.truePeakDb).toBeCloseTo(-0.5, 5);
    expect(await getPendingAnalysisWorkIds()).toEqual([]);
  });

  it('待分析作品 = 存在未分析音轨的作品', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'x.mp3',
      title: 'x.mp3',
      sizeBytes: 1,
      durationSec: 1,
    });
    expect(await getPendingAnalysisWorkIds()).toEqual([WORK]);
  });
});

describe('getTotalDurations（批量聚合总时长）', () => {
  const OTHER = 'RJ00000002';

  beforeEach(async () => {
    // 用例间自行清残留音轨行（preload 仅隔离进程）
    await db.delete(tracks).where(eq(tracks.workId, WORK));
    await db.delete(tracks).where(eq(tracks.workId, OTHER));
    await seedWork();
    const r = await upsertWork({
      id: OTHER,
      rootFolder: 'lib',
      dir: 'RJ00000002',
      title: 'T2',
      circleName: 'C',
      tags: [],
      vas: [],
    });
    expect(r.success).toBe(true);
  });

  it('SUM 忽略 null：部分音轨探测失败时返回已知部分和', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: 100.5,
    });
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'b.mp3',
      title: 'b',
      sizeBytes: 1,
      durationSec: null,
    });
    const map = await getTotalDurations([WORK]);
    expect(map.get(WORK)).toBe(100.5);
  });

  it('全部音轨时长未知 → null（Map 含键）', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: null,
    });
    const map = await getTotalDurations([WORK]);
    expect(map.has(WORK)).toBe(true);
    expect(map.get(WORK)).toBeNull();
  });

  it('无音轨行 → null（Map 含键）', async () => {
    const map = await getTotalDurations([WORK]);
    expect(map.has(WORK)).toBe(true);
    expect(map.get(WORK)).toBeNull();
  });

  it('批量多作品互不串扰', async () => {
    await upsertTrackRow({
      workId: WORK,
      mediaIndex: 'a.mp3',
      title: 'a',
      sizeBytes: 1,
      durationSec: 60,
    });
    await upsertTrackRow({
      workId: OTHER,
      mediaIndex: 'x.mp3',
      title: 'x',
      sizeBytes: 1,
      durationSec: 30,
    });
    await upsertTrackRow({
      workId: OTHER,
      mediaIndex: 'y.mp3',
      title: 'y',
      sizeBytes: 1,
      durationSec: 45,
    });
    const map = await getTotalDurations([WORK, OTHER]);
    expect(map.get(WORK)).toBe(60);
    expect(map.get(OTHER)).toBe(75);
  });

  it('空入参 → 空 Map，不发查询', async () => {
    const map = await getTotalDurations([]);
    expect(map.size).toBe(0);
  });
});
