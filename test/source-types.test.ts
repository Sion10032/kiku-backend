import { describe, expect, it } from 'bun:test';
import { Readable } from 'node:stream';
import {
  readAllFromSource,
  sanitizeMediaIndex,
  UnsupportedArchiveError,
  type WorkSource,
} from '../src/infra/fs/source/types.js';

describe('sanitizeMediaIndex', () => {
  it('接受正常相对路径（含子目录与中日文字符）', () => {
    expect(sanitizeMediaIndex('track01.mp3')).toBe(true);
    expect(sanitizeMediaIndex('sub/おまけ/02.wav')).toBe(true);
    expect(sanitizeMediaIndex('a/b/c.txt')).toBe(true);
  });
  it('拒绝路径穿越与非法形态', () => {
    expect(sanitizeMediaIndex('../etc/passwd')).toBe(false);
    expect(sanitizeMediaIndex('a/../../b.mp3')).toBe(false);
    expect(sanitizeMediaIndex('a/..b/c.mp3')).toBe(true); // ..b 是合法文件名段
    expect(sanitizeMediaIndex('/abs.mp3')).toBe(false);
    expect(sanitizeMediaIndex('')).toBe(false);
    expect(sanitizeMediaIndex('a//b.mp3')).toBe(false);
    expect(sanitizeMediaIndex('a/b.mp3/')).toBe(false);
    expect(sanitizeMediaIndex('a\\b.mp3')).toBe(false);
    expect(sanitizeMediaIndex('a\0b.mp3')).toBe(false);
    expect(sanitizeMediaIndex('C:/x.mp3')).toBe(false);
  });
});

describe('UnsupportedArchiveError', () => {
  it('message 含格式名与重打包指引', () => {
    const err = new UnsupportedArchiveError(
      'RJ123456.zip',
      '使用 deflate 压缩',
    );
    expect(err).toBeInstanceOf(Error);
    expect(err.message).toContain('RJ123456.zip');
    expect(err.message).toContain('使用 deflate 压缩');
    expect(err.message).toContain('7z a -mx=0');
  });
});

describe('readAllFromSource', () => {
  it('聚合 readRange 字节流为完整 Buffer', async () => {
    const data = Buffer.from('0123456789');
    const fake: WorkSource = {
      kind: 'folder',
      buildTree: async () => [],
      has: async () => true,
      size: async () => data.length,
      readRange: async (_h, start, end) =>
        Readable.from([data.subarray(start, end + 1)]),
    };
    const got = await readAllFromSource(fake, 'x.bin');
    expect(got.equals(data)).toBe(true);
  });
});
