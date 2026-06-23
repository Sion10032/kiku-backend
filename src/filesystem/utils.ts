import { readdirSync } from 'fs';
import { join, extname } from 'path';

export function getFolderList(dirPath: string, maxDepth: number, currentDepth: number = 0): string[] {
  if (currentDepth >= maxDepth) {
    return [];
  }

  const folders: string[] = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });

    for (const entry of entries) {
      if (entry.isDirectory()) {
        const fullPath = join(dirPath, entry.name);
        folders.push(fullPath);
        folders.push(...getFolderList(fullPath, maxDepth, currentDepth + 1));
      }
    }
  }
  catch {
    // Ignore errors (permission denied, etc.)
  }

  return folders;
}

export function getTrackList(dirPath: string): Array<{ name: string; path: string; index: number; }> {
  const audioExtensions = [ '.mp3', '.ogg', '.wav', '.flac', '.m4a' ];
  const tracks: Array<{ name: string; path: string; index: number; }> = [];

  try {
    const entries = readdirSync(dirPath, { withFileTypes: true });
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
