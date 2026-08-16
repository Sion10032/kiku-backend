import { getConfig } from '../config/index.js';
import { retryFetch } from '../scraper/client.js';
import { existsSync, mkdirSync, createWriteStream, statSync, unlinkSync } from 'fs';
import { join } from 'path';

/**
 * 封面图片类型
 */
export type CoverType = 'main' | 'sam' | '240x240' | '360x360';

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
  const groupId = (numId % groupCount === 0) ? numId : Math.floor(numId / groupCount) * groupCount + groupCount;
  const groupRJCode = 'RJ' + groupId.toString().padStart(codeLength, '0');

  const url = type === '240x240' || type === '360x360'
    ? `https://img.dlsite.jp/resize/images2/work/doujin/${groupRJCode}/${rjcode}_img_main_${type}.jpg`
    : `https://img.dlsite.jp/modpub/images2/work/doujin/${groupRJCode}/${rjcode}_img_${type}.jpg`;

  return url;
}

/**
 * 获取封面文件路径
 * @param id 作品ID
 * @param type 封面类型
 * @returns 封面文件的完整路径
 */
function getCoverPath(id: string, type: CoverType): string {
  const config = getConfig();
  const coverDir = resolveCoverDir(config.coverFolderDir);

  // 确保封面目录存在
  if (!existsSync(coverDir)) {
    mkdirSync(coverDir, { recursive: true });
  }

  const rjcode = id.replace(/^RJ/, '').padStart(6, '0');
  return join(coverDir, `RJ${rjcode}_img_${type}.jpg`);
}

/**
 * 解析封面目录路径（相对于工作目录）
 * @param coverDir 配置中的封面目录路径
 * @returns 解析后的绝对路径
 */
function resolveCoverDir(coverDir: string): string {
  // 如果是绝对路径，直接返回
  if (coverDir.startsWith('/')) {
    return coverDir;
  }

  // 相对于工作目录
  const workDir = process.env.WORK_DIR || process.cwd();
  return join(workDir, coverDir);
}

/**
 * 下载封面图片并保存到磁盘
 * @param id 作品ID（用于保存文件名）
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
    const filePath = getCoverPath(id, type);

    // 如果文件已存在，跳过下载
    if (existsSync(filePath)) {
      const stat = statSync(filePath);
      if (stat.size > 0) {
        return true;
      }
    }

    console.log(`Downloading cover: ${url}`);

    const response = await retryFetch(url, {
      externalSignal: signal,
      timeout: 30000, // 30秒超时
    });

    if (!response.ok) {
      console.error(`Failed to download cover: ${response.status} ${response.statusText}`);
      return false;
    }

    // 检查内容类型
    const contentType = response.headers.get('content-type');
    if (contentType && !contentType.includes('image/')) {
      console.error(`Invalid content type: ${contentType}`);
      return false;
    }

    // 保存到文件
    const fileStream = createWriteStream(filePath);

    // 将响应体写入文件
    if (response.body) {
      const reader = response.body.getReader();

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        fileStream.write(value);
      }
    }

    fileStream.end();

    // 等待文件写入完成
    await new Promise<void>((resolve, reject) => {
      fileStream.on('finish', resolve);
      fileStream.on('error', reject);
    });

    console.log(`Cover saved: ${filePath}`);
    return true;
  }
  catch (error) {
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
  const types: CoverType[] = [ 'main', 'sam', '240x240', '360x360' ];
  const results: Record<CoverType, boolean> = {
    'main': false,
    'sam': false,
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
  const filePath = getCoverPath(id, type);
  return existsSync(filePath);
}

/**
 * 获取封面文件路径（如果存在）
 * @param id 作品ID
 * @param type 封面类型
 * @returns 封面文件路径，如果不存在则返回null
 */
export function getCoverFilePath(id: string, type: CoverType = 'main'): string | null {
  const filePath = getCoverPath(id, type);
  return existsSync(filePath) ? filePath : null;
}

/**
 * 删除封面文件
 * @param id 作品ID
 * @param type 封面类型
 * @returns 是否成功删除
 */
export function deleteCover(id: string, type: CoverType): boolean {
  try {
    const filePath = getCoverPath(id, type);
    if (existsSync(filePath)) {
      unlinkSync(filePath);
      return true;
    }
    return false;
  }
  catch (error) {
    console.error(`Error deleting cover for ${id}:`, error);
    return false;
  }
}

/**
 * 删除作品的所有封面
 * @param id 作品ID
 * @returns 删除的封面数量
 */
export function deleteAllCovers(id: string): number {
  const types: CoverType[] = [ 'main', 'sam', '240x240', '360x360' ];
  let count = 0;

  for (const type of types) {
    if (deleteCover(id, type)) {
      count++;
    }
  }

  return count;
}
