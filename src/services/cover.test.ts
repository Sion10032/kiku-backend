import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
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
const { downloadCover, coverExists, getCoverData, deleteAllCovers } =
  await import('./cover.service');
const { deleteBlob } = await import('../infra/db/blob/index');

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
});
