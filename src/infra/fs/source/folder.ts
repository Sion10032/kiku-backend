// 文件夹形态的 WorkSource：行为与改造前完全一致（has=size=stat、readRange=createReadStream）。
import { createReadStream } from 'node:fs';
import { readdir, stat } from 'node:fs/promises';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { TrackNode } from '../utils.js';
import {
  entriesToTrackTree,
  isAudioFile,
  isVideoFile,
  servablePaths,
} from './tree.js';
import { sanitizeMediaIndex, type WorkSource } from './types.js';

/**
 * 单文件字节数；不存在/任何 stat 异常 → null（文件可能正被移除，建树不应整体失败）。
 */
export async function fileSizeOrNull(p: string): Promise<number | null> {
  try {
    return (await stat(p)).size;
  } catch {
    return null;
  }
}

/** collectDirEntries 的条目：相对路径 + 文件字节数（stat 失败为 null）。 */
export interface DirPathEntry {
  path: string;
  size: number | null;
}

/**
 * 递归收集可服务文件的相对路径与字节数（'/' 分隔）。
 * 出口统一经 servablePaths 过滤（扩展名 + sanitizeMediaIndex），
 * 注意必须对完整路径过滤而非只看文件名：脏目录名（如 '2:30'）下的
 * 正常文件 hash 同样会被读取路径的 sanitize 拒绝。
 */
export async function collectDirEntries(
  dirPath: string,
  basePath = '',
): Promise<DirPathEntry[]> {
  const entries: DirPathEntry[] = [];
  const listing = await readdir(dirPath, { withFileTypes: true }).catch(
    () => [],
  );
  for (const entry of listing) {
    if (entry.isDirectory()) {
      const childBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      entries.push(
        ...(await collectDirEntries(join(dirPath, entry.name), childBase)),
      );
    } else if (entry.isFile()) {
      const path = basePath ? `${basePath}/${entry.name}` : entry.name;
      entries.push({
        path,
        size: await fileSizeOrNull(join(dirPath, entry.name)),
      });
    }
  }
  return entries.filter((e) => servablePaths([e.path]).length > 0);
}

/**
 * 递归收集可服务文件的相对路径（'/' 分隔）。与 collectDirEntries 同口径，
 * 只取路径。出口统一经 servablePaths 过滤（扩展名 + sanitizeMediaIndex），
 * 注意必须对完整路径过滤而非只看文件名：脏目录名（如 '2:30'）下的
 * 正常文件 hash 同样会被读取路径的 sanitize 拒绝。
 */
export async function collectDirPaths(
  dirPath: string,
  basePath = '',
): Promise<string[]> {
  const entries = await collectDirEntries(dirPath, basePath);
  return entries.map((e) => e.path);
}

/**
 * 目录作品「是否含可服务音频/视频」的快速校验：与 buildTree → treeHasMedia 完全同口径
 * （isAudioFile/isVideoFile 文件名判定 + sanitizeMediaIndex 全路径校验；目录不可读视为无
 * 音视频，与 collectDirPaths 的静默容错一致），但找到首个即提前返回，不做全量枚举建树。
 * 供扫描器发现阶段过滤新作品/路径变更作品（网络存储上全量建树是扫描卡顿主因）。
 */
export async function folderHasMedia(
  dirPath: string,
  basePath = '',
): Promise<boolean> {
  const entries = await readdir(dirPath, { withFileTypes: true }).catch(
    () => null,
  );
  if (!entries) return false;
  for (const entry of entries) {
    if (entry.isFile()) {
      const rel = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (
        (isAudioFile(entry.name) || isVideoFile(entry.name)) &&
        sanitizeMediaIndex(rel)
      )
        return true;
    } else if (entry.isDirectory()) {
      const childBase = basePath ? `${basePath}/${entry.name}` : entry.name;
      if (await folderHasMedia(join(dirPath, entry.name), childBase)) {
        return true;
      }
    }
  }
  return false;
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
      const entries = await collectDirEntries(root);
      const sizes = new Map<string, number>();
      for (const e of entries) {
        if (e.size !== null) sizes.set(e.path, e.size);
      }
      return entriesToTrackTree(
        entries.map((e) => e.path),
        sizes,
      );
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
