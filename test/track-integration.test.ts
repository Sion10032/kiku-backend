import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/infra/db/main/index.js');
const { circles, works } = await import('../src/infra/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { setConfigForTesting, getConfig } = await import(
  '../src/infra/config/index.js'
);
const { openWorkSource } = await import('../src/infra/fs/source/index.js');
const { syncWorkTracks } = await import('../src/scanner/trackSync.js');
const { upsertWork } = await import('../src/services/work.service.js');

const WORK = 'RJ00000004';
const ROOT_FOLDER = 'track-root';
const sine = readFileSync(join(import.meta.dir, 'fixtures/audio/sine.wav'));
// 非音频字节 → 探测失败 → durationSec=null（轨仍须出现在响应中）
const bad = Buffer.from('not an audio file');

let root: string;
let app: FastifyInstance;

interface TrackNodeJson {
  type: string;
  title: string;
  hash?: string;
  durationSec?: number | null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-tracks-'));
  mkdirSync(join(root, WORK), { recursive: true });
  writeFileSync(join(root, WORK, 'sine.wav'), sine);
  writeFileSync(join(root, WORK, 'bad.mp3'), bad);

  setConfigForTesting({
    ...getConfig(),
    instanceMode: 'public',
    rootFolders: [{ name: ROOT_FOLDER, path: root }],
  });
  app = await buildApp();
  await app.ready();

  // 播种：作品记录（upsertWork）→ 音轨行（syncWorkTracks）
  const seeded = await upsertWork({
    id: WORK,
    rootFolder: ROOT_FOLDER,
    dir: WORK,
    title: '时长集成测试作品',
    circleName: '时长测试社团',
  });
  expect(seeded.success).toBe(true);

  const source = await openWorkSource(root, WORK);
  const sync = await syncWorkTracks(WORK, source, await source.buildTree());
  expect(sync.added).toBe(2); // sine.wav + bad.mp3
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK));
  const circle = await db.query.circles.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, '时长测试社团') },
  });
  if (circle) await db.delete(circles).where(eq(circles.id, circle.id));
  await app.close();
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

async function getTracks(): Promise<TrackNodeJson[]> {
  const res = await app.inject({ method: 'GET', url: `/api/tracks/${WORK}` });
  expect(res.statusCode).toBe(200);
  return res.json() as TrackNodeJson[];
}

describe('GET /api/tracks/:id 附带 durationSec', () => {
  it('tracks 带 durationSec', async () => {
    const tracks = await getTracks();
    expect(JSON.stringify(tracks)).toContain('"durationSec"');

    const sineNode = tracks.find((n) => n.hash === 'sine.wav');
    expect(sineNode?.type).toBe('audio');
    expect(typeof sineNode?.durationSec).toBe('number');
    expect(sineNode?.durationSec).toBeCloseTo(0.8, 2);
  });

  it('解析失败轨 durationSec=null 也出现在响应中', async () => {
    const tracks = await getTracks();
    const badNode = tracks.find((n) => n.hash === 'bad.mp3');
    expect(badNode).not.toBeUndefined();
    expect(badNode?.type).toBe('audio');
    expect('durationSec' in (badNode ?? {})).toBe(true);
    expect(badNode?.durationSec).toBeNull();
  });
});
