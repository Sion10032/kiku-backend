import * as cheerio from 'cheerio';
import { getConfig } from '../config/index.js';
import { hasLetter, nameToUUID } from '../filesystem/utils.js';
import { fetchHtml, fetchJson } from './client.js';
import { fetchHVDBWorkInfo } from './hvdb.js';

/** 抓取到的系列信息（DLsite SRI 编号 + 系列名；一个作品至多属于一个系列）。 */
export interface ScrapedSeries {
  id: string;
  name: string;
}

export interface DLsiteWorkInfo {
  id: string;
  title: string;
  circle: string;
  circleId: string;
  nsfw: boolean;
  releaseDate: string;
  dlCount: number;
  price: number;
  reviewCount: number;
  rateCount: number;
  rateAverage: number;
  rateCountDetail: Record<string, number>;
  rank: Record<string, number>;
  tags: string[];
  vas: Array<{ id: string; name: string }>;
  series: { id: string; name: string } | null;
  description: string;
  coverUrl: string;
  language: string;
  sourceId: string;
}

/** 工作信息表 (#work_outline) 中各字段的 <th> 文本，随页面语言变化。 */
const OUTLINE_LABELS = {
  'ja-jp': {
    age: ['年齢指定'],
    release: ['販売日'],
    genre: ['ジャンル'],
    va: ['声優'],
    series: ['シリーズ名'],
  },
  'zh-cn': {
    age: ['年龄指定'],
    // DLsite 曾用「贩卖日」，现页面为「发售日」，两者都兼容
    release: ['发售日', '贩卖日'],
    genre: ['分类'],
    va: ['声优'],
    series: ['系列名'],
  },
  'zh-tw': {
    age: ['年齡指定'],
    release: ['販賣日'],
    genre: ['分類'],
    va: ['聲優'],
    series: ['系列名'],
  },
} as const;

type OutlineLabels = {
  age: readonly string[];
  release: readonly string[];
  genre: readonly string[];
  va: readonly string[];
  series: readonly string[];
};

/** `$()` 的返回类型，即任意节点的 Cheerio 选择器。 */
type NodeCheerio = ReturnType<cheerio.CheerioAPI>;

/** 在 #work_outline 表格中按 <th> 文本查找对应行的第一个 <td>。 */
function findOutlineTd(
  $: cheerio.CheerioAPI,
  labels: readonly string[],
): NodeCheerio | null {
  let td: NodeCheerio | null = null;
  $('#work_outline tr').each((_, tr) => {
    if (td) return;
    const th = $(tr).children('th').first();
    if (labels.includes(th.text().trim())) {
      td = $(tr).children('td').first();
    }
  });
  return td;
}

interface StaticWorkInfo {
  title: string;
  circle: string;
  circleId: string;
  nsfw: boolean;
  releaseDate: string;
  tags: string[];
  vas: Array<{ id: string; name: string }>;
  series: { id: string; name: string } | null;
  description: string;
  coverUrl: string;
  language: string;
  sourceId: string;
}

