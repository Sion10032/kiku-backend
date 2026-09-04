// 作品内容源抽象：文件夹 / tar / stored zip 三种形态统一接口。
import type { Readable } from 'node:stream';
import type { TrackNode } from '../utils.js';

export interface WorkSource {
  readonly kind: 'folder' | 'tar' | 'zip';
  /** 曲目树（仅含支持扩展名，排序与文件夹作品完全一致）。 */
  buildTree(): Promise<TrackNode[]>;
  /** 条目是否存在（hash = '/' 分隔相对路径）。 */
  has(hash: string): Promise<boolean>;
  /** 条目原始字节数；不存在时 throw。 */
  size(hash: string): Promise<number>;
  /** 读取闭区间 [start, end] 字节流；不存在时 throw。 */
  readRange(hash: string, start: number, end: number): Promise<Readable>;
}

/** 不支持/非法的压缩包形态（deflate zip、.7z 等），message 面向最终用户。 */
export class UnsupportedArchiveError extends Error {
  constructor(archiveName: string, reason: string) {
    super(
      `${archiveName} ${reason}。仅支持「仅存储（stored）」格式，` +
        `请重新打包：zip 用 7z a -mx=0 out.zip <目录>/（或 tar cf out.tar <目录>/）`,
    );
    this.name = 'UnsupportedArchiveError';
  }
}

/**
 * 校验 media index（前端 hash）安全性。false = 调用方应返回 404。
 * 拒绝：路径穿越（.. 段）、绝对路径、反斜杠、NUL、空段、盘符。
 */
export function sanitizeMediaIndex(hash: string): boolean {
  if (
    hash === '' ||
    hash.includes('\\') ||
    hash.includes('\0') ||
    hash.includes(':')
  ) {
    return false;
  }
  if (hash.startsWith('/')) return false;
  const segments = hash.split('/');
  return segments.every((s) => s !== '' && s !== '.' && s !== '..');
}

/** 小文件全读（歌词等）：readRange 聚合为单个 Buffer。 */
export async function readAllFromSource(
  source: WorkSource,
  hash: string,
): Promise<Buffer> {
  const size = await source.size(hash);
  const stream = await source.readRange(hash, 0, size - 1);
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks);
}
