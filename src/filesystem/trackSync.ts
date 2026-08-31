import {
  deleteTrackRows,
  getTrackRows,
  planTrackSync,
  upsertTrackRow,
} from '../services/track.service.js';
import { collectAudioLeaves, probeDuration, probeTrackSizes } from './probe.js';
import type { WorkSource } from './source/types.js';
import type { TrackNode } from './utils.js';

/**
 * 音轨行同步（对齐封面回填的静默模式）：
 * size diff → 仅对新增/变更条目探测时长 → upsert/delete。
 * 变更条目 revalidate=true（本计划仅计入 updated；姊妹计划在该标记上挂响度失效）。
 * 探测失败 durationSec=null 不阻塞。
 */
export async function syncWorkTracks(
  workId: string,
  source: WorkSource,
  tree: TrackNode[],
): Promise<{ added: number; updated: number; removed: number }> {
  const leaves = await probeTrackSizes(source, collectAudioLeaves(tree));
  const plan = planTrackSync(leaves, await getTrackRows(workId));

  for (const t of plan.toUpsert) {
    const durationSec = await probeDuration(source, t.mediaIndex);
    await upsertTrackRow({
      workId,
      mediaIndex: t.mediaIndex,
      title: t.title,
      sizeBytes: t.sizeBytes,
      durationSec,
    });
  }
  await deleteTrackRows(workId, plan.toDelete);

  return {
    added: plan.toUpsert.filter((t) => !t.revalidate).length,
    updated: plan.toUpsert.filter((t) => t.revalidate).length,
    removed: plan.toDelete.length,
  };
}
