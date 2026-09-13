import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { TextDecoder } from 'node:util';
import { buildZip } from '@test/helpers/archive.js';
import { UnsupportedArchiveError } from './types.js';
import { createZipSource } from './zip.js';

let dir: string;
const audio = Buffer.alloc(3000, 0x33);

async function makeZip(buf: Buffer): Promise<string> {
  const p = join(dir, `z${Math.random().toString(36).slice(2)}.zip`);
  writeFileSync(p, buf);
  return p;
}
async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiku-zip-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('zip source（stored）', () => {
  it('基本：has/size/readRange/buildTree', async () => {
    const zip = await makeZip(
      buildZip([
        { path: 'RJ000003/01.mp3', data: audio },
        { path: 'RJ000003/sub/02.wav', data: Buffer.from([9, 8, 7]) },
        { path: 'RJ000003/lyric.lrc', data: '[00:01]test' },
      ]),
    );
    const src = await createZipSource(zip);
    expect(src.kind).toBe('zip');
    // 顶层包装目录 RJ000003 已剥离，hash 不再带前缀
    expect(await src.has('01.mp3')).toBe(true);
    expect(await src.has('RJ000003/01.mp3')).toBe(false);
    expect(await src.size('01.mp3')).toBe(audio.length);
    const range = await collect(await src.readRange('01.mp3', 2000, 2999));
    expect(range.equals(audio.subarray(2000))).toBe(true);
    const tree = await src.buildTree();
    // 剥离后根级为 sub/ + 01.mp3 + lyric.lrc（folder 在前）
    expect(tree.map((n) => n.type)).toEqual(['folder', 'audio', 'text']);
    expect(tree[0]?.type === 'folder' && tree[0].title).toBe('sub');
  });

  it('顶层多个目录时不剥离', async () => {
    const zip = await makeZip(
      buildZip([
        { path: 'a/01.mp3', data: 'x' },
        { path: 'b/02.mp3', data: 'y' },
      ]),
    );
    const src = await createZipSource(zip);
    expect(await src.has('a/01.mp3')).toBe(true);
    expect(await src.has('b/02.mp3')).toBe(true);
    expect((await src.buildTree()).map((n) => n.type)).toEqual([
      'folder',
      'folder',
    ]);
  });

  it('sanitize 拒绝的脏名条目（含冒号）不入树，正常条目不受影响', async () => {
    const zip = await makeZip(
      buildZip([
        { path: 'Track 2:30.mp3', data: 'x' },
        { path: '2:30/03.flac', data: 'x' },
        { path: '01.mp3', data: 'y' },
      ]),
    );
    const src = await createZipSource(zip);
    const tree = await src.buildTree();
    expect(tree.map((n) => n.type)).toEqual(['audio']);
    // 索引保持完整，但读取路径 sanitize 兜底 → 脏路径不可服务
    expect(await src.has('Track 2:30.mp3')).toBe(false);
    expect(await src.has('01.mp3')).toBe(true);
    expect(await src.size('01.mp3')).toBe(1);
  });

  it('EFS 位置 1 的 UTF-8 文件名直接解码', async () => {
    const zip = await makeZip(
      buildZip([{ path: 'RJ000004/おまけ.wav', data: 'x', efs: true }]),
    );
    const src = await createZipSource(zip);
    expect(await src.has('おまけ.wav')).toBe(true);
  });

  it('非 EFS 的 Shift-JIS 文件名回退解码', async () => {
    // 字节来自: printf 'トラック01.mp3' | iconv -f utf-8 -t shift_jis | xxd -p
    // 836783898362834e30312e6d7033
    const sjisName = Buffer.from('836783898362834e30312e6d7033', 'hex');
    const expected = new TextDecoder('shift_jis').decode(sjisName);
    const zip = await makeZip(buildZip([{ path: sjisName, data: 'x' }]));
    const src = await createZipSource(zip);
    expect(await src.has(expected)).toBe(true);
  });

  it('deflate 条目 → UnsupportedArchiveError（含重打包指引）', async () => {
    const zip = await makeZip(
      buildZip([
        { path: 'a.mp3', data: audio, method: 0 },
        { path: 'b.txt', data: 'compressed-ish', method: 8 },
      ]),
    );
    await expect(createZipSource(zip)).rejects.toBeInstanceOf(
      UnsupportedArchiveError,
    );
  });

  it('目录条目（/ 结尾）跳过不报错', async () => {
    const zip = await makeZip(
      buildZip([
        { path: 'RJ000005/', data: '' },
        { path: 'RJ000005/a.mp3', data: 'x' },
      ]),
    );
    const src = await createZipSource(zip);
    expect(await src.has('a.mp3')).toBe(true);
  });

  it('穿越 hash 拒绝', async () => {
    const zip = await makeZip(buildZip([{ path: 'a/b.mp3', data: 'x' }]));
    const src = await createZipSource(zip);
    expect(await src.has('../a/b.mp3')).toBe(false);
  });
});
