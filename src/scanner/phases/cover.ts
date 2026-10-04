// cover 阶段执行体：缺失封面补齐（dlsite/moved/补图）与 manual 本地导入。
// 容错对齐现状：单个类型失败（404 等）仅记 warning，不抛错——封面缺失不判任务失败
//（failurePolicy warn-continue 仅为意外抛错的第二道防线）。

import { eq } from 'drizzle-orm';
import { db } from '../../infra/db/main/index.js';
import { works } from '../../infra/db/main/schema.js';
import { workSourceResolver } from '../../infra/sources/index.js';
import {
  downloadCover,
  existingCoverTypes,
  importLocalCover,
} from '../../services/cover.service.js';
import { SCAN_COVER_TYPES } from '../scanEvents.js';
import type { PhaseContext, PhaseExecutor, PhaseResult } from './types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** DB 既有 sourceId（metadata 阶段已入库；moved/补图场景同样适用）。 */
async function lookupSourceId(workId: string): Promise<string | undefined> {
  const row = await db
    .select({ sourceId: works.sourceId })
    .from(works)
    .where(eq(works.id, workId));
  return row[0]?.sourceId ?? undefined;
}

async function importLocalCoverFor(ctx: PhaseContext): Promise<PhaseResult> {
  const { workId, log } = ctx;
  try {
    const imported = await importLocalCover(workId, ctx.location?.absDir ?? '');
    if (imported) {
      log('info', `Local cover imported for ${workId}`);
    } else {
      log('warning', `No local cover found for ${workId}`);
    }
  } catch (err) {
    log(
      'warning',
      `Error importing local cover for ${workId}: ${errMessage(err)}`,
    );
  }
  return {};
}

async function downloadMissingCovers(ctx: PhaseContext): Promise<PhaseResult> {
  const { workId, signal, log } = ctx;
  let sourceId: string | undefined;
  try {
    sourceId = await lookupSourceId(workId);
  } catch (err) {
    log('warning', `Source id lookup failed for ${workId}: ${errMessage(err)}`);
  }

  // 单作品一条 IN 查询判定缺失（existingCoverTypes）——比逐类型 blobExists 少往返，
  // 比 listCoverKeys 全库拉取窄
  const existing = existingCoverTypes(workId, [...SCAN_COVER_TYPES]);
  for (const type of SCAN_COVER_TYPES) {
    if (existing.has(type)) continue;
    log(
      'info',
      `Downloading cover ${type} for ${workId} (source: ${sourceId ?? workId})...`,
    );
    try {
      const success = await downloadCover(workId, type, signal, sourceId);
      if (success) {
        log('info', `Cover ${type} downloaded for ${workId}`);
      } else {
        log('warning', `Failed to download cover ${type} for ${workId}`);
      }
    } catch (err) {
      log(
        'warning',
        `Error downloading cover ${type} for ${workId}: ${errMessage(err)}`,
      );
    }
  }
  return {};
}

export const coverExecutor: PhaseExecutor = async (ctx) => {
  if (workSourceResolver.classify(ctx.workId) === 'manual')
    return importLocalCoverFor(ctx);
  return downloadMissingCovers(ctx);
};
