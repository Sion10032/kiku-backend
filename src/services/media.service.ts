import { getConfig } from '../infra/config/index.js';
import { openWorkSource, type WorkSource } from '../infra/fs/source/index.js';
import { sanitizeMediaIndex } from '../infra/fs/source/types.js';
import { getWorkById } from './work.service.js';

/** 解析 media index 路径 → WorkSource；失败返回 null（调用方应 404）。
 *  getWorkById 的异常向外传播（作品不存在时 route 映射 404）。 */
export async function openWorkMedia(
  id: string,
  index: string,
): Promise<WorkSource | null> {
  if (!sanitizeMediaIndex(index)) return null;
  const config = getConfig();
  const work = await getWorkById(id);
  const rootFolder = config.rootFolders.find((f) => f.name === work.rootFolder);
  if (!rootFolder) return null;
  return openWorkSource(rootFolder.path, work.dir);
}
