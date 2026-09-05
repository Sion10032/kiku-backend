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

setupTestEnvironment();

// 网络隔离：mock DLsite 抓取与封面下载（对齐 scanner-update.test.ts）
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => ({
    title: `刷新后标题 ${rjCode}`,
    circle: '单作品运维测试社团',
    ageRating: 'all' as const,
    releaseDate: '2024-03-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: {},
  }),
}));
mock.module('../services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { refreshWorkMetadata, syncWorkDurations } = await import('./workOps.js');
const { db } = await import('../infra/db/main/index.js');
const { circles, works } = await import('../infra/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { getConfig, setConfigForTesting } = await import(
  '../infra/config/index.js'
);
const { getTrackRows } = await import('../services/track.service.js');
const { upsertWork } = await import('../services/work.service.js');

const ROOT_FOLDER = 'workops-root';
const sine = readFileSync(
  join(import.meta.dir, '../../test/fixtures/audio/sine.wav'),
);
const base = 320000 + Math.floor(Math.random() * 600000);
const ID = `RJ${base}`;
const CIRCLE = '单作品运维测试社团';

let root: string;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-workops-'));
  mkdirSync(join(root, ID), { recursive: true });
  writeFileSync(join(root, ID, 'sine.wav'), sine);

  setConfigForTesting({
    ...getConfig(),
    rootFolders: [{ name: ROOT_FOLDER, path: root }],
  });

  const seeded = await upsertWork({
    id: ID,
    rootFolder: ROOT_FOLDER,
    dir: ID,
    title: '刷新前标题',
    circleName: CIRCLE,
  });
  expect(seeded.success).toBe(true);
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, ID));
  // 同进程其他测试文件遗留的行也可能指向本测试社团；按 circleId 一并清引用后再删
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

describe('refreshWorkMetadata', () => {
  it('重抓元数据更新标题，并回填音轨时长', async () => {
    const result = await refreshWorkMetadata(ID, getConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.title).toBe(`刷新后标题 ${ID}`);
    expect(result.tracks.added).toBe(1);

    const rows = await getTrackRows(ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.mediaIndex).toBe('sine.wav');
    expect(rows[0]?.durationSec ?? 0).toBeGreaterThan(0.7);
  });

  it('作品不存在 → work-not-found', async () => {
    const result = await refreshWorkMetadata('RJ99999999', getConfig());
    expect(result).toEqual({ ok: false, reason: 'work-not-found' });
  });

  it('rootFolder 未配置 → root-folder-not-found', async () => {
    setConfigForTesting({ ...getConfig(), rootFolders: [] });
    try {
      const result = await syncWorkDurations(ID, getConfig());
      expect(result).toEqual({ ok: false, reason: 'root-folder-not-found' });
    } finally {
      setConfigForTesting({
        ...getConfig(),
        rootFolders: [{ name: ROOT_FOLDER, path: root }],
      });
    }
  });
});

describe('syncWorkDurations', () => {
  it('size 未变 → diff 零动作，无重复行', async () => {
    const result = await syncWorkDurations(ID, getConfig());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.tracks).toEqual({ added: 0, updated: 0, removed: 0 });

    const rows = await getTrackRows(ID);
    expect(rows).toHaveLength(1);
  });
});
