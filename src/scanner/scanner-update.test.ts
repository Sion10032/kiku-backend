import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnvironment } from '@test/helpers/setup';
import type { ScanEvent } from './scanner.js';

setupTestEnvironment();

// 网络隔离：先 mock 再动态 import 被测模块
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => ({
    title: `测试作品 ${rjCode}`,
    circle: '回填测试社团',
    ageRating: 'all' as const,
    releaseDate: '2024-01-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: [],
  }),
}));
mock.module('../services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { performScan, performUpdate } = await import('./scanner.js');
const { db } = await import('../infra/db/main/index.js');
const { circles, works } = await import('../infra/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { getConfig, setConfigForTesting } = await import(
  '../infra/config/index.js'
);
const { getTrackRows } = await import('../services/track.service.js');
const { upsertWork } = await import('../services/work.service.js');

const ROOT_FOLDER = 'update-root';
const sine = readFileSync(
  join(import.meta.dir, '../../test/fixtures/audio/sine.wav'),
);

// RJ 后必须恰好 6 或 8 位纯数字
const base = 300000 + Math.floor(Math.random() * 600000);
const ID = `RJ${base}`;
/** 不入库的新作品：验证 scan 不触发音轨同步、update 统一补齐 */
const ID2 = `RJ${base + 1}`;
const CIRCLE = '回填测试社团';

let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-update-'));
  mkdirSync(join(root, ID), { recursive: true });
  writeFileSync(join(root, ID, 'sine.wav'), sine);
  // 不入库的新作品目录：磁盘上存在，DB 中无行
  mkdirSync(join(root, ID2), { recursive: true });
  writeFileSync(join(root, ID2, 'sine.wav'), sine);

  setConfigForTesting({
    ...getConfig(),
    rootFolders: [{ name: ROOT_FOLDER, path: root }],
  });

  // 播种：已入库作品行（update 模式的回填对象）
  const seeded = await upsertWork({
    id: ID,
    rootFolder: ROOT_FOLDER,
    dir: ID,
    title: 'update 回填测试作品',
    circleName: CIRCLE,
  });
  expect(seeded.success).toBe(true);
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, ID));
  await db.delete(works).where(eq(works.id, ID2));
  // performUpdate 遍历全库作品（getAllWorkRefs），同进程其他测试文件遗留的行
  // 也会被 upsert 指向本测试的 circle；按 circleId 一并清引用后再删 circle，
  // 避免外键约束失败
  const circle = await db.query.circles.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, CIRCLE) },
  });
  if (circle) {
    await db.delete(works).where(eq(works.circleId, circle.id));
    await db.delete(circles).where(eq(circles.id, circle.id));
  }
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

async function runUpdate(): Promise<unknown[]> {
  const events: unknown[] = [];
  for await (const ev of performUpdate(
    getConfig(),
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

describe('performUpdate（音轨回填）', () => {
  it('已入库作品回填音轨时长；重复执行零动作；删除音频后清理', async () => {
    // 首轮：回填 sine.wav 时长
    await runUpdate();
    let rows = await getTrackRows(ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaIndex).toBe('sine.wav');
    expect(rows[0]?.durationSec ?? 0).toBeGreaterThan(0.7);

    // 再次执行：size 未变 → 零动作，不产生重复行
    await runUpdate();
    rows = await getTrackRows(ID);
    expect(rows).toHaveLength(1);

    // 音频文件消失 → update 模式 diff 语义清理行
    rmSync(join(root, ID, 'sine.wav'));
    await runUpdate();
    rows = await getTrackRows(ID);
    expect(rows).toHaveLength(0);
  });

  it('scan 不触发音轨同步；update metadata 统一补齐（含新作品）', async () => {
    // scan：新作品目录被完整扫描入库，但不写音轨行
    const scanEvents: ScanEvent[] = [];
    for await (const ev of performScan(
      getConfig(),
      new AbortController().signal,
    )) {
      scanEvents.push(ev);
    }
    const newWorkTask = scanEvents.find(
      (ev) =>
        ev.type === 'SCAN_TASK' &&
        ev.task.title.startsWith(ID2) &&
        ev.task.status === 'completed',
    );
    expect(newWorkTask).toBeDefined();
    expect(await getTrackRows(ID2)).toHaveLength(0);

    // update metadata：全库遍历统一补齐（含 scan 新入库作品）
    await runUpdate();
    const rows = await getTrackRows(ID2);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaIndex).toBe('sine.wav');
    expect(rows[0]?.durationSec ?? 0).toBeGreaterThan(0.7);
  });
});
