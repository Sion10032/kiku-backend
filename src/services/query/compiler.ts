import { type AnyColumn, eq, inArray, or, type SQL, sql } from 'drizzle-orm';
import type { LiqeQuery, TagToken } from 'liqe';
import { db } from '../../infra/db/main/index.js';
import type { AgeRating } from '../../infra/db/main/schema.js';
import { circles, series, works } from '../../infra/db/main/schema.js';
import { extractWorkCode } from '../../utils/rjcode.js';
import { QueryParseError } from './parser.js';

const FIELD_WHITELIST = [
  'circle',
  'tag',
  'va',
  'series',
  'age',
  'overridden',
] as const;
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
    case 'ParenthesizedExpression': {
      const inner = compileNode(node.expression, t);
      if (!inner) return undefined;
      return sql`(${inner})`;
    }
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
        ? sql`(${left} AND ${right})`
        : sql`(${left} OR ${right})`;
    }
    case 'Tag':
      return compileTag(node, t);
  }
}

function compileTag(node: TagToken, t: typeof works): SQL | undefined {
  const { field, expression, operator } = node;

  if (field.type === 'Field') {
    if (field.path && field.path.length > 1) {
      // 路径过深并入同一 key：中文统一为「不支持的筛选字段」版本，语义相同
      throw new QueryParseError('errors.query.unsupported-field', {
        field: field.name,
        available: FIELD_WHITELIST.join(', '),
      });
    }
    if (!FIELD_WHITELIST.includes(field.name as FieldName)) {
      throw new QueryParseError('errors.query.unsupported-field', {
        field: field.name,
        available: FIELD_WHITELIST.join(', '),
      });
    }
  }

  if (expression.type === 'EmptyExpression') {
    if (field.type === 'Field') {
      throw new QueryParseError('errors.query.missing-value', {
        field: field.name,
      });
    }
    return undefined;
  }
  if (expression.type === 'RangeExpression') {
    throw new QueryParseError('errors.query.range-unsupported');
  }
  if (expression.type === 'RegexExpression') {
    throw new QueryParseError('errors.query.regex-unsupported');
  }
  // 裸词（ImplicitField）运行时省略 operator，且语义上恒为 ':'，先于运算符检查处理
  if (field.type === 'ImplicitField') return compileBareTerm(expression, t);

  if (operator.operator !== ':' && operator.operator !== ':=') {
    throw new QueryParseError('errors.query.comparison-unsupported', {
      op: operator.operator,
    });
  }

  switch (field.name) {
    case 'circle': {
      const { text, wildcard } = stringValue(expression, 'circle');
      return circleProbe(
        t,
        wildcard ? { like: likePattern(text) } : { exact: text },
      );
    }
    case 'tag': {
      const { text, wildcard } = stringValue(expression, 'tag');
      return relationProbe(
        'tag',
        t,
        wildcard ? { like: likePattern(text) } : { exact: text },
      );
    }
    case 'va': {
      const { text, wildcard } = stringValue(expression, 'va');
      return relationProbe(
        'va',
        t,
        wildcard ? { like: likePattern(text) } : { exact: text },
      );
    }
    case 'series': {
      const { text, wildcard } = stringValue(expression, 'series');
      return seriesProbe(
        t,
        wildcard ? { like: likePattern(text) } : { exact: text },
      );
    }
    case 'age':
      return ageRatingCondition(expression, t);
    case 'overridden':
      return overriddenProbe(expression, t);
  }
}

// ---------- 生效值探针（高频过滤不查视图，编译为 EXISTS 组合；性能结论回填） ----------

/** 名称匹配口径：{ like } 模糊（已含 % 通配的完整模式），{ exact } 精确等值。 */
type NameMatch = { exact: string } | { like: string };

function nameMatch(x: string, m: NameMatch): SQL {
  return 'like' in m
    ? sql`${sql.raw(x)}.name LIKE ${m.like} ESCAPE '\\'`
    : sql`${sql.raw(x)}.name = ${m.exact}`;
}

/**
 * tag/va 生效匹配：
 * 生效 = (原始关系未被屏蔽) OR (覆盖 add 行)
 * 原始关系被屏蔽 = 该作品 tags/vas 被清空 OR 该 (work, 维度) 有 remove 行。
 */
function relationProbe(
  kind: 'tag' | 'va',
  t: typeof works,
  match: NameMatch,
): SQL {
  const rel = kind === 'tag' ? 'r_tag_work' : 'r_va_work';
  const ovr = kind === 'tag' ? 'r_tag_work_override' : 'r_va_work_override';
  const dim = kind === 'tag' ? 't_tag' : 't_va';
  const fk = kind === 'tag' ? 'tag_id' : 'va_id';
  const clearedCol = kind === 'tag' ? 'tags_cleared' : 'vas_cleared';
  return sql`(
    EXISTS (
      SELECT 1 FROM ${sql.raw(rel)} tw
        join ${sql.raw(dim)} x ON x.id = tw.${sql.raw(fk)}
       WHERE tw.work_id = ${t.id} AND ${nameMatch('x', match)}
         AND NOT EXISTS (
           SELECT 1 FROM t_work_meta_override m
            WHERE m.work_id = ${t.id}
              AND (m.${sql.raw(clearedCol)} = 1
               OR EXISTS (
                    SELECT 1 FROM ${sql.raw(ovr)} o
                     WHERE o.work_id = m.work_id
                       AND o.${sql.raw(fk)} = tw.${sql.raw(fk)}
                       AND o.action = 'remove'
                  ))
         )
    ) OR EXISTS (
      SELECT 1 FROM ${sql.raw(ovr)} o
        join ${sql.raw(dim)} x ON x.id = o.${sql.raw(fk)}
       WHERE o.work_id = ${t.id} AND o.action = 'add'
         AND ${nameMatch('x', match)}
    )
  )`;
}

