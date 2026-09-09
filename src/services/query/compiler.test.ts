import { describe, expect, it } from 'bun:test';
// drizzle 1.0.0-rc 移除了 SQL.toSQL()，用方言的 sqlToQuery() 取得 { sql, params }
import { SQLiteDialect } from 'drizzle-orm/sqlite-core';
import type { LiqeQuery } from 'liqe';
import { compileQuery } from './compiler';
import { parseQuery, QueryParseError } from './parser';

const dialect = new SQLiteDialect();

function compile(q: string) {
  const ast: LiqeQuery = parseQuery(q);
  const cond = compileQuery(ast);
  return cond && dialect.sqlToQuery(cond);
}

describe('compileQuery：字段条件', () => {
  it('tag 精确 → JOIN 子查询等值', () => {
    const s = compile('tag:催眠');
    expect(s?.sql).toContain('r_tag_work');
    expect(s?.sql).toContain('join');
    expect(s?.params).toContain('催眠');
  });

  it('circle 精确 → circleId IN 子查询', () => {
    const s = compile('circle:"夜の ひつじ"');
    expect(s?.sql).toContain('t_circle');
    expect(s?.params).toContain('夜の ひつじ');
  });

  it('va 精确', () => {
    const s = compile('va:花澤');
    expect(s?.sql).toContain('r_va_work');
    expect(s?.params).toContain('花澤');
  });

  it('series 精确（引号含空格）→ series_id IN t_series 子查询', () => {
    const s = compile('series:"○○シリーズ 第2章"');
    expect(s?.sql).toContain('series_id');
    expect(s?.sql).toContain('t_series');
    expect(s?.sql).not.toContain('r_series_work');
    expect(s?.params).toContain('○○シリーズ 第2章');
  });

  it('series 通配符 → LIKE 模糊', () => {
    const s = compile('series:ワイルド*');
    expect(s?.sql).toContain('LIKE');
    expect(s?.params[0]).toBe('ワイルド%');
  });

  it('通配符 * ? 翻译为 LIKE % _，字面 _ 被转义', () => {
    // 注：liqe 文法 unquoted 值不允许 % 与 \（见 grammar.ne unquoted_value 字符类），
    // 通配路径下唯一可能出现的字面通配字符是 _，此处覆盖
    const s = compile('tag:*催_眠?');
    expect(s?.sql).toContain('LIKE');
    expect(s?.sql).toContain('ESCAPE');
    // * → %，字面 _ 前加转义反斜杠，? → _
    expect(s?.params[0]).toBe('%催\\_眠_');
  });

  it('age:r18 → 等值', () => {
    const s = compile('age:r18');
    expect(s?.sql).toContain('=');
    expect(s?.params).toContain('r18');
  });

  it('age 值大小写不敏感', () => {
    const s = compile('age:R18');
    expect(s?.params).toContain('r18');
  });

  it('quoted 值含通配符仍走精确 eq（引号内不解析通配）', () => {
    const s = compile('tag:"标*签"');
    expect(s?.sql).toContain('=');
    expect(s?.sql).not.toContain('LIKE');
    expect(s?.params).toContain('标*签');
  });
});

describe('compileQuery：布尔组合', () => {
  it('隐式 AND / OR / NOT', () => {
    const and = compile('tag:a tag:b');
    expect(and?.sql).toContain('AND');
    const or = compile('tag:a OR tag:b');
    expect(or?.sql).toContain('OR');
    const not = compile('-tag:a');
    expect(not?.sql).toContain('NOT');
  });

  it('括号分组解包', () => {
    const s = compile('(tag:a OR tag:b) circle:x');
    expect(s?.sql).toContain('AND');
    expect(s?.sql).toContain('OR');
  });
});

describe('compileQuery：裸词', () => {
  it('自由文本 → 五字段 LIKE OR', () => {
    const s = compile('催眠');
    expect(s?.sql).toContain('LIKE');
    // drizzle 的 or() 渲染为小写 " or "，此处做大小写不敏感匹配
    expect(s?.sql).toMatch(/\bor\b/i);
    expect(s?.sql.match(/LIKE/g)?.length).toBeGreaterThanOrEqual(5);
  });

  it('RJ 号裸词 → id 等值', () => {
    const s = compile('RJ01234567');
    expect(s?.params).toContain('RJ01234567');
    expect(s?.sql).not.toContain('LIKE');
  });

  it('VJ 号裸词按 id 精确匹配', () => {
    const s = compile('VJ01003042');
    expect(s?.params).toContain('VJ01003042');
  });

  it('裸词中的字面 _ 被转义（% \\ 无法出现在 unquoted 裸词中）', () => {
    const s = compile('a_b');
    expect(s?.params[0]).toBe('%a\\_b%');
  });
});

describe('compileQuery：不支持构造 → QueryParseError', () => {
  it.each([
    ['price:100', '不支持的筛选字段 "price"'],
    ['tag.name:x', '不支持的筛选字段'],
    ['tag:<5', '暂不支持比较运算符'],
    ['price:[100 TO 500]', '不支持的筛选字段 "price"'],
    ['tag:/催.眠/', '暂不支持正则'],
    ['tag:', '缺少值'],
    ['age:xxx', 'all/r15/r18'],
    ['nsfw:true', '不支持的筛选字段 "nsfw"'],
    ['tag:123', '需要文本值'],
    ['true', '不支持的查询词'],
  ])('%s → %s', (q, fragment) => {
    const ast: LiqeQuery = parseQuery(q);
    expect(() => compileQuery(ast)).toThrow(QueryParseError);
    try {
      compileQuery(ast);
    } catch (err) {
      expect((err as Error).message).toContain(fragment);
    }
  });
});

describe('compileQuery：空查询', () => {
  it('EmptyExpression → undefined（无筛选）', () => {
    const ast: LiqeQuery = parseQuery('()');
    expect(compileQuery(ast)).toBeUndefined();
  });
});

describe('compileQuery：overridden 覆盖探针', () => {
  it('overridden:title → EXISTS 主行 title 非空', () => {
    const s = compile('overridden:title');
    expect(s?.sql).toContain('EXISTS');
    expect(s?.sql).toContain('t_work_meta_override');
    expect(s?.sql).toContain('title IS NOT NULL');
  });

  it('overridden:any → EXISTS 主行存在（prune 保证存在即有覆盖）', () => {
    const s = compile('overridden:any');
    expect(s?.sql).toContain('EXISTS');
    expect(s?.sql).toContain('t_work_meta_override');
    expect(s?.sql).not.toContain('IS NOT NULL');
  });

  it('-overridden:title → NOT 包裹（否定零改动）', () => {
    const s = compile('-overridden:title');
    expect(s?.sql).toContain('NOT');
  });

  it('非法值 → QueryParseError', () => {
    expect(() => compile('overridden:vas')).toThrow(QueryParseError);
  });
});
