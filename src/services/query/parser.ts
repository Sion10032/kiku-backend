import type { LiqeQuery } from 'liqe';
import { parse } from 'liqe';

/** 查询语言错误：消息面向最终用户（中文），由路由层映射为 400。 */
export class QueryParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'QueryParseError';
  }
}

/**
 * 解析 LQL 查询文本为 liqe AST。
 *
 * 仅负责语法层：liqe 的 SyntaxError 统一归一化为 QueryParseError，
 * 并透出 liqe 自带的行列位置（如「第1行第5列」）。
 * 字段白名单与语义校验在 compiler.ts（见 D3）。
 */
export function parseQuery(q: string): LiqeQuery {
  try {
    return parse(q);
  } catch (err) {
    const e = err as SyntaxError & { line?: number; column?: number };
    const pos = e.line != null ? `（第${e.line}行第${e.column}列）` : '';
    throw new QueryParseError(`查询语法错误${pos}：${e.message}`);
  }
}
