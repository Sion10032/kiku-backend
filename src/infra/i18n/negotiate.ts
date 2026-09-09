/** 支持的界面语言。新增语言：在此登记 + locales/ 下加同名 JSON。 */
export type Locale = 'zh-CN' | 'en';

export const SUPPORTED_LOCALES: readonly Locale[] = ['zh-CN', 'en'];

export const FALLBACK_LOCALE: Locale = 'zh-CN';

interface Range {
  tag: string;
  q: number;
}

/** 解析 Accept-Language 为 q 降序（q 相同保持声明顺序）的范围列表。 */
function parseRanges(header: string): Range[] {
  return header
    .split(',')
    .map((part) => {
      const [tag = '', qRaw = ''] = part.trim().split(';q=');
      const q = Number(qRaw);
      return {
        tag: tag.trim(),
        q: Number.isFinite(q) ? Math.min(Math.max(q, 0), 1) : 1,
      };
    })
    .filter((r) => r.tag.length > 0)
    .sort((a, b) => b.q - a.q);
}

function isSupported(tag: string): tag is Locale {
  return (SUPPORTED_LOCALES as readonly string[]).includes(tag);
}

/**
 * 按浏览器协商规则匹配语言：先精确匹配，再按主子标签（zh-TW→zh-CN）。
 * 全部不匹配（含通配符 *、ja 等）回退 FALLBACK_LOCALE。
 */
export function negotiate(acceptLanguage: string | undefined): Locale {
  if (!acceptLanguage) return FALLBACK_LOCALE;
  for (const { tag } of parseRanges(acceptLanguage)) {
    const lower = tag.toLowerCase();
    if (isSupported(lower)) return lower;
    const base = lower.split('-')[0];
    const byBase = SUPPORTED_LOCALES.find((l) => l.split('-')[0] === base);
    if (byBase) return byBase;
  }
  return FALLBACK_LOCALE;
}
