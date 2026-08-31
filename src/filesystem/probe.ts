import { parseFromTokenizer } from 'music-metadata';
import {
  AbstractTokenizer,
  EndOfStreamError,
  type IFileInfo,
  type IReadChunkOptions,
} from 'strtok3';
import type { WorkSource } from './source/types.js';
import type { TrackNode } from './utils.js';

/**
 * readRange → strtok3 tokenizer 适配器。
 * music-metadata 解析时长只需头部（m4a 可能需尾部 moov），readRange 随机访问直达，
 * 每轨 IO 为 KB 级。并发读串行化（WorkSource 实现不保证并发安全）。
 * token/number/ignore/close 语义由 strtok3 AbstractTokenizer 提供，
 * 这里只需实现 readBuffer / peekBuffer（对齐 BufferTokenizer 的 EOF 语义）。
 */
class RangeTokenizer extends AbstractTokenizer {
  override readonly fileInfo: IFileInfo;

  private readonly source: WorkSource;
  private readonly hash: string;
  private queue: Promise<unknown>;

  constructor(source: WorkSource, hash: string, size: number) {
    super();
    this.source = source;
    this.hash = hash;
    this.fileInfo = { size };
    this.queue = Promise.resolve();
  }

  /** readRange 天然随机访问，回跳无需重读。 */
  supportsRandomAccess(): boolean {
    return true;
  }

  setPosition(position: number): void {
    this.position = position;
  }

  override async readBuffer(
    buffer: Uint8Array,
    options?: IReadChunkOptions,
  ): Promise<number> {
    const norm = this.normalizeOptions(buffer, options);
    return this.chained(async () => {
      const start = Math.max(0, norm.position);
      const bytes2read = this.clampAvailable(start, norm.length);
      if (!norm.mayBeLess && bytes2read < norm.length) {
        throw new EndOfStreamError();
      }
      const filled =
        bytes2read > 0
          ? await this.readRangeInto(start, bytes2read, buffer)
          : 0;
      this.position = start + filled;
      return filled;
    });
  }

  override async peekBuffer(
    buffer: Uint8Array,
    options?: IReadChunkOptions,
  ): Promise<number> {
    const norm = this.normalizeOptions(buffer, options);
    return this.chained(async () => {
      const start = Math.max(0, norm.position);
      const bytes2read = this.clampAvailable(start, norm.length);
      if (!norm.mayBeLess && bytes2read < norm.length) {
        throw new EndOfStreamError();
      }
      // peek 不推进游标：readRange 直接按目标位置读，天然成立
      return bytes2read > 0
        ? await this.readRangeInto(start, bytes2read, buffer)
        : 0;
    });
  }

  /** clamp 到文件实际可读字节数（position 越界返回 0）。 */
  private clampAvailable(position: number, length: number): number {
    const available = (this.fileInfo.size ?? 0) - position;
    return Math.max(0, Math.min(available, length));
  }

  /** readRange 闭区间 [start, start+length-1] 读入 buffer，返回实际填充字节数。 */
  private async readRangeInto(
    start: number,
    length: number,
    buffer: Uint8Array,
  ): Promise<number> {
    const stream = await this.source.readRange(
      this.hash,
      start,
      start + length - 1,
    );
    let filled = 0;
    for await (const chunk of stream) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const n = Math.min(buf.length, length - filled);
      if (n > 0) buffer.set(buf.subarray(0, n), filled);
      filled += n;
      if (filled >= length) break;
    }
    return filled;
  }

  private chained<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.queue.then(fn);
    this.queue = next.catch(() => {});
    return next;
  }
}

/** 头部/常规解析探测时长；duration=true 时 music-metadata 会全量扫描（mp3 CBR 估算回退）。 */
async function probeWithDurationOption(
  source: WorkSource,
  hash: string,
  size: number,
  duration: boolean,
): Promise<number | null> {
  const tokenizer = new RangeTokenizer(source, hash, size);
  try {
    const meta = await parseFromTokenizer(tokenizer, { duration });
    return meta.format.duration ?? null;
  } catch {
    return null;
  } finally {
    await tokenizer.close().catch(() => {});
  }
}

/**
 * 元数据解析（时长探测入口）。失败返回 null，不抛错。
 * 先做头部解析（KB 级 IO）；头解析拿不到时长（如 CBR mp3）才回退 duration: true 全量扫描。
 */
export async function probeDuration(
  source: WorkSource,
  hash: string,
): Promise<number | null> {
  const size = await source.size(hash);
  const duration = await probeWithDurationOption(source, hash, size, false);
  if (duration !== null) return duration;
  return probeWithDurationOption(source, hash, size, true);
}

/** 树 → 音频叶子列表（mediaIndex = '/' 相对路径，与前端 hash 一致）。 */
export function collectAudioLeaves(
  nodes: TrackNode[],
): Array<{ mediaIndex: string; title: string }> {
  const out: Array<{ mediaIndex: string; title: string }> = [];
  const walk = (list: TrackNode[]): void => {
    for (const n of list) {
      if (n.type === 'audio') out.push({ mediaIndex: n.hash, title: n.title });
      else if (n.type === 'folder') walk(n.children);
    }
  };
  walk(nodes);
  return out;
}

/** 叶子 + 大小（供 trackSync diff；size 在 zip/tar 是索引查找，folder 是 stat）。 */
export async function probeTrackSizes(
  source: WorkSource,
  leaves: Array<{ mediaIndex: string; title: string }>,
): Promise<Array<{ mediaIndex: string; title: string; sizeBytes: number }>> {
  const out: Array<{
    mediaIndex: string;
    title: string;
    sizeBytes: number;
  }> = [];
  for (const leaf of leaves) {
    out.push({ ...leaf, sizeBytes: await source.size(leaf.mediaIndex) });
  }
  return out;
}
