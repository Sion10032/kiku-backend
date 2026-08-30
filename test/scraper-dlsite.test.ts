import { afterEach, describe, expect, it, mock } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';

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
      '../src/config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(WORK_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('../src/scraper/dlsite');
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
      '../src/config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(NO_SERIES_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('../src/scraper/dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toBeNull();
    } finally {
      setConfigForTesting(saved);
    }
  });

  it('シリーズ名行のリンクが title_id を含まない場合は series が null になる', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../src/config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(NON_SERIES_LINK_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('../src/scraper/dlsite');
      const info = await scrapeStaticWorkInfo('RJ01559247');

      expect(info.series).toBeNull();
    } finally {
      setConfigForTesting(saved);
    }
  });

  it('シリーズ名行に SRI アンカーが複数ある場合は最初の 1 つだけを採用する', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../src/config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'ja-jp' });
    mockWorkPage(TWO_SERIES_LINKS_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('../src/scraper/dlsite');
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
