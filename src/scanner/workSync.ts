import { db } from '../infra/db/main/index.js';
import { circles } from '../infra/db/main/schema.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import { fetchDLsiteWorkInfo } from '../infra/scraper/dlsite.js';
import { workSourceResolver } from '../infra/sources/index.js';
import { deriveManualTitle } from '../infra/sources/manual.js';
import {
  coverExists,
  downloadCover,
  importLocalCover,
} from '../services/cover.service.js';
import { getRootFolderPathByName } from '../services/rootFolder.service.js';
import { updateWorkDir, upsertWork } from '../services/work.service.js';
import {
  emitLog,
  logEvent,
  SCAN_COVER_TYPES,
  type ScanEvent,
  type ScanTask,
  stripTask,
} from './scanEvents.js';
import { syncWorkTracks } from './trackSync.js';

/**
 * 抓取并持久化单个作品的 DLsite 元数据（upsert + 补缺失封面）。
 * scan 与 update 两种模式共用；yield 事件流（日志即时推送），
 * return 值携带结果供调用方计数；失败时抛错，由调用方记 failed task。
 */
export async function* syncWorkMetadata(
  rjCode: string,
  rootFolder: string,
  relativePath: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  yield* emitLog('info', `Fetching metadata for ${rjCode}...`);

  // Fetch metadata from DLsite
  const metadata = await fetchDLsiteWorkInfo(rjCode, signal);

  yield* emitLog('info', `Got metadata: ${metadata.title}`);

  // Write to database (dir = relativePath, not dirName)
  const result = await upsertWork({
    id: rjCode,
    rootFolder,
    dir: relativePath,
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

  // 下载封面（如果不存在）
  // 使用 sourceId（未翻译版本）下载封面，如果不存在则使用当前 ID
  const coverSourceId = metadata.sourceId || rjCode;
  for (const type of SCAN_COVER_TYPES) {
    if (!coverExists(rjCode, type)) {
      yield* emitLog(
        'info',
        `Downloading cover ${type} for ${rjCode} (source: ${coverSourceId})...`,
      );

      try {
        const success = await downloadCover(
          rjCode,
          type,
          signal,
          coverSourceId,
        );
        if (success) {
          yield* emitLog('info', `Cover ${type} downloaded for ${rjCode}`);
        } else {
          yield* emitLog(
            'warning',
            `Failed to download cover ${type} for ${rjCode}`,
          );
        }
      } catch (coverErr) {
        yield* emitLog(
          'warning',
          `Error downloading cover ${type} for ${rjCode}: ${String(coverErr)}`,
        );
      }
    }
  }

  return { title: metadata.title, created: result.created };
}

/**
 * 手动作品（非 DLsite）元数据同步：与 syncWorkMetadata 同构的 AsyncGenerator，
 * 但全程零网络——标题由目录名推导（deriveManualTitle），社团落 unknown 占位行，
 * 封面只从作品目录导入本地图片（importLocalCover）。
 * 音轨回填镜像 syncWorkMetadataAndTracks 的 syncWorkTracks 部分。
 */
export async function* syncManualWorkMetadata(
  workCode: string,
  rootFolder: string,
  relativePath: string,
  folderName: string,
  absDir: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');

  // 标题全部本地推导：去掉作品代码后的剩余部分，不访问任何远端
  const title = deriveManualTitle(folderName, workCode);
  yield* emitLog('info', `Manual work ${workCode}: ${title}`);

  // unknown 占位社团行（镜像 migration/kikoeru.ts 的 unknown 兜底），幂等
  await db
    .insert(circles)
    .values({ id: 'unknown', name: 'unknown' })
    .onConflictDoNothing();

  const result = await upsertWork({
    id: workCode,
    title,
    rootFolder,
    dir: relativePath,
    circleName: 'unknown',
    circleId: 'unknown',
  });

  if (!result.success) {
    throw new Error(result.error || 'Failed to save work');
  }

  // 本地封面导入（cover.* / folder.*；目录无图片则静默跳过，不判任务失败）
  try {
    const imported = await importLocalCover(workCode, absDir);
    if (imported) {
      yield* emitLog('info', `Local cover imported for ${workCode}`);
    } else {
      yield* emitLog('warning', `No local cover found for ${workCode}`);
    }
  } catch (coverErr) {
    yield* emitLog(
      'warning',
      `Error importing local cover for ${workCode}: ${String(coverErr)}`,
    );
  }

  // 音轨行回填（镜像 syncWorkMetadataAndTracks）：失败仅记 warning，不判任务失败
  try {
    const rootPath = await getRootFolderPathByName(rootFolder);
    if (!rootPath) {
      yield* emitLog(
        'warning',
        `Track sync skipped, root folder not found: ${rootFolder}`,
      );
    } else {
      const source = await openWorkSource(rootPath, relativePath);
      await syncWorkTracks(workCode, source, await source.buildTree());
    }
  } catch (err) {
    yield* emitLog(
      'warning',
      `Track sync failed for ${workCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { title, created: result.created };
}

/**
 * 单作品完整同步：DLsite 元数据（upsert + 补封面）+ 音轨时长 diff 回填。
 * scan 任务分支与 update 模式共用的动作集合；音轨同步失败仅记 warning 日志，
 * 不判任务失败（DLsite 元数据已保存）。
 */
async function* syncWorkMetadataAndTracks(
  rjCode: string,
  rootFolder: string,
  relativePath: string,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  const metaGen = syncWorkMetadata(rjCode, rootFolder, relativePath, signal);
  let r = await metaGen.next();
  while (!r.done) {
    yield r.value;
    r = await metaGen.next();
  }

  // 音轨行回填：size diff → 仅对新增/变更条目探测时长；失败不判任务失败
  try {
    const rootPath = await getRootFolderPathByName(rootFolder);
    if (!rootPath) {
      yield* emitLog(
        'warning',
        `Track sync skipped, root folder not found: ${rootFolder}`,
      );
    } else {
      const source = await openWorkSource(rootPath, relativePath);
      await syncWorkTracks(rjCode, source, await source.buildTree());
    }
  } catch (err) {
    yield* emitLog(
      'warning',
      `Track sync failed for ${rjCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return r.value;
}

/**
 * moved 任务同步（仅路径变更，DB 已有未软删记录）：
 * 跳过 DLsite 元数据抓取（元数据已在库且 ID 未变），
 * 仅更新路径 + 按需补封面（用 DB 既有 sourceId）+ 音轨 diff。
 * 音轨同步失败仅记 warning，不判任务失败（对齐 syncWorkMetadataAndTracks）。
 * created 恒为 false（作品已在库，计数归 updated）。
 */
async function* syncMovedWork(
  task: ScanTask,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent, { title: string; created: boolean }> {
  if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
  const ok = await updateWorkDir(
    task.workCode,
    task.rootFolder,
    task.relativePath,
  );
  if (!ok) {
    throw new Error(`Moved work not found in database: ${task.workCode}`);
  }
  yield logEvent('info', `Moved: ${task.workCode} -> ${task.relativePath}`);

  // 封面校验补齐（缺失才下载；downloadCover 内部容错，404 等失败静默）
  for (const type of SCAN_COVER_TYPES) {
    if (!coverExists(task.workCode, type)) {
      await downloadCover(task.workCode, type, signal, task.knownSourceId);
    }
  }

  // 音轨同步：形态变化后 diff（zip 的 stripCommonTopDir 保证 mediaIndex
  // 通常与文件夹时代一致 → 零变更零探测，但必须跑以防打包有损）
  try {
    const rootPath = await getRootFolderPathByName(task.rootFolder);
    if (!rootPath) {
      yield logEvent(
        'warning',
        `Track sync skipped, root folder not found: ${task.rootFolder}`,
      );
    } else {
      const source = await openWorkSource(rootPath, task.relativePath);
      await syncWorkTracks(task.workCode, source, await source.buildTree());
    }
  } catch (err) {
    yield logEvent(
      'warning',
      `Track sync failed for ${task.workCode}: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  return { title: '', created: false };
}

/**
 * 单任务执行体（并发池 worker 调用）：DLsite 元数据 + 音轨同步，
 * 完成事件缓冲为整组返回（终态 + 日志；排队/开始状态由池在提交时即时推送）。
 * created 缺省表示任务失败（错误已写入 task.error 并包含在事件里）；
 * added/updated/failed 计数由调用方按返回值累计。
 */
export async function runWorkTask(
  task: ScanTask,
  signal: AbortSignal,
): Promise<{ events: ScanEvent[]; created?: boolean }> {
  const events: ScanEvent[] = [];

  try {
    // moved（仅路径变更）跳过元数据抓取；手动作品走本地同步分支（零网络），
    // 其余走 DLsite 抓取。
    const gen = task.moved
      ? syncMovedWork(task, signal)
      : workSourceResolver.classify(task.workCode) === 'manual'
        ? syncManualWorkMetadata(
            task.workCode,
            task.rootFolder,
            task.relativePath,
            task.dirName,
            task.absDir ?? '',
            signal,
          )
        : syncWorkMetadataAndTracks(
            task.workCode,
            task.rootFolder,
            task.relativePath,
            signal,
          );
    let r = await gen.next();
    while (!r.done) {
      events.push(r.value);
      r = await gen.next();
    }
    const { title, created } = r.value;
    if (created) {
      events.push(logEvent('info', `Added: ${task.workCode} - ${title}`));
    } else {
      // moved 任务不重抓元数据，完成日志不带 title
      events.push(
        logEvent(
          'info',
          title
            ? `Updated: ${task.workCode} - ${title}`
            : `Updated: ${task.workCode}`,
        ),
      );
    }

    task.status = 'completed';
    events.push({ type: 'SCAN_TASK', task: stripTask(task) });
    return { events, created };
  } catch (err) {
    task.status = 'failed';
    const errMsg = err instanceof Error ? err.message : String(err);
    task.error = errMsg;
    events.push(logEvent('error', `Failed: ${task.title} - ${errMsg}`));
    events.push({ type: 'SCAN_TASK', task: stripTask(task) });
    return { events };
  }
}