function circleProbe(t: typeof works, match: NameMatch): SQL {
  const baseCond =
    'like' in match
      ? likeSql(circles.name, match.like)
      : eq(circles.name, match.exact);
  return sql`(
    (
      ${inArray(
        t.circleId,
        db.select({ id: circles.id }).from(circles).where(baseCond),
      )}
      AND NOT EXISTS (
        SELECT 1 FROM t_work_meta_override m
         WHERE m.work_id = ${t.id} AND m.circle_id IS NOT NULL
      )
    ) OR EXISTS (
      SELECT 1 FROM t_work_meta_override m
        join t_circle c ON c.id = m.circle_id
       WHERE m.work_id = ${t.id} AND ${nameMatch('c', match)}
    )
  )`;
}

function seriesProbe(t: typeof works, match: NameMatch): SQL {
  const baseCond =
    'like' in match
      ? likeSql(series.name, match.like)
      : eq(series.name, match.exact);
  return sql`(
    (
      ${inArray(
        t.seriesId,
        db.select({ id: series.id }).from(series).where(baseCond),
      )}
      AND NOT EXISTS (
        SELECT 1 FROM t_work_meta_override m
         WHERE m.work_id = ${t.id} AND m.series_id IS NOT NULL
      )
    ) OR EXISTS (
      SELECT 1 FROM t_work_meta_override m
        join t_series s ON s.id = m.series_id
       WHERE m.work_id = ${t.id} AND ${nameMatch('s', match)}
    )
  )`;
}

function ageRatingProbe(value: AgeRating, t: typeof works): SQL {
  return sql`(
    (
      ${t.ageRating} = ${value}
      AND NOT EXISTS (
        SELECT 1 FROM t_work_meta_override m
         WHERE m.work_id = ${t.id} AND m.age_rating IS NOT NULL
      )
    ) OR EXISTS (
      SELECT 1 FROM t_work_meta_override m
       WHERE m.work_id = ${t.id} AND m.age_rating = ${value}
    )
  )`;
}

/** 覆盖存在性探针：overridden:title|any（否定由外层 UnaryOperator → NOT 表达）。 */
function overriddenProbe(
  expression: TagToken['expression'],
  t: typeof works,
): SQL {
  if (
    expression.type !== 'LiteralExpression' ||
    typeof expression.value !== 'string'
  ) {
    throw new QueryParseError('errors.query.overridden-value');
  }
  const field = expression.value.toLowerCase();
  if (field === 'title') {
    return sql`EXISTS (
      SELECT 1 FROM t_work_meta_override m
       WHERE m.work_id = ${t.id} AND m.title IS NOT NULL
    )`;
  }
  if (field === 'any') {
    // pruneIfEmpty 保证覆盖主行存在即有有效覆盖内容
    return sql`EXISTS (
      SELECT 1 FROM t_work_meta_override m
       WHERE m.work_id = ${t.id}
    )`;
  }
  throw new QueryParseError('errors.query.overridden-value');
}

// ---------- 值提取 ----------

/** 字符串值 + 是否模糊（unquoted 且含 * / ? 才做通配；引号值永远字面） */
function stringValue(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  fieldName: string,
): { text: string; wildcard: boolean } {
  const { value, quoted } = expression;
  if (typeof value === 'boolean' || value === null) {
    throw new QueryParseError('errors.query.text-required', {
      field: fieldName,
    });
  }
  if (typeof value === 'number') {
    throw new QueryParseError('errors.query.text-required-numeric', {
      field: fieldName,
    });
  }
  return { text: value, wildcard: !quoted && /[*?]/.test(value) };
}

function ageRatingCondition(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  t: typeof works,
): SQL {
  if (typeof expression.value !== 'string') {
    throw new QueryParseError('errors.query.age-value');
  }
  const value = expression.value.toLowerCase();
  if (!(['all', 'r15', 'r18'] as const).includes(value as AgeRating)) {
    throw new QueryParseError('errors.query.age-value');
  }
  return ageRatingProbe(value as AgeRating, t);
}

// ---------- 裸词（自由文本） ----------

function compileBareTerm(
  expression: TagToken['expression'] & { type: 'LiteralExpression' },
  t: typeof works,
): SQL {
  const { value } = expression;
  if (value === null) throw new QueryParseError('errors.query.empty-term');
  if (typeof value === 'boolean') {
    throw new QueryParseError('errors.query.unsupported-term', {
      value: String(value),
    });
  }
  const text = String(value);
  const rj = extractWorkCode(text);
  if (rj) return eq(t.id, rj);

  // 裸词含语义：标题用生效值（COALESCE 必须在子查询外——放进子查询内是静默错误）
  const pattern = `%${escapeLike(text)}%`;
  const match: NameMatch = { like: pattern };
  const combined = or(
    sql`COALESCE(
          (SELECT m.title FROM t_work_meta_override m WHERE m.work_id = ${t.id}),
          ${t.title}
        ) LIKE ${pattern} ESCAPE '\\'`,
    likeSql(t.id, pattern),
    circleProbe(t, match),
    relationProbe('tag', t, match),
    relationProbe('va', t, match),
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
