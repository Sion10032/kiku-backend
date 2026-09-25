import { openWorkSource, type WorkSource } from '../infra/fs/source/index.js';
import { sanitizeMediaIndex } from '../infra/fs/source/types.js';
import { getRootFolderPathByName } from './rootFolder.service.js';
import { getWorkById } from './work.service.js';

/** 解析 media index 路径 → WorkSource；失败返回 null（调用方应 404）。
 *  getWorkById 的异常向外传播（作品不存在时 route 映射 404）。 */
export async function openWorkMedia(
  id: string,
  index: string,
): Promise<WorkSource | null> {
  if (!sanitizeMediaIndex(index)) return null;
  const work = await getWorkById(id);
  // 路径未配置（迁移遗留）或根目录行不存在 → 调用方 404
  const rootPath = await getRootFolderPathByName(work.rootFolder);
  if (!rootPath) return null;
  return openWorkSource(rootPath, work.dir);
}
