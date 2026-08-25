import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { extractRJCode } from '../utils/rjcode.js';
import { entriesToTrackTree, isSupportedFile } from './source/tree.js';

/** @deprecated Task 6 移除 */
export interface FolderInfo {
  path: string;
  rjCode: string | null; // Full RJ code like "RJ01578781"
  dirName: string;
}

/** @deprecated Task 6 移除 */
export async function getFolderList(
  dirPath: string,
  maxDepth: number,
  currentDepth: number = 0,
): Promise<FolderInfo[]> {
  if (currentDepth >= maxDepth) {
    return [];
  }

  const folders: FolderInfo[] = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(dirPath, entry.name);
        const rjCode = extractRJCode(entry.name);

        // If this folder has an RJ code, it's a work folder — don't recurse deeper
        if (rjCode !== null) {
          folders.push({ path: fullPath, rjCode, dirName: entry.name });
        } else {
          // No RJ code — recurse to find work folders inside
          folders.push(
            ...(await getFolderList(fullPath, maxDepth, currentDepth + 1)),
          );
        }
      }
    }
  } catch {
    // Ignore errors (permission denied, etc.)
  }

  return folders;
}

/** @deprecated Task 6 移除 */
export async function getTrackList(
  dirPath: string,
): Promise<Array<{ name: string; path: string; index: number }>> {
  const audioExtensions = ['.mp3', '.ogg', '.wav', '.flac', '.m4a'];
  const tracks: Array<{ name: string; path: string; index: number }> = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });
    let index = 1;

    for (const entry of entries) {
      if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        if (audioExtensions.includes(ext)) {
          tracks.push({
            name: entry.name,
            path: join(dirPath, entry.name),
            index: index++,
          });
        }
      }
    }
  } catch {
    // Ignore errors
  }

  return tracks.sort((a, b) => a.name.localeCompare(b.name));
}

export interface TreeNode {
  type: 'file' | 'folder';
  name: string;
  index?: number;
  children?: TreeNode[];
}

/** @deprecated Task 6 移除 */
export function toTree(
  dirPath: string,
  tracks: Array<{ name: string; path: string; index: number }>,
): TreeNode[] {
  const tree: TreeNode[] = [];
  const folderMap = new Map<string, TreeNode>();

  for (const track of tracks) {
    const relativePath = track.path.replace(dirPath, '').replace(/^\//, '');
    const parts = relativePath.split('/');

    if (parts.length === 1) {
      tree.push({
        type: 'file',
        name: track.name,
        index: track.index,
      });
    } else {
      const folderName = parts[0] ?? '';
      if (folderName && !folderMap.has(folderName)) {
        const folderNode: TreeNode = {
          type: 'folder',
          name: folderName,
          children: [],
        };
        folderMap.set(folderName, folderNode);
        tree.push(folderNode);
      }

      const folder = folderMap.get(folderName);
      if (folder?.children) {
        folder.children.push({
          type: 'file',
          name: track.name,
          index: track.index,
        });
      }
    }
  }

  return tree;
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
 * 递归收集目录下支持扩展名文件的相对路径（'/' 分隔）。
 */
async function collectPaths(
  dirPath: string,
  basePath: string,
): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      paths.push(...(await collectPaths(join(dirPath, entry.name), childBase)));
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      paths.push(basePath ? `${basePath}/${entry.name}` : entry.name);
    }
  }
  return paths;
}

/**
 * 构建文件树结构
 * @param dirPath 作品目录的绝对路径
 */
export async function buildTrackTree(dirPath: string): Promise<TrackNode[]> {
  return entriesToTrackTree(await collectPaths(dirPath, ''));
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
