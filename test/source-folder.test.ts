import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createFolderSource } from '../src/filesystem/source/folder.js';
import { openWorkSource } from '../src/filesystem/source/index.js';
import { UnsupportedArchiveError } from '../src/filesystem/source/types.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiku-folder-src-'));
  writeFileSync(join(dir, '01.mp3'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  mkdirSync(join(dir, 'sub トラック'));
  writeFileSync(join(dir, 'sub トラック/02.wav'), Buffer.alloc(4, 0xab));
  writeFileSync(join(dir, 'ignore.xyz'), 'x');
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('folder source', () => {
  it('buildTree 输出与 buildTrackTree 一致的树形', async () => {
    const src = createFolderSource(dir);
    const tree = await src.buildTree();
    expect(tree.map((n) => n.type)).toEqual(['folder', 'audio']);
    expect(tree[1]?.type === 'audio' && tree[1].hash).toBe('01.mp3');
  });
  it('has/size 如实反映文件系统', async () => {
    const src = createFolderSource(dir);
    expect(await src.has('01.mp3')).toBe(true);
    expect(await src.has('nope.mp3')).toBe(false);
    expect(await src.has('sub トラック/02.wav')).toBe(true);
    expect(await src.size('01.mp3')).toBe(8);
  });
  it('readRange 闭区间字节精确', async () => {
    const src = createFolderSource(dir);
    const stream = await src.readRange('01.mp3', 2, 4);
    const chunks: Buffer[] = [];
    for await (const c of stream) chunks.push(c as Buffer);
    expect(Buffer.concat(chunks).equals(Buffer.from([3, 4, 5]))).toBe(true);
  });
  it('穿越路径在 has 阶段即拒绝', async () => {
    const src = createFolderSource(dir);
    expect(await src.has('../outside.mp3')).toBe(false);
  });
});

describe('openWorkSource 分发', () => {
  it('目录 → folder source', async () => {
    const src = await openWorkSource(dir, '');
    expect(src.kind).toBe('folder');
  });
  it('目录内的子目录（模拟 work.dir 指向嵌套目录）', async () => {
    const nested = join(dir, 'nested');
    mkdirSync(nested);
    writeFileSync(join(nested, 'a.mp3'), 'x');
    const src = await openWorkSource(dir, 'nested');
    expect(await src.has('a.mp3')).toBe(true);
  });
  it('未知扩展名文件 → UnsupportedArchiveError', async () => {
    writeFileSync(join(dir, 'RJ000001.7z'), 'fake');
    await expect(openWorkSource(dir, 'RJ000001.7z')).rejects.toBeInstanceOf(
      UnsupportedArchiveError,
    );
  });
});
