import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { extractRJCode } from '../utils/rjcode.js';
import { collectDirPaths } from './source/folder.js';
import { entriesToTrackTree } from './source/tree.js';

// ---------- collectWorkEntries（替代已删除的 getFolderList） ----------

const ARCHIVE_EXTS = new Set(['.tar', '.zip']);
const UNSUPPORTED_ARCHIVE_EXTS = new Set([
  '.7z',
  '.rar',
  '.tgz',
  '.gz',
  '.xz',
  '.bz2',
  '.zst',
  '.lz4',
  '.lzma',
]);

export interface WorkEntry {
  kind: 'folder' | 'archive' | 'unsupported-archive';
  /** 相对 root folder 的路径，'/' 分隔（文件夹不含尾部斜杠）。 */
  relativePath: string;
  rjCode: string;
  /** 展示名：文件夹名或压缩包完整文件名。 */
  name: string;
}

/**
 * 递归收集 root 下的 RJ 作品条目。
 * 规则：RJ 目录不深入、非 RJ 目录下探一层直至 maxDepth。
 * RJ 命名文件按扩展名分类：tar/zip → archive，其余 → unsupported-archive。
 */
export async function collectWorkEntries(
  rootPath: string,
  maxDepth: number,
  currentDepth = 0,
): Promise<WorkEntry[]> {
  if (currentDepth >= maxDepth) return [];
  const out: WorkEntry[] = [];
  const entries = await readdir(rootPath, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    const rj = extractRJCode(entry.name);
    if (entry.isDirectory()) {
      if (rj) {
        out.push({
          kind: 'folder',
          relativePath: entry.name,
          rjCode: rj,
          name: entry.name,
        });
      } else {
        const nested = await collectWorkEntries(
          join(rootPath, entry.name),
          maxDepth,
          currentDepth + 1,
        );
        out.push(
          ...nested.map((n) => ({
            ...n,
            relativePath: `${entry.name}/${n.relativePath}`,
          })),
        );
      }
    } else if (entry.isFile() && rj) {
      const ext = extname(entry.name).toLowerCase();
      if (ARCHIVE_EXTS.has(ext)) {
        out.push({
          kind: 'archive',
          relativePath: entry.name,
          rjCode: rj,
          name: entry.name,
        });
      } else if (UNSUPPORTED_ARCHIVE_EXTS.has(ext)) {
        out.push({
          kind: 'unsupported-archive',
          relativePath: entry.name,
          rjCode: rj,
          name: entry.name,
        });
      }
      // 其他扩展名（RJ123.jpg 等）忽略
    }
  }
  return out;
}

export type TrackNode =
  | {
      type: 'folder';
      title: string;
      children: TrackNode[];
    }
  | {
      type: 'audio' | 'text' | 'image' | 'other';
      title: string;
      hash: string; // 相对于 work dir 的路径，如 'subfolder/track01.mp3'
    };

/**
 * 构建文件树结构
 * @param dirPath 作品目录的绝对路径
 */
export async function buildTrackTree(dirPath: string): Promise<TrackNode[]> {
  return entriesToTrackTree(await collectDirPaths(dirPath));
}

export function hasLetter(str: string): boolean {
  return /[a-zA-Z]/.test(str);
}

export function nameToUUID(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = (hash << 5) - hash + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
