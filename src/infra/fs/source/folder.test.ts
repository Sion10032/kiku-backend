import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { TrackNode } from '../utils.js';
import { createFolderSource } from './folder.js';
import { openWorkSource } from './index.js';
import { UnsupportedArchiveError } from './types.js';

let dir: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiku-folder-src-'));
  writeFileSync(join(dir, '01.mp3'), Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
  mkdirSync(join(dir, 'sub トラック'));
  writeFileSync(join(dir, 'sub トラック/02.wav'), Buffer.alloc(4, 0xab));
  writeFileSync(join(dir, 'ignore.xyz'), 'x');
  // Linux 合法但被 sanitizeMediaIndex 拒绝的文件名/目录名（P1-5 场景）
  writeFileSync(join(dir, 'Track 2:30.mp3'), 'x');
  mkdirSync(join(dir, '3:00'));
  writeFileSync(join(dir, '3:00/03.flac'), 'x');
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
  it('sanitize 拒绝的路径（含冒号的文件名/目录名）不入树：树里每一条都可服务', async () => {
    const src = createFolderSource(dir);
    const tree = await src.buildTree();
    const hashes: string[] = [];
    const walk = (nodes: TrackNode[]): void => {
      for (const n of nodes) {
        if (n.type === 'folder') walk(n.children);
        else hashes.push(n.hash);
      }
    };
    walk(tree);
    expect(hashes).toEqual(['sub トラック/02.wav', '01.mp3']);
    // 读取路径 sanitize 兜底：脏路径不可服务
    expect(await src.has('Track 2:30.mp3')).toBe(false);
    expect(await src.has('3:00/03.flac')).toBe(false);
    // 正常文件行为不变
    expect(await src.size('01.mp3')).toBe(8);
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
