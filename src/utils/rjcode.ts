/**
 * RJ 号（DLsite 作品 ID / workid）的匹配、提取与验证。
 *
 * 规则：
 * - 前缀大小写不敏感（RJ / rj 均可）
 * - 数字部分恰好 6 位或 8 位（不支持 6~8 之间的 7 位，也不支持 9 位以上）
 * - workid 保持原样，不做任何规范化（如补零、改大小写）
 */

// 大小写不敏感前缀 + 恰好 6 或 8 位数字，且其后不能再紧跟数字（避免从更长数字串中截出片段）
const RJ_CODE_SOURCE = '[Rr][Jj](?:\\d{8}|\\d{6})(?!\\d)';

/** 精确校验一个完整字符串是否为合法 RJ 号。 */
export function isValidWorkId(id: string): boolean {
  return new RegExp(`^${RJ_CODE_SOURCE}$`).test(id);
}

/**
 * 从任意文本（如文件夹名、搜索关键词）中提取第一个 RJ 号，保持原样返回；无则返回 null。
 */
export function extractRJCode(text: string): string | null {
  const match = text.match(new RegExp(RJ_CODE_SOURCE));
  return match ? match[0] : null;
}
