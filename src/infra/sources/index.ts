/**
 * 作品来源分类：把作品 id 归类为 'dlsite' 或 'manual' 的单一判定点。
 *
 * - RJ/VJ（DLsite 前缀）→ 'dlsite'
 * - 命中人工前缀（模块加载时直接引用 manual.ts 的 MANUAL_PREFIXES）→ 'manual'
 * - 其余 → null
 *
 * 接口刻意不含 fetchMetadata：调用方（scanner）已知 dlsite 路径，
 * 分类器只负责判定分支；同时避免 sources→scraper→sources 循环依赖。
 */
import {
  DLSITE_PREFIXES,
  type ParsedWorkCode,
  parseWorkCode,
} from '../../utils/workcode.js';
import { MANUAL_PREFIXES } from './manual.js';
import type { WorkSourceId } from './types.js';

// 人工前缀集合在模块加载时归一为大写一次（代码常量，非配置）
const normalizedManual = MANUAL_PREFIXES.map((p) => p.toUpperCase());

/** 作品来源解析器（模块级单例，调用方无需构造）。 */
export const workSourceResolver = {
  /** 完整作品代码 → { prefix, digits }；前缀集合 = DLsite + 人工，归一为大写。 */
  parse(id: string): ParsedWorkCode | null {
    return parseWorkCode(id, [...DLSITE_PREFIXES, ...normalizedManual]);
  },

  /** 来源判定：RJ/VJ → 'dlsite'；人工前缀 → 'manual'；其余 → null。 */
  classify(id: string): WorkSourceId | null {
    const parsed = workSourceResolver.parse(id);
    if (!parsed) return null;
    if (parsed.prefix === 'RJ' || parsed.prefix === 'VJ') return 'dlsite';
    if (normalizedManual.includes(parsed.prefix)) return 'manual';
    return null;
  },
};
