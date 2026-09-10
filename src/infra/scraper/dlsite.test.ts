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
              rank: [
                { term: 'year', category: 'all', rank: 108, rank_date: '2012' },
                {
                  term: 'total',
                  category: 'voice',
                  rank: 427,
                  rank_date: '2018-10-11',
                },
                { term: 'day', category: 'all', rank: 3 },
              ],
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
      // @ts-expect-error - 带查询串的模块路径 tsc 无法解析
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
      // rank 保持 DLsite AJAX 原始数组形状（保留 rank_date，缺省补 ''，非法项跳过）
      expect(info.rank).toEqual([
        { term: 'year', category: 'all', rank: 108, rank_date: '2012' },
        {
          term: 'total',
          category: 'voice',
          rank: 427,
          rank_date: '2018-10-11',
        },
        { term: 'day', category: 'all', rank: 3, rank_date: '' },
      ]);
    } finally {
      globalThis.fetch = realFetch;
      setConfigForTesting(saved);
    }
  });
});

/** VJ 作品页（zh-cn）的 work_outline 片段：按真实 pro 页面结构还原。
 *  与 RJ 页面的差异：品牌行 maker_id 为 VG 前缀；多了 剧情/插画 creater 行；
 *  分类链接带 /ana_flg/all 后缀；语言行为「支持的语言」。 */
const VJ_PAGE_ZH_CN_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="音声作品「テスト」 [ゆずソフト] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/professional/VJ01003000/VJ01002343_img_main.jpg" />
</head>
<body>
<div id="work_right_inner">
<table id="work_maker">
<tbody><tr>
<th>品牌名</th>
<td>
  <span itemprop="brand" class="maker_name">
            <a href="https://www.dlsite.com/pro/circle/profile/=/maker_id/VG03026.html">ゆずソフト</a>
      </span>
</td>
</tr>
</tbody></table>
<table cellspacing="0" id="work_outline">
    <tbody><tr>
    <th>发售日</th>
    <td><a href="https://www.dlsite.com/pro/new/=/year/2024/mon/06/day/01/cyear/2024/cmon/06">2024年06月01日</a></td>  </tr>
<tr>
  <th>剧情</th>
    <td>
          <a href="https://www.dlsite.com/pro/fsr/=/keyword_creater/%22%E5%A4%A9%E5%AE%AE%E3%82%8A%E3%81%A4%22/ana_flg/all">天宮りつ</a>        </td>
</tr>
<tr>
  <th>插画</th>
    <td>
          <a href="https://www.dlsite.com/pro/fsr/=/keyword_creater/%22%E3%81%93%E3%81%B6%E3%81%84%E3%81%A1%22/ana_flg/all">こぶいち</a>        </td>
</tr>
<tr>
  <th>声优</th>
    <td>
          <a href="https://www.dlsite.com/pro/fsr/=/keyword_creater/%22%E5%A4%8F%E5%92%8C%E5%B0%8F%22/ana_flg/all">夏和小</a>        </td>
</tr>
    <tr>
    <th>年龄指定</th>
    <td>
      <div class="work_genre">
                  <a href="https://www.dlsite.com/pro/fsr/=/work_category%5B0%5D/pc/age_category/3/from/icon.work"><span class="icon_ADL" title="R18">R18</span></a>
              </div>
    </td>
  </tr>
    <tr>
    <th>作品形式</th>
    <td>
      <div class="work_genre" id="category_type">
        <a href="https://www.dlsite.com/pro/works/type/=/work_type/SOU/from/icon.work"><span class="icon_SOU" title="音声・ASMR">音声・ASMR</span></a>      </div>
    </td>
  </tr>
            <tr>
      <th>支持的语言</th>
      <td>
        <div class="work_genre">
          <a href="https://www.dlsite.com/pro/fsr/=/work_category%5B0%5D/pc/options/JPN/from/icon.work"><span class="icon_JPN" title="日语">日语</span></a>
        </div>
      </td>
    </tr>
        <tr>
      <th>分类</th>
      <td>
        <div class="main_genre">
                      <a href="https://www.dlsite.com/pro/fsr/=/genre/497/from/work.genre/ana_flg/all">ASMR</a>
                      <a href="https://www.dlsite.com/pro/fsr/=/genre/496/from/work.genre/ana_flg/all">双声道立体声/人头麦</a>
                      <a href="https://www.dlsite.com/pro/fsr/=/genre/014/from/work.genre/ana_flg/all">情侣</a>
        </div>
      </td>
    </tr>
  </tbody></table>
