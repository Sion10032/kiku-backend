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
