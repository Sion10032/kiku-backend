import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expectNotNull } from '@test/helpers/assert';
import { setupTestEnvironment } from '@test/helpers/setup';

setupTestEnvironment();

// 拦截 globalThis.fetch 避免真实网络：cover.service 走真实的 retryFetch
// （顺带覆盖 retryFetch 与 cover.service 的集成）。不使用 mock.module：
// 模块注册表污染会波及同进程其他测试文件（如 client-retry.test.ts）。
const fakeBytes = Buffer.from([0xff, 0xd8, 0xff, 0xe0]);
const fetchMock = mock(
  async (_url: string) =>
    new Response(fakeBytes, {
      headers: { 'content-type': 'image/jpeg' },
    }),
);
const realFetch = globalThis.fetch;

// 动态 import：确保 setupTestEnvironment（CONFIG_PATH）先生效
const {
  downloadCover,
  coverExists,
  getCoverData,
  deleteAllCovers,
  importLocalCover,
  existingCoverTypes,
} = await import('./cover.service');
const { deleteBlob, putBlob } = await import('../infra/db/blob/index');

describe('cover.service（blob.db 存储）', () => {
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockClear();
    // 用例间隔离：清掉测试用 key
    for (const t of ['main', 'sam', '240x240', '360x360']) {
      deleteBlob('cover', `RJ000007_${t}`);
    }
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('下载后存入 blob 库，key 直接使用作品ID', async () => {
    const ok = await downloadCover('RJ000007', 'main');
    expect(ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(1);

    expect(coverExists('RJ000007', 'main')).toBe(true);
    const got = getCoverData('RJ000007', 'main');
    expectNotNull(got);
    expect(got.data.equals(fakeBytes)).toBe(true);
    expect(got.mimeType).toBe('image/jpeg');
    expect(got.size).toBe(4);
  });

  it('已存在时跳过下载', async () => {
    await downloadCover('RJ000007', 'main');
    fetchMock.mockClear();

    expect(await downloadCover('RJ000007', 'main')).toBe(true);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('sourceId 用于下载 URL，存储仍用 id 的 key', async () => {
    const ok = await downloadCover('RJ000008', 'main', undefined, 'RJ123456');
    expect(ok).toBe(true);
    // URL 由 sourceId 构建
    const firstUrl = fetchMock.mock.calls[0]?.[0];
    expectNotNull(firstUrl);
    expect(firstUrl).toContain('RJ123456');
    expect(coverExists('RJ000008', 'main')).toBe(true);
    deleteBlob('cover', 'RJ000008_main');
  });

  it('非图片 content-type 拒绝存储', async () => {
    fetchMock.mockImplementationOnce(
      async () =>
        new Response('<html>', {
          headers: { 'content-type': 'text/html' },
        }),
    );

    expect(await downloadCover('RJ000007', 'sam')).toBe(false);
    expect(coverExists('RJ000007', 'sam')).toBe(false);
  });

  it('deleteAllCovers 删除全部四种类型', async () => {
    await downloadCover('RJ000007', 'main');
    const count = deleteAllCovers('RJ000007');
    expect(count).toBeGreaterThanOrEqual(1);
    expect(coverExists('RJ000007', 'main')).toBe(false);
  });

  it('VJ 号封面走 professional 路径，分组号带 VJ 前缀', async () => {
    const ok = await downloadCover('VJ01003042', 'main');
    expect(ok).toBe(true);
    const url = fetchMock.mock.calls[0]?.[0];
    expectNotNull(url);
    expect(url).toContain(
      'work/professional/VJ01004000/VJ01003042_img_main.jpg',
    );
    expect(coverExists('VJ01003042', 'main')).toBe(true);
    deleteBlob('cover', 'VJ01003042_main');
  });
});

describe('importLocalCover（手动作品本地封面导入）', () => {
  // 每个 case 独立 tmp 目录，测试结束后清理
  const tmpDirs: string[] = [];

  async function makeWorkDir(files: Record<string, Buffer>): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), 'kiku-cover-test-'));
    tmpDirs.push(dir);
    for (const [name, data] of Object.entries(files)) {
      await writeFile(join(dir, name), data);
    }
    return dir;
  }

  afterEach(async () => {
    await Promise.all(
      tmpDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })),
    );
  });

  it('命中 cover.jpg：返回 true 且 blob 库可读（mime 为 image/jpeg）', async () => {
    const jpg = Buffer.from([0xff, 0xd8, 0xff, 0xdb, 0x01, 0x02]);
    const dir = await makeWorkDir({ 'cover.jpg': jpg });

    expect(await importLocalCover('UW00000001', dir)).toBe(true);

    const got = getCoverData('UW00000001', 'main');
    expectNotNull(got);
    expect(got.data.equals(jpg)).toBe(true);
    expect(got.mimeType).toBe('image/jpeg');
    deleteBlob('cover', 'UW00000001_main');
  });

  it('大小写不敏感：Cover.PNG 命中', async () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const dir = await makeWorkDir({ 'Cover.PNG': png });

    expect(await importLocalCover('UW00000002', dir)).toBe(true);

    const got = getCoverData('UW00000002', 'main');
    expectNotNull(got);
    expect(got.data.equals(png)).toBe(true);
    expect(got.mimeType).toBe('image/png');
    deleteBlob('cover', 'UW00000002_main');
  });

  it('目录里没有图片：返回 false', async () => {
    const dir = await makeWorkDir({ 'readme.txt': Buffer.from('hi') });

    expect(await importLocalCover('UW00000003', dir)).toBe(false);
    expect(coverExists('UW00000003', 'main')).toBe(false);
  });

  it('blob 已存在：短路返回 true，不重新读取文件', async () => {
    const existing = Buffer.from([0xaa, 0xbb]);
    putBlob('cover', 'UW00000004_main', existing, 'image/webp');
    const dir = await makeWorkDir({
      'cover.jpg': Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    });

    expect(await importLocalCover('UW00000004', dir)).toBe(true);

    // 内容未被覆盖，说明走了短路分支
    const got = getCoverData('UW00000004', 'main');
    expectNotNull(got);
    expect(got.data.equals(existing)).toBe(true);
    expect(got.mimeType).toBe('image/webp');
    deleteBlob('cover', 'UW00000004_main');
  });
});

describe('existingCoverTypes（单作品多类型一次查询）', () => {
  it('返回实际存在的类型集合；未命中类型不在集内', () => {
    putBlob('cover', 'RJ000012_main', Buffer.from('a'), 'image/jpeg');
    try {
      const existing = existingCoverTypes('RJ000012', [
        'main',
        'sam',
        '240x240',
      ]);
      expect(existing).toEqual(new Set(['main']));
    } finally {
      deleteBlob('cover', 'RJ000012_main');
    }
  });

  it('全部未命中 → 空 Set', () => {
    expect(existingCoverTypes('RJ000013', ['main', 'sam'])).toEqual(new Set());
  });
});
