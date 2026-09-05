import type { Config } from '../infra/config/schema.js';
import { db } from '../infra/db/main/index.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import { syncWorkMetadata } from './scanner.js';
import { syncWorkTracks } from './trackSync.js';

/** 单作品运维操作的结构化失败原因。 */
export type WorkOpFailureReason = 'work-not-found' | 'root-folder-not-found';

/** 音轨同步统计（同 syncWorkTracks 返回值）。 */
export interface TrackSyncStats {
  added: number;
  updated: number;
  removed: number;
}

export type WorkOpResult<T> =
  | ({ ok: true } & T)
  | { ok: false; reason: WorkOpFailureReason };

/** 查作品行定位源目录（含软删行：refresh 经 upsert 幂等复活软删作品）。 */
async function getWorkLocation(
  workId: string,
): Promise<{ rootFolder: string; dir: string } | null> {
  const row = await db.query.works.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, workId) },
    columns: { rootFolder: true, dir: true },
  });
  return row ?? null;
}

function resolveRootPath(config: Config, rootFolder: string): string | null {
  return config.rootFolders.find((f) => f.name === rootFolder)?.path ?? null;
}

/**
 * 单作品「更新元数据」：重抓 DLsite 元数据（upsert + 补缺失封面）+ 音轨时长
 * 同步——对齐 performUpdate 单次迭代的动作集合。日志事件就地丢弃；
 * DLsite 抓取/入库失败时抛错（与扫描任务 failed 语义一致），由路由层映射
 * HTTP 状态。
 */
export async function refreshWorkMetadata(
  workId: string,
  config: Config,
  signal: AbortSignal = new AbortController().signal,
): Promise<WorkOpResult<{ title: string; tracks: TrackSyncStats }>> {
  const location = await getWorkLocation(workId);
  if (!location) return { ok: false, reason: 'work-not-found' };
  const rootPath = resolveRootPath(config, location.rootFolder);
  if (!rootPath) return { ok: false, reason: 'root-folder-not-found' };

  // Drain 元数据事件流；return 值带抓取到的标题
  const gen = syncWorkMetadata(
    workId,
    location.rootFolder,
    location.dir,
    signal,
  );
  let r = await gen.next();
  while (!r.done) r = await gen.next();

  const source = await openWorkSource(rootPath, location.dir);
  const tracks = await syncWorkTracks(workId, source, await source.buildTree());
  return { ok: true, title: r.value.title, tracks };
}

/**
 * 单作品「更新音轨时长」：按磁盘内容 diff 同步音轨行（size 未变不重新探测）。
 */
export async function syncWorkDurations(
  workId: string,
  config: Config,
): Promise<WorkOpResult<{ tracks: TrackSyncStats }>> {
  const location = await getWorkLocation(workId);
  if (!location) return { ok: false, reason: 'work-not-found' };
  const rootPath = resolveRootPath(config, location.rootFolder);
  if (!rootPath) return { ok: false, reason: 'root-folder-not-found' };

  const source = await openWorkSource(rootPath, location.dir);
  const tracks = await syncWorkTracks(workId, source, await source.buildTree());
  return { ok: true, tracks };
}
