import {
  collectAudioLeaves,
  probeDuration,
  probeTrackSizes,
} from '../infra/fs/probe.js';
import type { WorkSource } from '../infra/fs/source/types.js';
import type { TrackNode } from '../infra/fs/utils.js';
import {
  computeWorkLoudness,
  deleteTrackRows,
  getTrackRows,
  planTrackSync,
  upsertTrackRow,
} from '../services/track.service.js';

/**
 * 音轨行同步（对齐封面回填的静默模式）：
 * size diff → 仅对新增/变更条目探测时长 → upsert/delete。
 * 变更条目 revalidate=true → 清空该轨响度（内容变了）。
 * 任何变更后重算作品级响度。探测失败 durationSec=null 不阻塞。
 */
export async function syncWorkTracks(
  workId: string,
  source: WorkSource,
  tree: TrackNode[],
): Promise<{ added: number; updated: number; removed: number }> {
  const leaves = await probeTrackSizes(source, collectAudioLeaves(tree));
  const plan = planTrackSync(leaves, await getTrackRows(workId));
  let touched = false;

  for (const t of plan.toUpsert) {
    const durationSec = await probeDuration(source, t.mediaIndex);
    await upsertTrackRow(
      {
        workId,
        mediaIndex: t.mediaIndex,
        title: t.title,
        sizeBytes: t.sizeBytes,
        durationSec,
      },
      { resetLoudness: t.revalidate },
    );
    touched = true;
  }
  if (plan.toDelete.length > 0) {
    await deleteTrackRows(workId, plan.toDelete);
    touched = true;
  }
  if (touched) await computeWorkLoudness(workId);

  return {
    added: plan.toUpsert.filter((t) => !t.revalidate).length,
    updated: plan.toUpsert.filter((t) => t.revalidate).length,
    removed: plan.toDelete.length,
  };
}
