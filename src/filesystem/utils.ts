import { readdir } from 'fs/promises';
import { join, extname } from 'path';

export interface FolderInfo {
  path: string;
  rjCode: string | null; // Full RJ code like "RJ01578781"
  dirName: string;
}

/** Extract RJ code from folder name. Returns full code like "RJ01578781" or null. */
export function extractRJFromFolderName(name: string): string | null {
  const match = name.match(/([Rr][Jj])(\d{6,8})/);
  if (match && match[2]) {
    return `RJ${match[2].padStart(8, '0')}`;
  }
  return null;
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
        const rjCode = extractRJFromFolderName(entry.name);

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

export interface TrackNode {
  type: 'folder' | 'audio' | 'text' | 'image' | 'other';
  title: string;
  hash: string; // 相对于 work dir 的路径，如 'subfolder/track01.mp3'
  children?: TrackNode[];
}

/**
 * 递归读取目录，返回所有支持的文件
 */
async function readDirectoryRecursive(
  dirPath: string,
  basePath: string,
): Promise<Array<{ relativePath: string; ext: string; }>> {
  const files: Array<{ relativePath: string; ext: string; }> = [];

  try {
    const entries = await readdir(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      const fullPath = join(dirPath, entry.name);
      const relativePath = basePath ? `${basePath}/${entry.name}` : entry.name;

      if (entry.isDirectory()) {
        // 递归读取子目录
        const subFiles = await readDirectoryRecursive(fullPath, relativePath);
        files.push(...subFiles);
      }
      else if (entry.isFile()) {
        const ext = extname(entry.name).toLowerCase();
        // 过滤支持的文件类型
        const supportedExts = [
          '.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a',
          '.txt', '.lrc', '.srt', '.ass',
          '.pdf',
          '.jpg', '.jpeg', '.png', '.webp',
        ];
        if (supportedExts.includes(ext)) {
          files.push({ relativePath, ext });
        }
      }
    }
  }
  catch {
    // 忽略权限错误等
  }

  // 按目录和文件名排序
  return files.sort((a, b) => {
    const aDir = a.relativePath.substring(0, a.relativePath.lastIndexOf('/'));
    const bDir = b.relativePath.substring(0, b.relativePath.lastIndexOf('/'));
    if (aDir !== bDir) return aDir.localeCompare(bDir);
    return a.relativePath.localeCompare(b.relativePath);
  });
}

/**
 * 根据文件扩展名确定节点类型
 */
function getTrackType(ext: string): TrackNode['type'] {
  if ([ '.mp3', '.ogg', '.opus', '.wav', '.aac', '.flac', '.webm', '.mp4', '.m4a' ].includes(ext)) {
    return 'audio';
  }
  if ([ '.txt', '.lrc', '.srt', '.ass' ].includes(ext)) {
    return 'text';
  }
  if ([ '.jpg', '.jpeg', '.png', '.webp' ].includes(ext)) {
    return 'image';
  }
  return 'other';
}

/**
 * 构建文件树结构
 * @param dirPath 作品目录的绝对路径
 */
export async function buildTrackTree(dirPath: string): Promise<TrackNode[]> {
  const files = await readDirectoryRecursive(dirPath, '');
  const tree: TrackNode[] = [];
  const folderMap = new Map<string, TrackNode>();

  for (const file of files) {
    const parts = file.relativePath.split('/');
    const fileName = parts[parts.length - 1];
    const type = getTrackType(file.ext);

    if (parts.length === 1) {
      // 根目录下的文件
      tree.push({
        type,
        title: fileName,
        hash: file.relativePath,
      });
    }
    else {
      // 子目录下的文件
      const folderParts = parts.slice(0, -1);
      let currentLevel = tree;
      let currentPath = '';

      // 遍历路径部分，构建或找到文件夹节点
      for (const folderName of folderParts) {
        currentPath = currentPath ? `${currentPath}/${folderName}` : folderName;

        let folderNode = folderMap.get(currentPath);
        if (!folderNode) {
          folderNode = {
            type: 'folder',
            title: folderName,
            hash: '', // 文件夹没有 hash
            children: [],
          };
          folderMap.set(currentPath, folderNode);
          currentLevel.push(folderNode);
        }

        currentLevel = folderNode.children!;
      }

      // 添加文件节点
      currentLevel.push({
        type,
        title: fileName,
        hash: file.relativePath,
      });
    }
  }

  return tree;
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
