import { afterEach, describe, expect, it, mock } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';

setupTestEnvironment();

const realFetch = globalThis.fetch;

const WORK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テスト作品 [テストサークル] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td><a href="https://www.dlsite.com/maniax/info/=/adult/1">R18</a></td></tr>
    <tr><th>販売日</th><td>2025年01月10日 0時</td></tr>
    <tr><th>ジャンル</th>
      <td><a href="https://www.dlsite.com/maniax/fsr/=/genre/213/from/work.genre">癒し</a> / <a href="https://www.dlsite.com/maniax/fsr/=/genre/501/from/work.genre">ASMR</a></td>
    </tr>
    <tr><th>声優</th><td><a href="https://www.dlsite.com/maniax/circle/profile/=/maker_id/RG00000001.html">佐倉綾音</a></td></tr>
    <tr><th>シリーズ名</th>
      <td><a href="https://www.dlsite.com/maniax/fsr/=/title_id/SRI0000027029/from/work.titles">テストシリーズ</a></td>
    </tr>
  </table>
</body>
</html>`;

/** シリーズ名行がない（単発作品）页面片段 */
const NO_SERIES_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テスト作品2 [テストサークル] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td>R18</td></tr>
    <tr><th>販売日</th><td>2025年02月20日</td></tr>
    <tr><th>ジャンル</th><td><a href="https://www.dlsite.com/maniax/fsr/=/genre/213/from/work.genre">癒し</a></td></tr>
  </table>
</body>
</html>`;

/** シリーズ名行存在、但链接不是系列链接（无 title_id）的页面片段 */
const NON_SERIES_LINK_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テスト作品3 [テストサークル] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td>R18</td></tr>
    <tr><th>シリーズ名</th>
      <td><a href="https://www.dlsite.com/maniax/fsr/=/genre/213/from/work.genre">癒し</a></td>
    </tr>
    <tr><th>ジャンル</th><td><a href="https://www.dlsite.com/maniax/fsr/=/genre/213/from/work.genre">癒し</a></td></tr>
  </table>
</body>
</html>`;

/** シリーズ名行に SRI アンカーが 2 つある页面片段（最初の 1 つのみ採用） */
const TWO_SERIES_LINKS_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テスト作品4 [テストサークル] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td>R18</td></tr>
    <tr><th>シリーズ名</th>
      <td><a href="https://www.dlsite.com/maniax/fsr/=/title_id/SRI0000000001/from/work.titles">最初のシリーズ</a> / <a href="https://www.dlsite.com/maniax/fsr/=/title_id/SRI0000000002/from/work.titles">二番目のシリーズ</a></td>
    </tr>
  </table>
</body>
</html>`;

/** 让 scrapeStaticWorkInfo 抓到给定 HTML（不发出真实网络请求） */
function mockWorkPage(html: string): void {
  globalThis.fetch = mock(
    async () => new Response(html, { status: 200 }),
  ) as unknown as typeof fetch;
}

describe('scrapeStaticWorkInfo のシリーズ名解析', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('シリーズ名行から id/name を抽出できる', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(WORK_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toEqual({
        id: 'SRI0000027029',
        name: 'テストシリーズ',
      });
      // 既存フィールドも引き続き解釈できること
      expect(info.title).toBe('テスト作品');
      expect(info.tags).toEqual(['癒し', 'ASMR']);
      expect(info.vas).toHaveLength(1);
    } finally {
      setConfigForTesting(saved);
    }
  });

  it('シリーズ名行がない作品は series が null になる', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(NO_SERIES_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toBeNull();
    } finally {
      setConfigForTesting(saved);
    }
  });

  it('シリーズ名行のリンクが title_id を含まない場合は series が null になる', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(NON_SERIES_LINK_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toBeNull();
    } finally {
      setConfigForTesting(saved);
    }
  });

  it('シリーズ名行に SRI アンカーが複数ある場合は最初の 1 つだけを採用する', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(TWO_SERIES_LINKS_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toEqual({
        id: 'SRI0000000001',
        name: '最初のシリーズ',
      });
    } finally {
      setConfigForTesting(saved);
    }
  });
});

/** 年齢指定行のみを含む最小ページ（og:image があれば解析失敗判定を回避できる） */
const AGE_PAGE = (ageCell: string) => `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="年齢テスト [テストサークル] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td>${ageCell}</td></tr>
  </table>
</body>
</html>`;

describe('scrapeStaticWorkInfo の年齢指定解析', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  // 年龄指定值跨语言一致（R18/R-15 各语言写法相同，连字符容错）；
  // 仅全年龄随语言翻译（日：全年齢 / 中：全年龄 / 英：All Ages），连同空值均落默认 'all'
  it.each([
    ['R18', 'r18'],
    ['R-18', 'r18'],
    ['R-15', 'r15'],
    ['R15', 'r15'],
    ['全年齢', 'all'],
    ['全年龄', 'all'],
    ['All Ages', 'all'],
    ['', 'all'],
  ])('年齢指定「%s」→ %s', async (ageText, expected) => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(AGE_PAGE(ageText));

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');
      expect(info.ageRating).toBe(expected as 'all' | 'r15' | 'r18');
    } finally {
      setConfigForTesting(saved);
    }
  });
});

describe('fetchDLsiteWorkInfo（VJ 作品）', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  const VJ_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テストゲーム [テストブランド] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/professional/VJ01004000/VJ01003042_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齢指定</th><td>R18</td></tr>
    <tr><th>販売日</th><td>2025年03月14日</td></tr>
    <tr><th>ジャンル</th><td><a href="https://www.dlsite.com/pro/fsr/=/genre/276/from/work.genre">アクション</a></td></tr>
  </table>
</body>
</html>`;

  it('VJ 号请求 pro 站点，sourceId 从 professional 封面 URL 提取', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });

    const urls: string[] = [];
    globalThis.fetch = mock(async (input: string | URL | Request) => {
      const url = String(input);
      urls.push(url);
      if (url.includes('/pro/work/=/product_id/VJ01003042.html')) {
        return new Response(VJ_PAGE_HTML, { status: 200 });
      }
      if (url.includes('/product/info/ajax')) {
        return new Response(
          JSON.stringify({
            VJ01003042: {
              dl_count: 10,
              price: 1000,
              review_count: 2,
              rate_count: 5,
              rate_average_2dp: 4.5,
              rate_count_detail: [],
              rank: [],
            },
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      // HVDB 兜底等其余请求 → 404（fetchHVDBWorkInfo 内部 catch 返回 null）
      return new Response('not found', { status: 404 });
    }) as unknown as typeof fetch;

    try {
      // scanner-*.test.ts 会用 mock.module 覆盖 dlsite 模块的 fetchDLsiteWorkInfo，
      // 且 bun 的模块 mock 在同进程内跨测试文件生效。加 query 绕开缓存，
      // 拿到未被 mock 的真实模块实例。
      const { fetchDLsiteWorkInfo } = await import('./dlsite?vj-test');
      const info = await fetchDLsiteWorkInfo('VJ01003042');

      expect(info.id).toBe('VJ01003042');
      expect(info.sourceId).toBe('VJ01003042');
      expect(
        urls.some((u) =>
          u.startsWith('https://www.dlsite.com/pro/work/=/product_id/'),
        ),
      ).toBe(true);
      expect(
        urls.some((u) =>
          u.startsWith('https://www.dlsite.com/pro-touch/product/info/ajax'),
        ),
      ).toBe(true);
      expect(urls.every((u) => !u.includes('maniax'))).toBe(true);
    } finally {
      globalThis.fetch = realFetch;
      setConfigForTesting(saved);
    }
  });
});
