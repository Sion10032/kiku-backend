import { and, eq, isNull } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { workMetaOverride, works } from '../infra/db/main/schema.js';
import { applyScalarOverrideInTx } from './metadataOverride.service.js';
import { compileQuery } from './query/compiler.js';
import { parseQuery } from './query/parser.js';

/** 正则编译失败（消息来自 RegExp 引擎；灾难性回溯无超时，dryRun 预览先行，风险见计划）。 */
export class InvalidRegexError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvalidRegexError';
  }
}

export type SanitizeTitlesInput = {
  pattern: string;
  replacement: string;
  q?: string;
  dryRun: boolean;
  updatedBy?: string;
};

export type SanitizeTitlesSample = {
  id: string;
  before: string;
  after: string;
  overridden: boolean;
};

export type SanitizeTitlesPreview = {
  matched: number;
  overridden: number;
  samples: SanitizeTitlesSample[];
};

export type SanitizeTitlesResult = {
  success: true;
  matched: number;
  overridden: number;
};

/** samples 上限（全量计数照常返回） */
const SAMPLE_LIMIT = 50;

/**
 * 标题净化（管理员一次性工具，批量正则替换）。
 * - 基准 = original title（t_work.title），不是生效值——避免二次叠加；
 * - 命中即净化（含已有 title 覆盖的作品）：排除/圈定由查询条件
 *   `overridden:title` / `-overridden:title` 表达，`overridden` 计数仅作预览信息；
 * - 替换无变化的作品忽略（不计入 matched、不写覆盖行）；
 * - 真跑在单个事务内循环 applyScalarOverrideInTx（title 必非空 → 主行必有内容，无需 prune）。
 */
export async function sanitizeTitles(
  input: SanitizeTitlesInput,
): Promise<SanitizeTitlesPreview | SanitizeTitlesResult> {
  let regex: RegExp;
  try {
    regex = new RegExp(input.pattern, 'gu');
  } catch (err) {
    throw new InvalidRegexError((err as Error).message);
  }

  const ast = input.q?.trim() ? parseQuery(input.q) : undefined;
  const cond = ast ? compileQuery(ast) : undefined;
  const where = cond
    ? and(cond, isNull(works.deletedAt))
    : isNull(works.deletedAt);

  // 全量候选（绕过分页）：id + original title + 是否已有 title 覆盖
  const rows = await db
    .select({
      id: works.id,
      title: works.title,
      overrideTitle: workMetaOverride.title,
    })
    .from(works)
    .leftJoin(workMetaOverride, eq(workMetaOverride.workId, works.id))
    .where(where)
    .orderBy(works.id);

  const targets: SanitizeTitlesSample[] = [];
  for (const row of rows) {
    const after = row.title.replace(regex, input.replacement);
    if (after === row.title) continue;
    targets.push({
      id: row.id,
      before: row.title,
      after,
      overridden: row.overrideTitle !== null,
    });
  }
  const overridden = targets.filter((t) => t.overridden).length;
  const preview: SanitizeTitlesPreview = {
    matched: targets.length,
    overridden,
    samples: targets.slice(0, SAMPLE_LIMIT),
  };
  if (input.dryRun) return preview;

  // bun:sqlite 同步驱动：事务回调内禁止 await（见 metadataOverride.service.ts 顶部注释）
  db.transaction((tx) => {
    for (const t of targets) {
      applyScalarOverrideInTx(tx, t.id, {
        title: t.after,
        updatedBy: input.updatedBy,
      });
    }
  });

  return {
    success: true,
    matched: preview.matched,
    overridden: preview.overridden,
  };
}
