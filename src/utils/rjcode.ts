/**
 * DLsite 作品代码（workid）的匹配、提取与验证。
 *
 * 支持前缀：
 * - RJ：同人作品（音声、漫画等）
 * - VJ：商业作品（美少女游戏等）
 *
 * 规则：
 * - 前缀大小写不敏感（RJ / rj / VJ / vj 均可）
 * - 数字部分恰好 6 位或 8 位（不支持 6~8 之间的 7 位，也不支持 9 位以上）
 * - workid 保持原样，不做任何规范化（如补零、改大小写）
 */

/** 作品代码前缀 */
export type WorkCodePrefix = 'RJ' | 'VJ';

// 大小写不敏感前缀 + 恰好 6 或 8 位数字，且其后不能再紧跟数字（避免从更长数字串中截出片段）。
// 导出源串供调用方在特定上下文中定制锚点（如从封面 URL 的 "_img_main.jpg" 前提取）。
export const WORK_CODE_SOURCE = '(?:[Rr][Jj]|[Vv][Jj])(?:\\d{8}|\\d{6})(?!\\d)';

/** 精确校验一个完整字符串是否为合法作品代码（RJ/VJ）。 */
export function isValidWorkId(id: string): boolean {
  return new RegExp(`^${WORK_CODE_SOURCE}$`).test(id);
}

/**
 * 从任意文本（如文件夹名、搜索关键词）中提取第一个作品代码（RJ/VJ），
 * 保持原样返回；无则返回 null。
 */
export function extractWorkCode(text: string): string | null {
  const match = text.match(new RegExp(WORK_CODE_SOURCE));
  return match ? match[0] : null;
}

/**
 * 将完整作品代码拆分为前缀与数字部分；前缀归一为大写，非法则返回 null。
 */
export function parseWorkCode(
  id: string,
): { prefix: WorkCodePrefix; digits: string } | null {
  const match = id.match(/^([Rr][Jj]|[Vv][Jj])(\d{8}|\d{6})$/);
  if (!match) return null;
  return { prefix: match[1].toUpperCase() as WorkCodePrefix, digits: match[2] };
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
