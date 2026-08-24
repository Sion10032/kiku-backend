import { readdir } from 'fs/promises';
import { join, extname } from 'path';
import { extractRJCode } from '../utils/rjcode.js';

export interface FolderInfo {
  path: string;
  rjCode: string | null; // Full RJ code like "RJ01578781"
  dirName: string;
}


export async function getFolderList(dirPath: string, maxDepth: number, currentDepth: number = 0): Promise<FolderInfo[]> {
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
        }
        else {
          // No RJ code — recurse to find work folders inside
          folders.push(...await getFolderList(fullPath, maxDepth, currentDepth + 1));
        }
      }
    }
  }
  catch {
    // Ignore errors (permission denied, etc.)
  }

  return folders;
}

export async function getTrackList(dirPath: string): Promise<Array<{ name: string; path: string; index: number; }>> {
  const audioExtensions = [ '.mp3', '.ogg', '.wav', '.flac', '.m4a' ];
  const tracks: Array<{ name: string; path: string; index: number; }> = [];

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
  }
  catch {
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

export function toTree(dirPath: string, tracks: Array<{ name: string; path: string; index: number; }>): TreeNode[] {
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
    }
    else {
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
  & {
    title: string;
  }
  & (
    | {
      type: 'folder';
      children: TrackNode[];
    }
    | {
      type: 'audio' | 'text' | 'image' | 'other';
      title: string;
      hash: string; // 相对于 work dir 的路径，如 'subfolder/track01.mp3'
    }
  );

const SUPPORTED_EXTENSIONS = new Set([
  '.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a',
  '.txt', '.lrc', '.srt', '.ass',
  '.pdf',
  '.jpg', '.jpeg', '.png', '.webp',
]);

const AUDIO_EXTENSIONS = new Set([ '.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a' ]);
const TEXT_EXTENSIONS = new Set([ '.txt', '.lrc', '.srt', '.ass' ]);
const IMAGE_EXTENSIONS = new Set([ '.jpg', '.jpeg', '.png', '.webp' ]);

function getTrackType(ext: string): 'audio' | 'text' | 'image' | 'other' {
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}

/**
 * 递归构建文件树结构
 * @param dirPath 目录的绝对路径
 * @param basePath 相对于作品根目录的路径（用于生成 hash）
 */
async function buildTree(dirPath: string, basePath: string): Promise<TrackNode[]> {
  const nodes: TrackNode[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(() => []);

  // 先处理文件夹，再处理文件，保持排序
  const dirs: string[] = [];
  const files: string[] = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      dirs.push(entry.name);
    }
    else if (entry.isFile() && SUPPORTED_EXTENSIONS.has(extname(entry.name).toLowerCase())) {
      files.push(entry.name);
    }
  }

  dirs.sort();
  files.sort();

  // 递归处理子目录
  for (const dirName of dirs) {
    const childPath = join(dirPath, dirName);
    const childBase = basePath ? `${basePath}/${dirName}` : dirName;
    const children = await buildTree(childPath, childBase);

    // 跳过空目录
    if (children.length > 0) {
      nodes.push({ type: 'folder', title: dirName, children });
    }
  }

  // 处理文件
  for (const fileName of files) {
    const ext = extname(fileName).toLowerCase();
    const hash = basePath ? `${basePath}/${fileName}` : fileName;
    nodes.push({ type: getTrackType(ext), title: fileName, hash });
  }

  return nodes;
}

/**
 * 构建文件树结构
 * @param dirPath 作品目录的绝对路径
 */
export async function buildTrackTree(dirPath: string): Promise<TrackNode[]> {
  return buildTree(dirPath, '');
}

export function hasLetter(str: string): boolean {
  return /[a-zA-Z]/.test(str);
}

export function nameToUUID(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    const char = name.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(16).padStart(8, '0');
}
