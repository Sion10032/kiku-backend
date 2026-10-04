// track 阶段执行体：音轨行 diff 回填（syncWorkTracks 封装）。
// 容错对齐现状：root 不存在或探测失败仅记 warning，不抛错——音轨失败不判任务失败
//（failurePolicy warn-continue 仅为意外抛错的第二道防线）。

import { openWorkSource } from '../../infra/fs/source/index.js';
import { getRootFolderPathByName } from '../../services/rootFolder.service.js';
import { syncWorkTracks } from '../trackSync.js';
import type { PhaseExecutor } from './types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

export const trackExecutor: PhaseExecutor = async (ctx) => {
  const { workId, location, log } = ctx;
  if (!location) throw new Error(`track phase requires location for ${workId}`);

  try {
    const rootPath = await getRootFolderPathByName(location.rootFolder);
    if (!rootPath) {
      log(
        'warning',
        `Track sync skipped, root folder not found: ${location.rootFolder}`,
      );
      return {};
    }
    const source = await openWorkSource(rootPath, location.relativePath);
    const result = await syncWorkTracks(
      workId,
      source,
      await source.buildTree(),
    );
    if (result.added + result.updated + result.removed > 0) {
      log(
        'info',
        `Tracks synced for ${workId} (+${result.added} ~${result.updated} -${result.removed})`,
      );
    }
    return {};
  } catch (err) {
    log('warning', `Track sync failed for ${workId}: ${errMessage(err)}`);
    return {};
  }
};
