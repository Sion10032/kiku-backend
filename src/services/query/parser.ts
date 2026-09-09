import type { LiqeQuery } from 'liqe';
import { parse } from 'liqe';
import { translate } from '../../infra/i18n/index.js';

/** 查询语言错误：以字典 key+params 携带翻译素材，由路由层映射为 400 并本地化。 */
export class QueryParseError extends Error {
  constructor(
    readonly key: string,
    readonly params?: Record<string, string | number>,
  ) {
    // message 固定为 zh-CN 字典值：既有 compiler/parser 测试的中文断言零改动；
    // 请求侧本地化由路由用 reply.fail(400, err.key, err.params) 完成
    super(translate('zh-CN', key, params));
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
    // 行列位置按有无拆成两个 key：位置描述词随语言变化
    if (e.line != null) {
      throw new QueryParseError('errors.query.syntax-error-pos', {
        line: e.line,
        column: e.column ?? 0,
        detail: e.message,
      });
    }
    throw new QueryParseError('errors.query.syntax-error', {
      detail: e.message,
    });
  }
}
