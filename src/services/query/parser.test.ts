import { describe, expect, it } from 'bun:test';
import { parseQuery, QueryParseError } from './parser';

describe('parseQuery', () => {
  it('合法查询返回 AST', () => {
    const ast = parseQuery('tag:标签 circle:"社 团"');
    expect(ast.type).toBe('LogicalExpression');
  });

  it('裸词查询返回 ImplicitField Tag', () => {
    const ast = parseQuery('标签') as { type: string; field: { type: string } };
    expect(ast.type).toBe('Tag');
    expect(ast.field.type).toBe('ImplicitField');
  });

  it('通配符值保留在 literal 中', () => {
    const ast = parseQuery('tag:*标签*') as {
      expression: { value: string };
    };
    expect(ast.expression.value).toBe('*标签*');
  });

  it('语法错误抛 QueryParseError（含行列信息）', () => {
    expect(() => parseQuery('tag:!!!')).toThrow(QueryParseError);
    try {
      parseQuery('tag:!!!');
    } catch (err) {
      const msg = (err as Error).message;
      expect(msg).toContain('查询语法错误');
      expect(msg).toMatch(/第\d+行第\d+列/);
    }
  });
});
