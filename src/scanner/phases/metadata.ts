// metadata 阶段执行体：workSync 三分支的拆入（spec §4）。
// dlsite = DLsite 抓取 + upsert；manual = 本地推导 + unknown 社团（零网络）；
// moved = 仅改路径。封面/音轨不在本阶段（cover/track 阶段独立负责）。
// 失败即抛错（failurePolicy = fail-pipeline，未入库无从后续）。

import { db } from '../../infra/db/main/index.js';
import { circles } from '../../infra/db/main/schema.js';
import { fetchDLsiteWorkInfo } from '../../infra/scraper/dlsite.js';
import { workSourceResolver } from '../../infra/sources/index.js';
import { deriveManualTitle } from '../../infra/sources/manual.js';
import { updateWorkDir, upsertWork } from '../../services/work.service.js';
import type {
  PhaseContext,
  PhaseExecutor,
  PhaseResult,
} from '../taskSystem.js';

function assertAlive(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
}

/** 完成日志（对齐现状 runWorkTask 尾部：created → Added，否则 Updated；moved 无 title）。 */
function logOutcome(
  log: PhaseContext['log'],
  workId: string,
  result: PhaseResult,
): void {
  if (result.created) {
    log('info', `Added: ${workId} - ${result.title ?? ''}`);
  } else {
    log(
      'info',
      result.title
        ? `Updated: ${workId} - ${result.title}`
        : `Updated: ${workId}`,
    );
  }
}

async function syncDlsiteMetadata(ctx: PhaseContext): Promise<PhaseResult> {
  const { workId, location, signal, log } = ctx;
  assertAlive(signal);
  if (!location)
    throw new Error(`metadata phase requires location for ${workId}`);

  log('info', `Fetching metadata for ${workId}...`);
  const metadata = await fetchDLsiteWorkInfo(workId, signal);
  log('info', `Got metadata: ${metadata.title}`);

  const result = await upsertWork({
    id: workId,
    rootFolder: location.rootFolder,
    dir: location.relativePath,
    title: metadata.title,
    circleName: metadata.circle || 'Unknown',
    circleId: metadata.circleId || undefined,
    ageRating: metadata.ageRating,
    release: metadata.releaseDate || undefined,
    dlCount: metadata.dlCount || undefined,
    price: metadata.price || undefined,
    reviewCount: metadata.reviewCount || undefined,
    rateAverage2dp: metadata.rateAverage || undefined,
    rateCountDetail:
      Object.keys(metadata.rateCountDetail).length > 0
        ? metadata.rateCountDetail
        : undefined,
    rank: metadata.rank.length > 0 ? metadata.rank : undefined,
    tags: metadata.tags,
    vas: metadata.vas,
    series: metadata.series,
    language: metadata.language || undefined,
    sourceId: metadata.sourceId || undefined,
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to save work');
  }

  const out = { title: metadata.title, created: result.created };
  logOutcome(log, workId, out);
  return out;
}

async function syncManualMetadata(ctx: PhaseContext): Promise<PhaseResult> {
  const { workId, location, signal, log } = ctx;
  assertAlive(signal);
  if (!location)
    throw new Error(`metadata phase requires location for ${workId}`);

  // 标题全部本地推导：去掉作品代码后的剩余部分，不访问任何远端
  const title = deriveManualTitle(location.dirName ?? '', workId);
  log('info', `Manual work ${workId}: ${title}`);

  // unknown 占位社团行（镜像 migration/kikoeru.ts 的 unknown 兜底），幂等
  await db
    .insert(circles)
    .values({ id: 'unknown', name: 'unknown' })
    .onConflictDoNothing();

  const result = await upsertWork({
    id: workId,
    title,
    rootFolder: location.rootFolder,
    dir: location.relativePath,
    circleName: 'unknown',
    circleId: 'unknown',
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to save work');
  }

  const out = { title, created: result.created };
  logOutcome(log, workId, out);
  return out;
}

async function syncMovedMetadata(ctx: PhaseContext): Promise<PhaseResult> {
  const { workId, location, signal, log } = ctx;
  assertAlive(signal);
  if (!location)
    throw new Error(`metadata phase requires location for ${workId}`);

  const ok = await updateWorkDir(
    workId,
    location.rootFolder,
    location.relativePath,
  );
  if (!ok) {
    throw new Error(`Moved work not found in database: ${workId}`);
  }
  log('info', `Moved: ${workId} -> ${location.relativePath}`);

  // created 恒为 false（作品已在库，计数归 updated）；完成日志不带 title
  const out: PhaseResult = { created: false };
  logOutcome(log, workId, out);
  return out;
}

export const metadataExecutor: PhaseExecutor = async (ctx) => {
  if (ctx.variant === 'moved') return syncMovedMetadata(ctx);
  if (workSourceResolver.classify(ctx.workId) === 'manual')
    return syncManualMetadata(ctx);
  return syncDlsiteMetadata(ctx);
};