/** 从 DLsite 工作页 HTML 抓取静态元数据（标题、社团、标签、声优等）。 */
export async function scrapeStaticWorkInfo(
  rjId: string,
  signal?: AbortSignal,
): Promise<StaticWorkInfo> {
  const url = `https://www.dlsite.com/maniax/work/=/product_id/${rjId}.html`;
  const pageLanguage = getConfig().tagLanguage;
  const labels: OutlineLabels = OUTLINE_LABELS[pageLanguage];

  const html = await fetchHtml(url, {
    externalSignal: signal,
    headers: { Cookie: `locale=${pageLanguage}; adultchecked=1` },
  });
  const $ = cheerio.load(html);

  // 标题: og:title 形如 'xxx [社团名] | DLsite'，去掉后缀
  const title = (
    $('meta[property="og:title"]').attr('content') || $('#work_name').text()
  )
    .trim()
    .replace(/ \[.+\] \| DLsite$/, '');

  // 社团
  const circleLink = $('span.maker_name a').first();
  const circle = circleLink.text().trim();
  const circleId =
    circleLink.attr('href')?.match(/maker_id\/(RG\d+)/)?.[1] || '';

  // NSFW: 年龄指定行，'R18'/'18禁' 即成人内容（不同语言/时期页面文案不同）
  const ageText = findOutlineTd($, labels.age)?.text().trim() || '';
  const nsfw = /R18|18禁/.test(ageText);

  // 发售日 (YYYY-MM-DD)
  const releaseDigits = (
    findOutlineTd($, labels.release)?.text() || ''
  ).replace(/[^0-9]/g, '');
  const releaseDate =
    releaseDigits.length >= 8
      ? `${releaseDigits.slice(0, 4)}-${releaseDigits.slice(4, 6)}-${releaseDigits.slice(6, 8)}`
      : '';

  // 标签: 分类行的 genre 链接（声优/剧情/插画行的链接是 keyword_creater，不能要）
  const tags: string[] = [];
  findOutlineTd($, labels.genre)
    ?.find('a')
    .each((_, el) => {
      const href = $(el).attr('href') || '';
      if (/genre\/\d+/.test(href)) {
        const tag = $(el).text().trim();
        if (tag) tags.push(tag);
      }
    });

  // 声优: 声优行的链接，id 由名字生成
  const vas: Array<{ id: string; name: string }> = [];
  findOutlineTd($, labels.va)
    ?.find('a')
    .each((_, el) => {
      const name = $(el).text().trim();
      if (name) vas.push({ id: nameToUUID(name), name });
    });

  // 系列: シリーズ名行的链接，href 形如 .../fsr/=/title_id/SRI0000027029/...
  // 一个作品至多一个系列：只保留第一条 title_id 匹配的锚点
  const series: ScrapedSeries | null = (() => {
    let found: ScrapedSeries | null = null;
    findOutlineTd($, labels.series)
      ?.find('a')
      .each((_, el) => {
        if (found) return;
        const href = $(el).attr('href') || '';
        const id = href.match(/title_id\/(SRI\d+)/)?.[1];
        const name = $(el).text().trim();
        if (id && name) found = { id, name };
      });
    return found;
  })();

  // 封面
  const coverUrl = $('meta[property="og:image"]').attr('content') || '';

  // 只有当所有关键数据都为空时才认为解析失败
  if (tags.length === 0 && vas.length === 0 && !coverUrl) {
    throw new Error(`Couldn't parse data from DLsite work page (${url}).`);
  }

  // 作品简介: 正文在各 .work_parts_area 中，heading 是章节标题不要
  const description = $('[itemprop="description"] .work_parts_area')
    .text()
    .trim();

  // 语言: 从支持的语言部分解析，并转换为 locale 代码
  const langMap: Record<string, string> = {
    日語: 'ja-jp',
    日语: 'ja-jp',
    '中文(繁體字)': 'zh-tw',
    '中文(繁体字)': 'zh-tw',
    '中文(簡體字)': 'zh-cn',
    '中文(简体字)': 'zh-cn',
    英語: 'en',
    英语: 'en',
    韓語: 'ko',
    韩语: 'ko',
  };
  const languageSet = new Set<string>();
  $('#work_outline tr').each((_, tr) => {
    const th = $(tr).children('th').first().text().trim();
    if (/支持的语言|対応言語/.test(th)) {
      $(tr)
        .children('td')
        .first()
        .find('span')
        .each((_, span) => {
          const langName = $(span).attr('title') || $(span).text().trim();
          if (langName) {
            const locale = langMap[langName];
            if (locale) languageSet.add(locale);
          }
        });
    }
  });
  const language = Array.from(languageSet).join(',');

  // sourceId: 从封面 URL 中提取未翻译版本的 RJ 号
  // 封面 URL 格式: https://img.dlsite.jp/modpub/images2/work/doujin/RJ01560000/RJ01559247_img_main.jpg
  // 其中 RJ01559247 是 sourceId
  let sourceId = '';
  const coverMatch = coverUrl.match(/RJ(\d+)_img_main\.jpg/);
  if (coverMatch) {
    sourceId = `RJ${coverMatch[1]}`;
  }

  return {
    title,
    circle,
    circleId,
    nsfw,
    releaseDate,
    tags,
    vas,
    series,
    description,
    coverUrl,
    language,
    sourceId,
  };
}

