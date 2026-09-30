/**
 * 作品代码（workid）的匹配、提取与验证。
 *
 * 默认支持前缀（DLsite）：
 * - RJ：同人作品（音声、漫画等）
 * - VJ：商业作品（美少女游戏等）
 *
 * 前缀集合可参数化（如人工作品前缀 UW），与前端 src/utils/workId.ts 人工对齐。
 *
 * 规则：
 * - 前缀大小写不敏感（RJ / rj / VJ / vj 均可）
 * - 数字部分恰好 6 位或 8 位（不支持 6~8 之间的 7 位，也不支持 9 位以上）
 * - workid 保持原样，不做任何规范化（如补零、改大小写）
 */

/** DLsite 作品代码前缀 */
export type WorkCodePrefix = 'RJ' | 'VJ';

/** parseWorkCode 的通用解析结果；prefix 为归一后的大写前缀（任意前缀集均可命中）。 */
export type ParsedWorkCode = { prefix: string; digits: string };

/** DLsite 前缀集合（默认值）。 */
export const DLSITE_PREFIXES = ['RJ', 'VJ'] as const;

/** 由前缀集合构建「纯前缀」正则源串（大小写不敏感的字符类交替）。 */
function buildPrefixSource(prefixes: readonly string[]): string {
  return prefixes
    .map((p) => p.toUpperCase())
    .map((p) =>
      Array.from(p)
        .map((ch) => `[${ch}${ch.toLowerCase()}]`)
        .join(''),
    )
    .join('|');
}

/** 由前缀集合构建正则源串（大小写不敏感前缀 + 恰好 6 或 8 位数字，且其后不能再紧跟数字，避免从更长数字串中截出片段）。 */
export function buildWorkCodeSource(prefixes: readonly string[]): string {
  return `(?:${buildPrefixSource(prefixes)})(?:\\d{8}|\\d{6})(?!\\d)`;
}

// 导出源串供调用方在特定上下文中定制锚点（如从封面 URL 的 "_img_main.jpg" 前提取）。
export const WORK_CODE_SOURCE = buildWorkCodeSource(DLSITE_PREFIXES);

/** 精确校验一个完整字符串是否为合法作品代码（默认 RJ/VJ）。 */
export function isValidWorkId(
  id: string,
  prefixes: readonly string[] = DLSITE_PREFIXES,
): boolean {
  return new RegExp(`^${buildWorkCodeSource(prefixes)}$`).test(id);
}

/**
 * 从任意文本（如文件夹名、搜索关键词）中提取第一个作品代码（默认 RJ/VJ），
 * 保持原样返回；无则返回 null。
 */
export function extractWorkCode(
  text: string,
  prefixes: readonly string[] = DLSITE_PREFIXES,
): string | null {
  const match = text.match(new RegExp(buildWorkCodeSource(prefixes)));
  return match ? match[0] : null;
}

/**
 * 将完整作品代码拆分为前缀与数字部分；前缀归一为大写，非法则返回 null。
 * 前缀集合可参数化，默认仅认 RJ/VJ。
 */
export function parseWorkCode(
  id: string,
  prefixes: readonly string[] = DLSITE_PREFIXES,
): ParsedWorkCode | null {
  const match = id.match(
    new RegExp(`^(${buildPrefixSource(prefixes)})(\\d{8}|\\d{6})$`),
  );
  if (!match?.[1] || !match[2]) return null;
  return { prefix: match[1].toUpperCase(), digits: match[2] };
}

/**
 * 以 DLsite 前缀（RJ/VJ）解析作品代码，prefix 收窄为 WorkCodePrefix。
 * 安全：默认集合归一后只含 RJ/VJ。
 */
export function parseDlsiteCode(
  id: string,
): { prefix: WorkCodePrefix; digits: string } | null {
  const parsed = parseWorkCode(id, DLSITE_PREFIXES);
  return parsed ? { ...parsed, prefix: parsed.prefix as WorkCodePrefix } : null;
}

/** DLsite 作品页所在站点段：RJ → maniax（同人），VJ → pro（商业）。 */
export function dlsiteSiteSegment(prefix: WorkCodePrefix): 'maniax' | 'pro' {
  return prefix === 'RJ' ? 'maniax' : 'pro';
}

/** DLsite 动态元数据 Ajax API 的站点段：RJ → maniax-touch，VJ → pro-touch。 */
export function dlsiteAjaxSegment(
  prefix: WorkCodePrefix,
): 'maniax-touch' | 'pro-touch' {
  return prefix === 'RJ' ? 'maniax-touch' : 'pro-touch';
}

/**
 * DLsite 封面图 CDN 路径段：RJ → doujin，VJ → professional。
 * 例：https://img.dlsite.jp/modpub/images2/work/{segment}/{组号}/{作品代码}_img_main.jpg
 */
export function dlsiteImgSegment(
  prefix: WorkCodePrefix,
): 'doujin' | 'professional' {
  return prefix === 'RJ' ? 'doujin' : 'professional';
}
