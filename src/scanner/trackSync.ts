import {
  collectAudioLeaves,
  probeDuration,
  probeTrackSizes,
} from '../infra/fs/probe.js';
import type { WorkSource } from '../infra/fs/source/types.js';
import type { TrackNode } from '../infra/fs/utils.js';
import {
  deleteTrackRows,
  getTrackRows,
  planTrackSync,
  upsertTrackRow,
} from '../services/track.service.js';

/**
 * 音轨行同步：size diff → 仅对新增/变更条目探测时长 → upsert/delete。
 * 挂接点：scan 任务分支与 update 模式共用（scanner.ts
 * syncWorkMetadataAndTracks，新作品入库即时同步），已扫描跳过的作品仍由
 * update 模式统一回填；另有 workOps 单作品运维直接调用。
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
