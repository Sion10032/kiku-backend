// 文件夹形态的 WorkSource：行为与改造前完全一致（has=size=stat、readRange=createReadStream）。
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { TrackNode } from '../utils.js';
import { entriesToTrackTree, isSupportedFile } from './tree.js';
import { sanitizeMediaIndex, type WorkSource } from './types.js';

/** 递归收集支持扩展名文件的相对路径（'/' 分隔）。 */
export async function collectDirPaths(
  dirPath: string,
  basePath = '',
): Promise<string[]> {
  const paths: string[] = [];
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of entries) {
    if (entry.isDirectory()) {
      const childBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      paths.push(
        ...(await collectDirPaths(join(dirPath, entry.name), childBase)),
      );
    } else if (entry.isFile() && isSupportedFile(entry.name)) {
      paths.push(basePath ? `${basePath}/${entry.name}` : entry.name);
    }
  }
  return paths;
}

export function createFolderSource(dirPath: string): WorkSource {
  const root = resolve(dirPath);

  const abs = (hash: string): string | null => {
    if (!sanitizeMediaIndex(hash)) return null;
    const p = resolve(root, ...hash.split('/'));
    // 双保险：resolve 结果必须仍在 root 内
    return p === root || p.startsWith(root + sep) ? p : null;
  };

  return {
    kind: 'folder',
    async buildTree(): Promise<TrackNode[]> {
      return entriesToTrackTree(await collectDirPaths(root));
    },
    async has(hash) {
      const p = abs(hash);
      if (p === null || isAbsolute(hash)) return false;
      try {
        return (await stat(p)).isFile();
      } catch {
        return false;
      }
    },
    async size(hash) {
      const p = abs(hash);
      if (p === null) throw new Error(`entry not found: ${hash}`);
      return (await stat(p)).size;
    },
    async readRange(hash, start, end) {
      const p = abs(hash);
      if (p === null) throw new Error(`entry not found: ${hash}`);
      return createReadStream(p, { start, end });
    },
  };
}
