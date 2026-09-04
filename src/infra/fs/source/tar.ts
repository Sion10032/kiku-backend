// 未压缩 tar 的 WorkSource：扫 512B 头建索引（数据区只 seek 不读），
// readRange = createReadStream(archive, { start: dataOffset + start, end: dataOffset + end })。
import { closeSync, createReadStream, openSync, readSync } from 'node:fs';
import type { TrackNode } from '../utils.js';
import {
  entriesToTrackTree,
  isSupportedFile,
  rekeyStrippedTopDir,
} from './tree.js';
import { sanitizeMediaIndex, type WorkSource } from './types.js';

interface TarEntry {
  size: number;
  dataOffset: number;
}

/** 解析 size 字段（124..136）：八进制 ASCII，或 GNU base-256（首字节 0x80）。 */
function parseSize(hdr: Buffer): number {
  const field = hdr.subarray(124, 136);
  if ((field[0] ?? 0) & 0x80) {
    // GNU base-256 大端（丢弃符号位）
    let v = (field[0] ?? 0) & 0x7f;
    for (const b of field.subarray(1)) v = v * 256 + b;
    return v;
  }
  return Number.parseInt(field.toString('ascii').replace(/[\0 ]/g, ''), 8);
}

/** 同步读固定长度块（tar 头扫描是短序列小读取，同步可接受）。 */
function readBlockSync(fd: number, position: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  const bytesRead = readSync(fd, buf, 0, length, position);
  if (bytesRead < length) throw new Error('unexpected EOF in tar');
  return buf;
}

/** pax 'x' 数据：解析 "len key=value\n" 记录，返回 path 覆盖值。 */
function parsePaxPath(data: Buffer): string | null {
  let pos = 0;
  while (pos < data.length) {
    const sp = data.indexOf(' ', pos);
    const len = Number.parseInt(data.subarray(pos, sp).toString('ascii'), 10);
    const record = data.subarray(pos, pos + len).toString('utf8');
    const m = /^(\d+) path=(.*)\n$/.exec(record);
    if (m?.[2]) return m[2];
    pos += len;
  }
  return null;
}

/** 扫 tar 建索引：Map<归一化相对路径, {size, dataOffset}>。 */
function buildIndex(archivePath: string): Map<string, TarEntry> {
  const index = new Map<string, TarEntry>();
  const fd = openSync(archivePath, 'r');
  try {
    let pos = 0;
    let pendingName: string | null = null; // 'L' longname / 'x' pax path
    for (;;) {
      const hdr = readBlockSync(fd, pos, 512);
      if (hdr.every((b) => b === 0)) break; // 全零块 = 结束
      const magic = hdr.subarray(257, 262).toString('ascii');
      if (magic !== 'ustar')
        throw new Error(
          `not a ustar tar archive (magic: ${JSON.stringify(magic)})`,
        );
      const size = parseSize(hdr);
      const type = String.fromCharCode(hdr[156] ?? 0);
      const dataOffset = pos + 512;
      if (type === 'L' || type === 'x') {
        const data = readBlockSync(fd, dataOffset, size);
        if (type === 'L')
          pendingName = data.toString('utf8').replace(/\0+$/, '');
        else {
          const pax = parsePaxPath(data);
          if (pax) pendingName = pax;
        }
      } else if (type === '0' || type === '\0') {
        const rawName = hdr
          .subarray(0, 100)
          .toString('utf8')
          .replace(/\0+$/, '');
        const prefix = hdr
          .subarray(345, 500)
          .toString('utf8')
          .replace(/\0+$/, '');
        let name = pendingName ?? (prefix ? `${prefix}/${rawName}` : rawName);
        pendingName = null;
        if (name.startsWith('./')) name = name.slice(2);
        name = name.replace(/\\/g, '/');
        if (!name.endsWith('/')) {
          index.set(name, { size, dataOffset }); // GNU 允许同名条目，取后者
        }
      }
      // 目录（'5'）与其他类型：跳过
      pos = dataOffset + Math.ceil(size / 512) * 512;
    }
  } finally {
    closeSync(fd);
  }
  return rekeyStrippedTopDir(index);
}

export async function createTarSource(
  archivePath: string,
): Promise<WorkSource> {
  // Eagerly build index so invalid tar throws during source creation.
  const indexPromise = Promise.resolve(buildIndex(archivePath));
  const index = () => indexPromise;
  const entry = async (hash: string) => {
    if (!sanitizeMediaIndex(hash)) throw new Error(`entry not found: ${hash}`);
    const e = (await index()).get(hash);
    if (!e) throw new Error(`entry not found: ${hash}`);
    return e;
  };
  return {
    kind: 'tar',
    async buildTree(): Promise<TrackNode[]> {
      const paths = [...(await index()).keys()].filter(isSupportedFile);
      return entriesToTrackTree(paths);
    },
    async has(hash) {
      if (!sanitizeMediaIndex(hash)) return false;
      return (await index()).has(hash);
    },
    async size(hash) {
      return (await entry(hash)).size;
    },
    async readRange(hash, start, end) {
      const e = await entry(hash);
      return createReadStream(archivePath, {
        start: e.dataOffset + start,
        end: e.dataOffset + end,
      });
    },
  };
}