interface DLsiteAjaxItem {
  dl_count?: string | number;
  price?: string | number;
  rate_count?: string | number;
  rate_average_2dp?: string | number;
  review_count?: string | number;
  rate_count_detail?: Array<{ review_point: number; count: number }>;
  rank?: Array<{ term: string; category: string; rank: number }>;
}

interface DynamicWorkInfo {
  dlCount: number;
  price: number;
  reviewCount: number;
  rateCount: number;
  rateAverage: number;
  rateCountDetail: Record<string, number>;
  rank: Record<string, number>;
}

/** 从 DLsite AJAX API 抓取动态元数据（销量、价格、评分等）。 */
async function scrapeDynamicWorkInfo(
  rjId: string,
  signal?: AbortSignal,
): Promise<DynamicWorkInfo> {
  const url = `https://www.dlsite.com/maniax-touch/product/info/ajax?product_id=${rjId}`;
  const data = await fetchJson<Record<string, DLsiteAjaxItem>>(url, {
    externalSignal: signal,
  });
  const item = data[rjId];
  if (!item) {
    throw new Error(`Couldn't parse data from DLsite ajax API (${url}).`);
  }

  // 评分分布: [{ review_point, count }] -> { '1': n, ... }
  const rateCountDetail: Record<string, number> = {};
  for (const detail of item.rate_count_detail || []) {
    rateCountDetail[String(detail.review_point)] = detail.count;
  }

  // 榜单成绩: [{ term, category, rank }] -> { 'day_all': n, ... }
  const rank: Record<string, number> = {};
  for (const entry of item.rank || []) {
    rank[`${entry.term}_${entry.category}`] = entry.rank;
  }

  return {
    dlCount: Number(item.dl_count) || 0,
    price: Number(item.price) || 0,
    reviewCount: Number(item.review_count) || 0,
    rateCount: Number(item.rate_count) || 0,
    rateAverage: Number(item.rate_average_2dp) || 0,
    rateCountDetail,
    rank,
  };
}

export async function fetchDLsiteWorkInfo(
  rjId: string,
  signal?: AbortSignal,
): Promise<DLsiteWorkInfo> {
  const [staticInfo, dynamicInfo] = await Promise.all([
    scrapeStaticWorkInfo(rjId, signal),
    scrapeDynamicWorkInfo(rjId, signal),
  ]);

  // 从 DLsite 抓不到声优信息时，从 HVDB 抓取声优信息
  let { vas } = staticInfo;
  if (vas.length === 0) {
    const hvdbInfo = await fetchHVDBWorkInfo(rjId).catch(() => null);
    if (hvdbInfo) {
      const candidates =
        hvdbInfo.vas.length <= 1
          ? hvdbInfo.vas
          : hvdbInfo.vas.filter((va) => !hasLetter(va.name)); // 过滤掉英文的声优名
      vas = candidates.map((va) => ({
        id: nameToUUID(va.name),
        name: va.name,
      }));
    }
  }

  return {
    id: rjId,
    ...staticInfo,
    vas,
    ...dynamicInfo,
    language: staticInfo.language,
    sourceId: staticInfo.sourceId,
  };
}

export async function searchDLsite(keyword: string): Promise<DLsiteWorkInfo[]> {
  const url = `https://www.dlsite.com/maniax/fsr/=/keyword/${encodeURIComponent(keyword)}/`;

  const html = await fetchHtml(url);
  const $ = cheerio.load(html);

  const works: DLsiteWorkInfo[] = [];

  $('.search_result_img_box').each((_, el) => {
    const href = $(el).find('a').attr('href') || '';
    const rjMatch = href.match(/product_id\/(RJ\d+)/);

    if (rjMatch?.[1]) {
      const rjId = rjMatch[1];
      const title = $(el).find('.work_name').text().trim();
      const circle = $(el).find('.maker_name').text().trim();

      works.push({
        id: rjId,
        title,
        circle,
        circleId: '',
        nsfw: true,
        releaseDate: '',
        dlCount: 0,
        price: 0,
        reviewCount: 0,
        rateCount: 0,
        rateAverage: 0,
        rateCountDetail: {},
        rank: {},
        tags: [],
        vas: [],
        series: null,
        description: '',
        coverUrl: '',
        language: '',
        sourceId: '',
      });
    }
  });

  return works;
}
