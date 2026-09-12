import type { Dirent } from 'node:fs';
import { readdir } from 'node:fs/promises';
import { extname, join } from 'node:path';
import { extractWorkCode } from '../../utils/rjcode.js';
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
 * collectWorkEntries 的结果：用返回值（而非异常）告知枚举是否完整。
 * 判别联合：失败分支（complete=false）不含 entries，failedPath/reason 必填；
 * 调用方须先收窄才能访问条目。
 */
export type CollectWorkEntriesResult =
  | { complete: true; entries: WorkEntry[] }
  | { complete: false; failedPath: string; reason: string };

/**
 * 递归收集 root 下的 RJ 作品条目。
 * 规则：RJ 目录不深入、非 RJ 目录下探一层直至 maxDepth。
 * RJ 命名文件按扩展名分类：tar/zip → archive，其余 → unsupported-archive。
 * 任一层 readdir 失败（EACCES / EIO / 路径消失等）即短路返回
 * complete=false（携带失败路径与原因）：枚举失败 ≠ 目录为空；
 * 不以异常传递枚举失败，非枚举类意外错误仍自然上抛。
 */
export async function collectWorkEntries(
  rootPath: string,
  maxDepth: number,
  currentDepth = 0,
): Promise<CollectWorkEntriesResult> {
  if (currentDepth >= maxDepth) return { complete: true, entries: [] };
  const out: WorkEntry[] = [];
  let dirents: Dirent[];
  try {
    dirents = await readdir(rootPath, { withFileTypes: true });
  } catch (cause) {
    return {
      complete: false,
      failedPath: rootPath,
      reason: cause instanceof Error ? cause.message : String(cause),
    };
  }
  for (const entry of dirents) {
    const rj = extractWorkCode(entry.name);
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
        if (!nested.complete) {
          // 短路：子层失败视为整个 root 枚举失败，结果直接透传
          //（收窄后 nested.failedPath/reason 必为 string）
          return nested;
        }
        out.push(
          ...nested.entries.map((n) => ({
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
  return { complete: true, entries: out };
}

/** 歌词文件引用（建树时匹配，仅 audio 节点设置）。 */
export interface LyricsRef {
  /** 歌词文件相对路径（media index，同 hash 语义） */
  hash: string;
  type: 'lrc' | 'vtt';
}

/** 树分支节点（目录）。 */
export interface TrackBranch {
  type: 'folder';
  title: string;
  children: TrackNode[];
}

/** 树叶节点（audio/text/image/other）。 */
export interface TrackLeaf {
  type: 'audio' | 'text' | 'image' | 'other';
  title: string;
  /** 相对于 work dir 的路径，如 'subfolder/track01.mp3' */
  hash: string;
  /** 仅 audio 节点：建树时按候选规则匹配到的歌词文件 */
  lyrics?: LyricsRef;
}

export type TrackNode = TrackBranch | TrackLeaf;

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