</div>
</body>
</html>`;

describe('scrapeStaticWorkInfo（VJ pro 页面，zh-cn）', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('VJ 页面全字段解析：VG 品牌 id、发售日、声优/分类行、语言', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'zh-cn' });
    mockWorkPage(VJ_PAGE_ZH_CN_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('VJ01002343');

      expect(info.title).toBe('音声作品「テスト」');
      expect(info.circle).toBe('ゆずソフト');
      expect(info.circleId).toBe('VG03026'); // 品牌是 VG 前缀，非 RG
      expect(info.ageRating).toBe('r18');
      expect(info.releaseDate).toBe('2024-06-01');
      // 剧情/插画行是 keyword_creater 链接，不得混入 tags/vas
      expect(info.tags).toEqual(['ASMR', '双声道立体声/人头麦', '情侣']);
      expect(info.vas).toHaveLength(1);
      expect(info.vas[0]?.name).toBe('夏和小');
      expect(info.language).toBe('ja-jp');
      expect(info.sourceId).toBe('VJ01002343');
    } finally {
      setConfigForTesting(saved);
    }
  });
});

/** zh-tw pro 页面的语言行是「對應語言」（简体为「支持的语言」，日文为「対応言語」） */
const ZH_TW_LANGUAGE_PAGE_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta property="og:title" content="テスト作品5 [テストブランド] | DLsite" />
  <meta property="og:image" content="https://img.dlsite.jp/modpub/images2/work/professional/VJ01003000/VJ01002343_img_main.jpg" />
</head>
<body>
  <table id="work_outline">
    <tr><th>年齡指定</th><td>R18</td></tr>
    <tr><th>販賣日</th><td>2024年06月01日</td></tr>
    <tr><th>分類</th><td><div class="main_genre"><a href="https://www.dlsite.com/pro/fsr/=/genre/497/from/work.genre/ana_flg/all">ASMR</a></div></td></tr>
    <tr><th>對應語言</th><td><div class="work_genre"><a href="#"><span class="icon_JPN" title="日語">日語</span></a></div></td></tr>
  </table>
</body>
</html>`;

describe('scrapeStaticWorkInfo（zh-tw 對應語言行）', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('zh-tw 页面从「對應語言」行解析语言', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'zh-tw' });
    mockWorkPage(ZH_TW_LANGUAGE_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      const info = await scrapeStaticWorkInfo('VJ01002343');
      expect(info.language).toBe('ja-jp');
    } finally {
      setConfigForTesting(saved);
    }
  });
});

/** 地区限制等错误页：#main 内是 error_box，无任何作品数据 */
const REGION_ERROR_PAGE_HTML = `<div id="main" data-section_name="main">
    <div class="error_box error_box_work" data-nosnippet="">
        <div class="error_box_inner">
            <div class="title_img">
                <p class="error_large_text">SORRY...</p>
                <p class="title_text">您所在的国家・区域无法购买此作品。</p>
            </div>
        </div>
    </div>
</div>`;

describe('scrapeStaticWorkInfo（错误页）', () => {
  afterEach(() => {
    globalThis.fetch = realFetch;
  });

  it('#main 内是 error_box 时直接抛错，不尝试解析作品数据', async () => {
    const { setConfigForTesting, getConfig } = await import(
      '../config/index.js'
    );
    const saved = getConfig();
    setConfigForTesting({ ...saved, tagLanguage: 'zh-cn' });
    mockWorkPage(REGION_ERROR_PAGE_HTML);

    try {
      const { scrapeStaticWorkInfo } = await import('./dlsite');
      await expect(scrapeStaticWorkInfo('RJ01559247')).rejects.toThrow(
        /error page/i,
      );
    } finally {
      setConfigForTesting(saved);
    }
  });
});
