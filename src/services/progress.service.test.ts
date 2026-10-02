import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ensureRootFolder, removeRootFolder } from '@test/helpers/rootFolder';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import {
  circles,
  tracks,
  userProgress,
  users,
  works,
} from '../infra/db/main/schema.js';
import { getProgressByWorks } from './progress.service.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const USER = `progress-test-${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG96${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;
// 五个作品分别覆盖：正常聚合 / 总时长未知 / clamp / 最新行已听完 / 孤儿进度行
const WORK_A = `RJA${RUN}`;
const WORK_B = `RJB${RUN}`;
const WORK_C = `RJC${RUN}`;
const WORK_D = `RJD${RUN}`;
const WORK_E = `RJE${RUN}`;

/** 插入一个作品的音轨（mediaIndex → durationSec，null = 时长未知）。 */
async function insertTracks(
  workId: string,
  durations: (number | null)[],
): Promise<void> {
  await db.insert(tracks).values(
    durations.map((durationSec, i) => ({
      workId,
      mediaIndex: `${workId}/track${i + 1}.mp3`,
      title: `track${i + 1}`,
      durationSec,
      sizeBytes: 1000,
    })),
  );
}

/** 插入一条进度行（updatedAt 递增保证 "最新行" 判定稳定）。 */
async function insertProgress(
  workId: string,
  trackNo: number,
  position: number,
  duration: number | null,
  seq: number,
): Promise<void> {
  await db.insert(userProgress).values({
    userName: USER,
    workId,
    mediaIndex: `${workId}/track${trackNo}.mp3`,
    position,
    duration,
    updatedAt: new Date(2026, 0, 1, 0, 0, seq).toISOString(),
  });
}

describe('getProgressByWorks 的整体进度百分比 progressPercent', () => {
  beforeAll(async () => {
    await db.insert(users).values({ name: USER, password: 'x', group: 'user' });
    await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `progress 测试社团_${RUN}` });
    await ensureRootFolder('test');
    await db.insert(works).values(
      [WORK_A, WORK_B, WORK_C, WORK_D, WORK_E].map((id) => ({
        id,
        rootFolder: 'test',
        dir: `test/${id}`,
        title: `progress 测试作品 ${id}`,
        circleId: CIRCLE_ID,
      })),
    );

    // A：三轨各 600s（总 1800s）；t1 听完、t2 听到一半（最新行）→ (600+300)/1800 = 50%
    await insertTracks(WORK_A, [600, 600, 600]);
    await insertProgress(WORK_A, 1, 600, 600, 1);
    await insertProgress(WORK_A, 2, 300, 600, 2);

    // B：全部音轨时长未知（总 0）→ progressPercent 为 null，其余字段照常
    await insertTracks(WORK_B, [null, null]);
    await insertProgress(WORK_B, 1, 30, null, 1);

    // C：单轨 100s，最新行 position 超出（200）→ clamp 100
    await insertTracks(WORK_C, [100]);
    await insertProgress(WORK_C, 1, 200, 100, 1);

    // D：两轨各 600s；t1 未听完（300/600），最新行 t2 已听完（570/600 = 0.95）
    // 最新行按实际 position 计 → (570)/1200 = 47.5 → round 48（若按整轨 600 计会得 50）
    await insertTracks(WORK_D, [600, 600]);
    await insertProgress(WORK_D, 1, 300, 600, 1);
    await insertProgress(WORK_D, 2, 570, 600, 2);

    // E：单轨 600s；孤儿进度行（mediaIndex 不在 tracks，如扫描后改名/删轨）
    // 比例 1.0 但须被跳过；最新行 t1 实际 position 300 → 300/600 = 50%
    // （若孤儿被按整轨计入 → (600+300)/600 clamp 100，可区分）
    await insertTracks(WORK_E, [600]);
    await db.insert(userProgress).values({
      userName: USER,
      workId: WORK_E,
      mediaIndex: `${WORK_E}/gone.mp3`,
      position: 600,
      duration: 600,
      updatedAt: new Date(2026, 0, 1, 0, 0, 1).toISOString(),
    });
    await insertProgress(WORK_E, 1, 300, 600, 2);
  });

  afterAll(async () => {
    // 先删子表行（works 级联清 tracks/userProgress；rootFolder ON DELETE restrict）
    await db.delete(users).where(eq(users.name, USER));
    await db
      .delete(works)
      .where(inArray(works.id, [WORK_A, WORK_B, WORK_C, WORK_D, WORK_E]));
    await db.delete(circles).where(eq(circles.id, CIRCLE_ID));
    await removeRootFolder('test');
  });

  it('A：已听秒数（除最新行外的听完轨 + 最新行 position）÷ 总时长 → 50%', async () => {
    const map = await getProgressByWorks(USER, [WORK_A]);
    const summary = map.get(WORK_A);
    expect(summary).toBeDefined();
    expect(summary?.progressPercent).toBe(50);
    // 既有口径不受影响：最新行与听完轨数照常
    expect(summary?.mediaIndex).toBe(`${WORK_A}/track2.mp3`);
    expect(summary?.position).toBe(300);
    expect(summary?.listenedCount).toBe(1);
  });

  it('B：全部音轨时长未知 → progressPercent 为 null', async () => {
    const map = await getProgressByWorks(USER, [WORK_B]);
    const summary = map.get(WORK_B);
    expect(summary).toBeDefined();
    expect(summary?.progressPercent).toBeNull();
  });

  it('C：position 超出总时长 → clamp 到 100', async () => {
    const map = await getProgressByWorks(USER, [WORK_C]);
    expect(map.get(WORK_C)?.progressPercent).toBe(100);
  });

  it('D：最新行本身听完 → 按实际 position 计而非整轨 → 48%', async () => {
    const map = await getProgressByWorks(USER, [WORK_D]);
    expect(map.get(WORK_D)?.progressPercent).toBe(48);
  });

  it('E：孤儿进度行（mediaIndex 不在 tracks）不计入分子 → 50%', async () => {
    const map = await getProgressByWorks(USER, [WORK_E]);
    const summary = map.get(WORK_E);
    expect(summary?.progressPercent).toBe(50);
    expect(summary?.mediaIndex).toBe(`${WORK_E}/track1.mp3`);
  });

  it('一次传多个 workId 批量聚合互不串扰', async () => {
    const map = await getProgressByWorks(USER, [WORK_A, WORK_C]);
    expect(map.get(WORK_A)?.progressPercent).toBe(50);
    expect(map.get(WORK_C)?.progressPercent).toBe(100);
  });
});
