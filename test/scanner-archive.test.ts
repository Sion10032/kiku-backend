import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// 网络隔离：先 mock 再动态 import 被测模块
mock.module('../src/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => ({
    title: `测试作品 ${rjCode}`,
    circle: '测试社团',
    nsfw: false,
    releaseDate: '2024-01-01',
    tags: [],
    vas: [],
    rateCountDetail: {},
    rank: {},
  }),
}));
mock.module('../src/services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { performScan } = await import('../src/filesystem/scanner.js');
const { db } = await import('../src/db/main/index.js');
const { works } = await import('../src/db/main/schema.js');
const { eq } = await import('drizzle-orm');
const { buildTar } = await import('./helpers/archive.js');
const { buildZip } = await import('./helpers/archive.js');

let root: string;
// 6 个连续 6 位 RJ 号（RJ 后必须恰好 6 或 8 位纯数字，不可加字母后缀）
const base = 100000 + Math.floor(Math.random() * 800000);
const ids = [0, 1, 2, 3, 4, 5].map((i) => `RJ${base + i}`) as [
  string,
  string,
  string,
  string,
  string,
  string,
];

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kiku-scan-'));
  // 1. 文件夹作品（嵌套一层：root/分类/RJ...）
  mkdirSync(join(root, '分類', ids[0]), { recursive: true });
  writeFileSync(join(root, '分類', ids[0], '01.mp3'), 'x');
  // 2. tar 作品（嵌套）
  writeFileSync(
    join(root, '分類', `${ids[1]}.tar`),
    buildTar([{ path: `${ids[1]}/01.mp3`, data: 'tar-audio' }]),
  );
  // 3. stored zip 作品（根层）
  writeFileSync(
    join(root, `${ids[2]}.zip`),
    buildZip([{ path: `${ids[2]}/01.mp3`, data: 'zip-audio' }]),
  );
  // 4. deflate zip → 应失败并提示重打包
  writeFileSync(
    join(root, `${ids[3]}.zip`),
    buildZip([{ path: 'a.mp3', data: 'x', method: 8 }]),
  );
  // 5. .7z → 应失败并提示重打包
  writeFileSync(join(root, `${ids[4]}.7z`), 'fake-7z-bytes');
  // 6. 无音频的作品包 → 忽略（不建任务）
  writeFileSync(
    join(root, `${ids[5]}.zip`),
    buildZip([{ path: 'readme.txt', data: 'no audio' }]),
  );
});
afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  for (const id of ids.slice(0, 3)) {
    await db.delete(works).where(eq(works.id, id));
  }
});

async function runScan() {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../src/config/index.js')).getConfig(),
      rootFolders: [{ name: 'scanroot', path: root }],
      scannerMaxRecursionDepth: 2,
    },
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

describe('performScan（压缩包作品）', () => {
  it('文件夹/tar/zip 入库，deflate 与 7z 进失败列表且提示重打包', async () => {
    const events = await runScan();
    const failedTasks = events
      .filter(
        (
          e,
        ): e is {
          type: 'SCAN_TASK';
          task: { title: string; status: string; error?: string };
        } =>
          (e as { type: string }).type === 'SCAN_TASK' &&
          (e as { task?: { status?: string } }).task?.status === 'failed',
      )
      .map((e) => e.task);
    expect(failedTasks.length).toBe(2);
    expect(failedTasks[0]?.error).toContain('7z a -mx=0');
    expect(failedTasks.map((t) => t.title).join()).toContain(ids[3]);
    expect(failedTasks.map((t) => t.title).join()).toContain(ids[4]);

    // 无音频作品只记日志，不产生任何任务事件
    const noAudioEvents = events.filter(
      (e) =>
        (e as { type: string }).type === 'SCAN_TASK' &&
        JSON.stringify(e).includes(ids[5]),
    );
    expect(noAudioEvents).toHaveLength(0);

    const w1 = (
      await db.select().from(works).where(eq(works.id, ids[0])).limit(1)
    )[0];
    const w2 = (
      await db.select().from(works).where(eq(works.id, ids[1])).limit(1)
    )[0];
    const w3 = (
      await db.select().from(works).where(eq(works.id, ids[2])).limit(1)
    )[0];
    expect(w1?.dir).toBe(`分類/${ids[0]}`); // 相对路径（修复嵌套 bug）
    expect(w2?.dir).toBe(`分類/${ids[1]}.tar`);
    expect(w3?.dir).toBe(`${ids[2]}.zip`);
    const w6 = (
      await db.select().from(works).where(eq(works.id, ids[5])).limit(1)
    )[0];
    expect(w6).toBeUndefined(); // 无音频 → 忽略
  });
});
