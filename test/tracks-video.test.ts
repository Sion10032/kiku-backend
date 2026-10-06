import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { ensureRootFolder, removeRootFolder } from './helpers/rootFolder.js';
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

// 纯视频作品：目录内无任何音频文件，仅 .mp4/.mkv
const WORK = 'RJ00000005';
const ROOT_FOLDER = 'video-root';

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-video-tracks-'));
  mkdirSync(join(root, WORK), { recursive: true });
  // 字节内容无关紧要：树分类只看扩展名
  writeFileSync(join(root, WORK, 'clip.mp4'), Buffer.from('fake mp4 bytes'));
  writeFileSync(join(root, WORK, 'movie.mkv'), Buffer.from('fake mkv bytes'));

  await ensureRootFolder(ROOT_FOLDER, root);
  setConfigForTesting({
    ...getConfig(),
    instanceMode: 'public',
  });
  app = await buildApp();
  await app.ready();

  const seeded = await upsertWork({
    id: WORK,
    rootFolder: ROOT_FOLDER,
    dir: WORK,
    title: '视频树测试作品',
    circleName: '视频树测试社团',
  });
  expect(seeded.success).toBe(true);

  const source = await openWorkSource(root, WORK);
  await syncWorkTracks(WORK, source, await source.buildTree());
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK));
  await db.query.circles
    .findFirst({
      where: (t, op) => op.eq(t.name, '视频树测试社团'),
    })
    .then((c) => {
      if (c) return db.delete(circles).where(eq(circles.id, c.id));
    });
  await removeRootFolder(ROOT_FOLDER);
  await app.close();
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

describe('GET /api/tracks/:id 含视频叶子', () => {
  it('video 叶子出现在响应中（响应 schema 接受 video）', async () => {
    const res = await app.inject({ method: 'GET', url: `/api/tracks/${WORK}` });
    expect(res.statusCode).toBe(200);
    const tracks = res.json() as Array<{ type: string; hash?: string }>;
    expect(tracks.find((n) => n.hash === 'clip.mp4')?.type).toBe('video');
    expect(tracks.find((n) => n.hash === 'movie.mkv')?.type).toBe('video');
  });
});
