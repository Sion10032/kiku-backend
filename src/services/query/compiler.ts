import { type AnyColumn, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { LiqeQuery, TagToken } from 'liqe';
import { db } from '../../db/main/index.js';
import {
  circles,
  series,
  tags,
  tagWork,
  vas,
  vaWork,
  works,
} from '../../db/main/schema.js';
import { extractRJCode } from '../../utils/rjcode.js';
import { QueryParseError } from './parser.js';

const FIELD_WHITELIST = ['circle', 'tag', 'va', 'series', 'nsfw'] as const;
type FieldName = (typeof FIELD_WHITELIST)[number];

/**
 * liqe AST → drizzle SQL（纯函数，不触库执行；子查询仅构建不运行）。
 * 语义见计划 D2/D3：默认精确、通配符模糊、裸词五字段 LIKE、白名单外 400。
 * 返回 undefined = 查询无实质条件（如空括号）。
 *
 * worksTable：外层 t_work 表引用。默认用 schema 的 works（渲染 "t_work"），
 * 适用于普通 select/count；db.query.*.findMany 的 RAW where 回调中主表被
 * drizzle 别名化（"d0"），此时须传入回调的 t 参数，否则列引用无法解析。
 */
export function compileQuery(
  ast: LiqeQuery,
  worksTable: typeof works = works,
): SQL | undefined {
  return compileNode(ast, worksTable);
}

function compileNode(node: LiqeQuery, t: typeof works): SQL | undefined {
  switch (node.type) {
    case 'EmptyExpression':
      return undefined;
    case 'ParenthesizedExpression':
      return compileNode(node.expression, t);
    case 'UnaryOperator': {
      const inner = compileNode(node.operand, t);
      if (!inner) return undefined;
      return sql`NOT (${inner})`;
    }
    case 'LogicalExpression': {
      const left = compileNode(node.left, t);
      const right = compileNode(node.right, t);
      const op = node.operator.operator; // 'AND' | 'OR'（隐式 AND 同 'AND'）
      if (!left && !right) return undefined;
      if (!left) return right;
      if (!right) return left;
      return op === 'AND'
        ? sql`${left} AND ${right}`
        : sql`${left} OR ${right}`;
    }
    case 'Tag':
      return compileTag(node, t);
  }
}

function compileTag(node: TagToken, t: typeof works): SQL | undefined {
  const { field, expression, operator } = node;

  if (field.type === 'Field') {
    if (field.path && field.path.length > 1) {
      throw new QueryParseError(
        `不支持的字段 "${field.name}"（可用：${FIELD_WHITELIST.join(', ')}）`,
      );
    }
    if (!FIELD_WHITELIST.includes(field.name as FieldName)) {
      throw new QueryParseError(
        `不支持的筛选字段 "${field.name}"（可用：${FIELD_WHITELIST.join(', ')}）`,
      );
    }
  }

  if (expression.type === 'EmptyExpression') {
    if (field.type === 'Field') {
      throw new QueryParseError(`字段 "${field.name}" 缺少值`);
    }
    return undefined;
  }
  if (expression.type === 'RangeExpression') {
    throw new QueryParseError(
      '暂不支持范围查询（如 price:[100 TO 500]），后续版本支持',
    );
  }
  if (expression.type === 'RegexExpression') {
    throw new QueryParseError('暂不支持正则查询');
  }
  // 裸词（ImplicitField）运行时省略 operator，且语义上恒为 ':'，先于运算符检查处理
  if (field.type === 'ImplicitField') return compileBareTerm(expression, t);

  if (operator.operator !== ':' && operator.operator !== ':=') {
    throw new QueryParseError(
      `暂不支持比较运算符 "${operator.operator}:"（数值范围筛选后续版本支持）`,
    );
  }

  switch (field.name) {
    case 'circle':
      return nameCondition(expression, 'circle', (nameCond) =>
        inArray(
          t.circleId,
          db.select({ id: circles.id }).from(circles).where(nameCond),
        ),
      );
    case 'tag':
      return nameCondition(expression, 'tag', (nameCond) =>
        inArray(
          t.id,
          db
            .select({ workId: tagWork.workId })
            .from(tagWork)
            .innerJoin(tags, eq(tagWork.tagId, tags.id))
            .where(nameCond),
        ),
      );
    case 'va':
      return nameCondition(expression, 'va', (nameCond) =>
        inArray(
          t.id,
          db
            .select({ workId: vaWork.workId })
            .from(vaWork)
            .innerJoin(vas, eq(vaWork.vaId, vas.id))
            .where(nameCond),
        ),
      );
    case 'series':
      return nameCondition(expression, 'series', (nameCond) =>
        inArray(
          t.seriesId,
          db.select({ id: series.id }).from(series).where(nameCond),
        ),
      );
    case 'nsfw':
      return nsfwCondition(expression, t);
  }
}

// ---------- 值提取 ----------

/** 字符串值 + 是否模糊（unquoted 且含 * / ? 才做通配；引号值永远字面） */
function stringValue(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  fieldName: string,
): { text: string; wildcard: boolean } {
  const { value, quoted } = expression;
  if (typeof value === 'boolean' || value === null) {
    throw new QueryParseError(`字段 "${fieldName}" 需要文本值`);
  }
  if (typeof value === 'number') {
    throw new QueryParseError(
      `字段 "${fieldName}" 需要文本值（数值筛选后续版本支持）`,
    );
  }
  return { text: value, wildcard: !quoted && /[*?]/.test(value) };
}

function nameCondition(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  fieldName: string,
  wrap: (nameCond: SQL) => SQL,
): SQL {
  const { text, wildcard } = stringValue(expression, fieldName);
  // 精确：等值；模糊：LIKE（字面 % _ \ 转义 + * → %、? → _）
  const cond = wildcard
    ? likeSql(nameColumn(fieldName), likePattern(text))
    : eq(nameColumn(fieldName), text);
  return wrap(cond);
}

function nameColumn(fieldName: string) {
  if (fieldName === 'circle') return circles.name;
  if (fieldName === 'tag') return tags.name;
  if (fieldName === 'series') return series.name;
  return vas.name;
}

function nsfwCondition(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  t: typeof works,
): SQL {
  if (typeof expression.value !== 'boolean') {
    throw new QueryParseError('字段 "nsfw" 需要布尔值（true/false）');
  }
  return eq(t.nsfw, expression.value);
}

// ---------- 裸词（自由文本） ----------

function compileBareTerm(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  t: typeof works,
): SQL {
  const { value } = expression;
  if (value === null) throw new QueryParseError('查询词不能为空');
  if (typeof value === 'boolean') {
    throw new QueryParseError(`不支持的查询词 "${value}"`);
  }
  const text = String(value);
  const rj = extractRJCode(text);
  if (rj) return eq(t.id, rj);

  const pattern = `%${escapeLike(text)}%`;
  const circleIds = db
    .select({ id: circles.id })
    .from(circles)
    .where(likeSql(circles.name, pattern));
  const tagWorkIds = db
    .select({ workId: tagWork.workId })
    .from(tagWork)
    .innerJoin(tags, eq(tagWork.tagId, tags.id))
    .where(likeSql(tags.name, pattern));
  const vaWorkIds = db
    .select({ workId: vaWork.workId })
    .from(vaWork)
    .innerJoin(vas, eq(vaWork.vaId, vas.id))
    .where(likeSql(vas.name, pattern));

  const combined = or(
    likeSql(t.title, pattern),
    likeSql(t.id, pattern),
    inArray(t.circleId, circleIds),
    inArray(t.id, tagWorkIds),
    inArray(t.id, vaWorkIds),
  );
  // biome-ignore lint/style/noNonNullAssertion: drizzle 的 or() 返回 SQL | undefined，RAW where 需要 SQL
  return combined!;
}

// ---------- LIKE 工具 ----------

/** 字面 % _ \ 前加转义反斜杠（ESCAPE '\' 语义）。 */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

/** 用户通配串 → LIKE 模式：先转义字面 % _ \，再翻译 * → %、? → _。 */
function likePattern(value: string): string {
  return escapeLike(value).replace(/\*/g, '%').replace(/\?/g, '_');
}

/** 安全 LIKE（带 ESCAPE 子句）。pattern 为已构造好的完整模式。 */
function likeSql(column: AnyColumn, pattern: string): SQL {
  return sql`${column} LIKE ${pattern} ESCAPE '\\'`;
}
