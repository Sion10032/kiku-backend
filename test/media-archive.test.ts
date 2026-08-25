import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/db/main/index.js');
const { circles, works } = await import('../src/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { setConfigForTesting, getConfig } = await import(
  '../src/config/index.js'
);
const { buildTar, buildZip } = await import('./helpers/archive.js');

const base = 200000 + Math.floor(Math.random() * 700000);
const TAR_ID = `RJ${base}`;
const ZIP_ID = `RJ${base + 1}`;
const audio = Buffer.alloc(4096, 0x7f);

let root: string;
let app: FastifyInstance;
let circleId: number;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-media-'));
  writeFileSync(
    join(root, `${TAR_ID}.tar`),
    buildTar([
      { path: `${TAR_ID}/01.mp3`, data: audio },
      { path: `${TAR_ID}/lyrics/01.lrc`, data: '[00:00.50]テスト' },
    ]),
  );
  writeFileSync(
    join(root, `${ZIP_ID}.zip`),
    buildZip([
      { path: `${ZIP_ID}/02.ogg`, data: audio },
      { path: `${ZIP_ID}/lyrics/02.lrc`, data: '[00:01.00]test' },
    ]),
  );
  setConfigForTesting({
    ...getConfig(),
    instanceMode: 'public',
    rootFolders: [{ name: 'media-root', path: root }],
  });
  app = await buildApp();
  await app.ready();
  const circle = await db
    .insert(circles)
    .values({ name: `媒体测试社团_${base}` })
    .returning();
  circleId = circle[0]?.id ?? 0;
  await db.insert(works).values([
    {
      id: TAR_ID,
      rootFolder: 'media-root',
      dir: `${TAR_ID}.tar`,
      title: 'tar 作品',
      circleId,
    },
    {
      id: ZIP_ID,
      rootFolder: 'media-root',
      dir: `${ZIP_ID}.zip`,
      title: 'zip 作品',
      circleId,
    },
  ]);
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, TAR_ID));
  await db.delete(works).where(eq(works.id, ZIP_ID));
  await db.delete(circles).where(eq(circles.id, circleId));
  await app.close();
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

describe('media 流式（tar/zip 作品）', () => {
  it('无 Range：200 + 完整字节', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/stream/${TAR_ID}/01.mp3`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['accept-ranges']).toBe('bytes');
    expect(res.rawPayload.equals(audio)).toBe(true);
  });

  it('Range：206 + 精确分片（zip）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/stream/${ZIP_ID}/02.ogg`,
      headers: { range: 'bytes=100-199' },
    });
    expect(res.statusCode).toBe(206);
    expect(res.headers['content-range']).toBe(`bytes 100-199/${audio.length}`);
    expect(res.rawPayload.equals(audio.subarray(100, 200))).toBe(true);
  });

  it('非法 Range → 416', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/stream/${TAR_ID}/01.mp3`,
      headers: { range: `bytes=${audio.length + 10}-` },
    });
    expect(res.statusCode).toBe(416);
  });

  it('穿越 hash → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/stream/${TAR_ID}/../${TAR_ID}.tar`,
    });
    expect(res.statusCode).toBe(404);
  });

  it('check-lrc 读取包内歌词', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/check-lrc/${TAR_ID}/01.mp3`,
    });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.hasLrc).toBe(true);
    expect(body.type).toBe('lrc');
    expect(body.text).toContain('テスト');
  });

  it('download：200 + attachment + 完整字节', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/download/${ZIP_ID}/02.ogg`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain('attachment');
    expect(res.rawPayload.equals(audio)).toBe(true);
  });

  it('tracks：返回包内树（顶层包装目录已剥离）', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/tracks/${ZIP_ID}`,
    });
    expect(res.statusCode).toBe(200);
    const tree = res.json();
    expect(tree.map((n: { type: string }) => n.type)).toEqual([
      'folder',
      'audio',
    ]);
    expect(tree[0]?.title).toBe('lyrics');
  });
});
