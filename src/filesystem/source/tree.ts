// 曲目树唯一构建实现：folder/tar/zip 三种 WorkSource 共用，
// 保证树形状与排序在不同作品形态间完全一致。
import { extname } from 'node:path';
import type { TrackNode } from '../utils.js';

const AUDIO_EXTENSIONS = new Set([
  '.mp3',
  '.ogg',
  '.opus',
  '.wav',
  '.aac',
  '.flac',
  '.webm',
  '.mp4',
  '.m4a',
]);
const TEXT_EXTENSIONS = new Set(['.txt', '.lrc', '.srt', '.ass']);
const IMAGE_EXTENSIONS = new Set(['.jpg', '.jpeg', '.png', '.webp']);
const SUPPORTED_EXTENSIONS = new Set([
  ...AUDIO_EXTENSIONS,
  ...TEXT_EXTENSIONS,
  ...IMAGE_EXTENSIONS,
  '.pdf',
]);

export function isAudioFile(name: string): boolean {
  return AUDIO_EXTENSIONS.has(extname(name).toLowerCase());
}
export function isSupportedFile(name: string): boolean {
  return SUPPORTED_EXTENSIONS.has(extname(name).toLowerCase());
}

function classify(name: string): Exclude<TrackNode['type'], 'folder'> {
  const ext = extname(name).toLowerCase();
  if (AUDIO_EXTENSIONS.has(ext)) return 'audio';
  if (TEXT_EXTENSIONS.has(ext)) return 'text';
  if (IMAGE_EXTENSIONS.has(ext)) return 'image';
  return 'other';
}

/**
 * 相对路径列表 → TrackNode 树。
 * 入参为「/」分隔的相对路径；跳过不支持扩展名的路径。
 * 排序：文件夹在前、文件在后，同级字节序（.sort()），与文件夹版行为一致。
 */
export function entriesToTrackTree(paths: string[]): TrackNode[] {
  type Dir = { dirs: Map<string, Dir>; files: Map<string, TrackNode> };
  const root: Dir = { dirs: new Map(), files: new Map() };

  for (const p of paths) {
    const name = p.split('/').pop();
    if (!name || !isSupportedFile(name)) continue;
    const segments = p.split('/');
    let dir = root;
    for (const seg of segments.slice(0, -1)) {
      let next = dir.dirs.get(seg);
      if (!next) {
        next = { dirs: new Map(), files: new Map() };
        dir.dirs.set(seg, next);
      }
      dir = next;
    }
    dir.files.set(name, { type: classify(name), title: name, hash: p });
  }

  const build = (dir: Dir): TrackNode[] => {
    const nodes: TrackNode[] = [];
    for (const [name, child] of [...dir.dirs.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      const children = build(child);
      if (children.length > 0)
        nodes.push({ type: 'folder', title: name, children });
    }
    for (const [_name, file] of [...dir.files.entries()].sort(([a], [b]) =>
      a < b ? -1 : 1,
    )) {
      nodes.push(file);
    }
    return nodes;
  };

  return build(root);
}

/** 递归查找树中是否存在音频节点（扫描器判定作品有效用）。 */
export function treeHasAudio(nodes: TrackNode[]): boolean {
  for (const node of nodes) {
    if (node.type === 'audio') return true;
    if (node.type === 'folder' && treeHasAudio(node.children)) return true;
  }
  return false;
}
