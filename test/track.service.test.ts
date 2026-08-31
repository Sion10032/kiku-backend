import { beforeEach, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import { db } from '../src/db/main/index.js';
import { tracks } from '../src/db/main/schema.js';
import {
  deleteTrackRows,
  getTrackRows,
  planTrackSync,
  upsertTrackRow,
} from '../src/services/track.service.js';
import { upsertWork } from '../src/services/work.service.js';
import { setupTestEnvironment } from './helpers/setup';

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
});
