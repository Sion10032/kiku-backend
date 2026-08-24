import { retryFetch } from '../scraper/client.js';
import { putBlob, getBlob, blobExists, deleteBlob } from '../db/blob/index.js';

/**
 * 封面图片类型
 */
export type CoverType = 'main' | 'sam' | '240x240' | '360x360';

/**
 * 封面在 blob 库中的命名空间
 */
const COVER_NAMESPACE = 'cover';

/**
 * 获取封面图片的URL
 * @param rjcode 作品ID（RJ代码）
 * @param type 封面类型
 * @returns 封面图片的URL
 */
function getCoverUrl(rjcode: string, type: CoverType): string {
  // 从ID中提取数字部分
  const idMatch = rjcode.match(/(\d+)/);
  if (!idMatch) {
    throw new Error(`Invalid work ID: ${rjcode}`);
  }

  const numId = parseInt(idMatch[1]!, 10);

  // 计算用于URL的ID（每1000/10000个一组）
  const codeLength = numId > 999999 ? 8 : 6;
  const groupCount = 1000;
  const groupId =
    numId % groupCount === 0
      ? numId
      : Math.floor(numId / groupCount) * groupCount + groupCount;
  const groupRJCode = 'RJ' + groupId.toString().padStart(codeLength, '0');

  const url =
    type === '240x240' || type === '360x360'
      ? `https://img.dlsite.jp/resize/images2/work/doujin/${groupRJCode}/${rjcode}_img_main_${type}.jpg`
      : `https://img.dlsite.jp/modpub/images2/work/doujin/${groupRJCode}/${rjcode}_img_${type}.jpg`;

  return url;
}

/**
 * 生成封面在 blob 库中的 key（直接使用作品ID，不做规范化）
 * @param id 作品ID
 * @param type 封面类型
 * @returns blob key（如 RJ000007_main）
 */
function getCoverKey(id: string, type: CoverType): string {
  return `${id}_${type}`;
}

/**
 * 下载封面图片并存入 binary.db
 * @param id 作品ID（用作存储 key）
 * @param type 封面类型
 * @param signal 可选的取消信号
 * @param sourceId 未翻译版本的 RJ 号（用于下载封面 URL）
 * @returns 下载是否成功
 */
export async function downloadCover(
  id: string,
  type: CoverType = 'main',
  signal?: AbortSignal,
  sourceId?: string,
): Promise<boolean> {
  try {
    // 使用 sourceId 构建下载 URL，如果未提供则使用 id
    const url = getCoverUrl(sourceId || id, type);
    const key = getCoverKey(id, type);

    // 如果已存储，跳过下载
    if (blobExists(COVER_NAMESPACE, key)) {
      return true;
    }

    console.log(`Downloading cover: ${url}`);

    const response = await retryFetch(url, {
      externalSignal: signal,
      timeout: 30000, // 30秒超时
    });

    if (!response.ok) {
      console.error(
        `Failed to download cover: ${response.status} ${response.statusText}`,
      );
      return false;
    }

    // 检查内容类型
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('image/')) {
      console.error(`Invalid content type: ${contentType}`);
      return false;
    }

    // 封面仅几十~几百 KB，一次性读入后整块入库
    const data = Buffer.from(await response.arrayBuffer());
    putBlob(COVER_NAMESPACE, key, data, contentType ?? undefined);

    console.log(`Cover saved: ${key}`);
    return true;
  } catch (error) {
    // 如果是取消错误，不打印错误信息
    if (error instanceof DOMException && error.name === 'AbortError') {
      return false;
    }

    console.error(`Error downloading cover for ${id}:`, error);
    return false;
  }
}

/**
 * 下载作品的所有封面类型
 * @param id 作品ID
 * @param signal 可选的取消信号
 * @returns 下载结果
 */
export async function downloadAllCovers(
  id: string,
  signal?: AbortSignal,
): Promise<Record<CoverType, boolean>> {
  const types: CoverType[] = ['main', 'sam', '240x240', '360x360'];
  const results: Record<CoverType, boolean> = {
    main: false,
    sam: false,
    '240x240': false,
    '360x360': false,
  };

  // 并行下载所有封面
  const promises = types.map(async (type) => {
    results[type] = await downloadCover(id, type, signal);
  });

  await Promise.all(promises);
  return results;
}

/**
 * 检查封面是否存在
 * @param id 作品ID
 * @param type 封面类型
 * @returns 封面是否存在
 */
export function coverExists(id: string, type: CoverType = 'main'): boolean {
  return blobExists(COVER_NAMESPACE, getCoverKey(id, type));
}

/**
 * 读取封面数据（如果存在）
 * @param id 作品ID
 * @param type 封面类型
 * @returns 封面二进制数据与 MIME，不存在则返回 null
 */
export function getCoverData(
  id: string,
  type: CoverType = 'main',
): { data: Buffer; mimeType: string | null; size: number } | null {
  return getBlob(COVER_NAMESPACE, getCoverKey(id, type));
}

/**
 * 删除封面
 * @param id 作品ID
 * @param type 封面类型
 * @returns 是否成功删除
 */
export function deleteCover(id: string, type: CoverType): boolean {
  return deleteBlob(COVER_NAMESPACE, getCoverKey(id, type));
}

/**
 * 删除作品的所有封面
 * @param id 作品ID
 * @returns 删除的封面数量
 */
export function deleteAllCovers(id: string): number {
  const types: CoverType[] = ['main', 'sam', '240x240', '360x360'];
  let count = 0;

  for (const type of types) {
    if (deleteCover(id, type)) {
      count++;
    }
  }

  return count;
}
