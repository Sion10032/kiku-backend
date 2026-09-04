import { afterEach, beforeEach, describe, expect, it, mock } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

const realFetch = globalThis.fetch;
const fetchMock = mock(
  async () => new Response('missing', { status: 404, statusText: 'Not Found' }),
);

describe('retryFetch 对 4xx 的重试策略', () => {
  beforeEach(() => {
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    fetchMock.mockClear();
  });

  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('404 是永久错误：只请求一次，立即失败', async () => {
    const { retryFetch } = await import('../src/infra/scraper/client');

    let err: (Error & { status?: number }) | null = null;
    try {
      await retryFetch('https://img.dlsite.jp/cover_sam.jpg');
    } catch (e) {
      err = e as Error & { status?: number };
    }

    expect(err).not.toBeNull();
    expect(err?.status).toBe(404);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('5xx 是临时错误：仍会重试并最终成功', async () => {
    // 第一次 500，之后恢复 200
    fetchMock.mockImplementationOnce(
      async () => new Response('boom', { status: 500, statusText: 'Err' }),
    );
    fetchMock.mockImplementationOnce(
      async () => new Response('ok', { status: 200, statusText: 'OK' }),
    );

    const { retryFetch } = await import('../src/infra/scraper/client');
    const res = await retryFetch('https://example.com/retry-me');

    expect(res.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
