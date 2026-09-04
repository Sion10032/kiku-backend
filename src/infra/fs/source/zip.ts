// stored zip 的 WorkSource：EOCD → (zip64) → 中央目录逐条目 → 读本地头算数据偏移。
// 任一非 stored（method ≠ 0）条目 → 整包拒绝（UnsupportedArchiveError）。

import { createReadStream } from 'node:fs';
import { open } from 'node:fs/promises';
import type { TrackNode } from '../utils.js';
import {
  entriesToTrackTree,
  isSupportedFile,
  rekeyStrippedTopDir,
} from './tree.js';
import {
  sanitizeMediaIndex,
  UnsupportedArchiveError,
  type WorkSource,
} from './types.js';

interface ZipEntry {
  size: number;
  dataOffset: number;
}

async function readAt(
  fh: Awaited<ReturnType<typeof open>>,
  position: number,
  length: number,
): Promise<Buffer> {
  const buf = Buffer.alloc(length);
  const { bytesRead } = await fh.read(buf, 0, length, position);
  if (bytesRead < length) throw new Error('unexpected EOF in zip');
  return buf;
}

function decodeName(raw: Buffer, flags: number): string {
  if (flags & 0x800) return raw.toString('utf8');
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(raw);
  } catch {
    // Bun 原生支持 shift_jis 编码
    // @ts-expect-error - shift_jis 是有效编码但 TypeScript 类型定义不包含
    return new TextDecoder('shift_jis').decode(raw);
  }
}

/** 解析 zip64 extra（id 0x0001）：按序 uncompSize/compSize/localOffset 的 u64 覆盖（仅当对应字段饱和 0xFFFFFFFF）。 */
function applyZip64Extra(
  extra: Buffer,
  fields: { uncomp: number; comp: number; local: number },
): void {
  let pos = 0;
  while (pos + 4 <= extra.length) {
    const id = extra.readUInt16LE(pos);
    const size = extra.readUInt16LE(pos + 2);
    if (id === 0x0001) {
      let p = pos + 4;
      const take = (cur: number): number => {
        if (cur !== 0xffffffff) return cur;
        const v = Number(extra.readBigUInt64LE(p));
        p += 8;
        return v;
      };
      fields.uncomp = take(fields.uncomp);
      fields.comp = take(fields.comp);
      fields.local = take(fields.local);
      return;
    }
    pos += 4 + size;
  }
}

async function buildIndex(archivePath: string): Promise<Map<string, ZipEntry>> {
  const fh = await open(archivePath, 'r');
  try {
    const stat = await fh.stat();
    // 从文件尾读 EOCD（最大 22 + 65535 字节注释）
    const tailLen = Math.min(stat.size, 22 + 65535);
    const tail = await readAt(fh, stat.size - tailLen, tailLen);

    // 从尾向前找 EOCD 签名 0x06054b50
    let eocdPos = -1;
    for (let i = tail.length - 22; i >= 0; i--) {
      if (tail.readUInt32LE(i) === 0x06054b50) {
        eocdPos = i;
        break;
      }
    }
    if (eocdPos < 0) throw new Error('zip EOCD not found');

    let entryCount = tail.readUInt16LE(eocdPos + 10);
    let cdOffset = tail.readUInt32LE(eocdPos + 16);

    // zip64：EOCD 字段饱和 → 定位器 → zip64 EOCD
    if (entryCount === 0xffff || cdOffset === 0xffffffff) {
      if (eocdPos < 20) throw new Error('zip64 locator missing');
      const loc = tail.subarray(eocdPos - 20, eocdPos);
      if (loc.readUInt32LE(0) !== 0x07064b50)
        throw new Error('zip64 locator signature mismatch');
      const z64Offset = Number(loc.readBigUInt64LE(8));
      const z64 = await readAt(fh, z64Offset, 56);
      if (z64.readUInt32LE(0) !== 0x06064b50)
        throw new Error('zip64 EOCD signature mismatch');
      entryCount = Number(z64.readBigUInt64LE(32));
      cdOffset = Number(z64.readBigUInt64LE(48));
    }

    const archiveName = archivePath.split('/').pop() ?? archivePath;
    const index = new Map<string, ZipEntry>();
    let pos = cdOffset;

    for (let i = 0; i < entryCount; i++) {
      const fixed = await readAt(fh, pos, 46);
      if (fixed.readUInt32LE(0) !== 0x02014b50)
        throw new Error('central directory signature mismatch');

      const flags = fixed.readUInt16LE(8);
      const method = fixed.readUInt16LE(10);
      const compSize = fixed.readUInt32LE(20);
      let uncompSize = fixed.readUInt32LE(24);
      const nameLen = fixed.readUInt16LE(28);
      const extraLen = fixed.readUInt16LE(30);
      const commentLen = fixed.readUInt16LE(32);
      let localOffset = fixed.readUInt32LE(42);

      const nameRaw = await readAt(fh, pos + 46, nameLen);
      const extra = await readAt(fh, pos + 46 + nameLen, extraLen);

      // zip64 extra 覆盖
      const z64f = { uncomp: uncompSize, comp: compSize, local: localOffset };
      applyZip64Extra(extra, z64f);
      uncompSize = z64f.uncomp;
      localOffset = z64f.local;

      pos += 46 + nameLen + extraLen + commentLen;

      if (method !== 0) {
        throw new UnsupportedArchiveError(
          archiveName,
          '包含 deflate 等压缩条目（非仅存储）',
        );
      }

      // stored 校验：compSize 必须等于 uncompSize
      if (z64f.comp !== uncompSize) {
        throw new Error('corrupt zip: stored size mismatch');
      }

      const name = decodeName(nameRaw, flags).replace(/\\/g, '/');

      // 跳过目录条目
      if (name.endsWith('/') || name === '') continue;

      // 本地头：数据偏移必须用本地 nameLen/extraLen
      const local = await readAt(fh, localOffset, 30);
      if (local.readUInt32LE(0) !== 0x04034b50)
        throw new Error('local header signature mismatch');
      const dataOffset =
        localOffset + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);

      index.set(name, { size: uncompSize, dataOffset });
    }
    return rekeyStrippedTopDir(index);
  } finally {
    await fh.close();
  }
}

export async function createZipSource(
  archivePath: string,
): Promise<WorkSource> {
  // Eagerly build index so invalid zip throws during source creation.
  const indexMap = await buildIndex(archivePath);
  const entry = (hash: string) => {
    if (!sanitizeMediaIndex(hash)) throw new Error(`entry not found: ${hash}`);
    const e = indexMap.get(hash);
    if (!e) throw new Error(`entry not found: ${hash}`);
    return e;
  };

  return {
    kind: 'zip',
    async buildTree(): Promise<TrackNode[]> {
      return entriesToTrackTree([...indexMap.keys()].filter(isSupportedFile));
    },
    has(hash) {
      if (!sanitizeMediaIndex(hash)) return Promise.resolve(false);
      return Promise.resolve(indexMap.has(hash));
    },
    size(hash) {
      return Promise.resolve(entry(hash).size);
    },
    readRange(hash, start, end) {
      const e = entry(hash);
      return Promise.resolve(
        createReadStream(archivePath, {
          start: e.dataOffset + start,
          end: e.dataOffset + end,
        }),
      );
    },
  };
}
