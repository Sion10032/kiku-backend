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
const { upsertWork } = await import('../src/services/work.service.js');

const WORK = 'RJ00000042';
const ROOT_FOLDER = 'download-filename-root';
const CIRCLE = '下载文件名测试社团';
// 真实的 DLsite 作品文件名基本都是日文
const FILE = '01 日本語のタイトル.mp3';
const audio = Buffer.alloc(1024, 0x7f);

let root: string;
let app: FastifyInstance;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-download-name-'));
  mkdirSync(join(root, WORK, 'sub'), { recursive: true });
  writeFileSync(join(root, WORK, FILE), audio);
  writeFileSync(join(root, WORK, 'sub', FILE), audio);
  await ensureRootFolder(ROOT_FOLDER, root);
  setConfigForTesting({ ...getConfig(), instanceMode: 'public' });
  app = await buildApp();
  await app.ready();

  const seeded = await upsertWork({
    id: WORK,
    rootFolder: ROOT_FOLDER,
    dir: WORK,
    title: '下载文件名测试作品',
    circleName: CIRCLE,
  });
  expect(seeded.success).toBe(true);
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK));
  await db.query.circles
    .findFirst({
      where: { RAW: (t, op) => op.eq(t.name, CIRCLE) },
    })
    .then((c) => {
      if (c) return db.delete(circles).where(eq(circles.id, c.id));
    });
  await removeRootFolder(ROOT_FOLDER);
  await app.close();
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

describe('GET /api/media/download 文件名', () => {
  it('非 ASCII 文件名不再 500，两个参数都是百分号编码', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/download/${WORK}/${encodeURIComponent(FILE)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.rawPayload.equals(audio)).toBe(true);

    const disposition = res.headers['content-disposition'] as string;
    expect(disposition).toContain('attachment');
    // 值必须是纯 ASCII，否则 Node 会在写响应头时抛 ERR_INVALID_CHAR
    const fallbackName = /filename="([^"]*)"/.exec(disposition)?.[1] ?? '';
    expect(fallbackName).toMatch(/^[\x20-\x7e]*$/);
    // filename= 也带 %E6%97%A5 这样的 UTF-8 百分号编码（非下划线占位）
    expect(fallbackName).toContain('%E6%97%A5');
    // 原名通过 filename* 以 UTF-8 百分号编码传递
    expect(disposition).toContain(
      `filename*=UTF-8''${encodeURIComponent(FILE)}`,
    );
  });

  it('子目录路径只取文件名部分', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/media/download/${WORK}/${encodeURIComponent(`sub/${FILE}`)}`,
    });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-disposition']).toContain(
      `filename*=UTF-8''${encodeURIComponent(FILE)}`,
    );
  });
});
