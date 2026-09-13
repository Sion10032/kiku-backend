import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTar } from '@test/helpers/archive.js';
import { createTarSource } from './tar.js';

let dir: string;
const audio = Buffer.alloc(2048, 0x5a);

async function makeTar(buf: Buffer): Promise<string> {
  const p = join(dir, `t${Math.random().toString(36).slice(2)}.tar`);
  writeFileSync(p, buf);
  return p;
}

/**
 * 手拼一个任意 typeflag 的 512B 头条目（含 size 八进制与 checksum）+ 数据 + 补齐。
 * 用于构造 buildTar 不支持的条目类型（'L' longname、'5' 目录等）。
 */
function rawEntry(
  name: string,
  opts?: { type?: string; data?: Buffer },
): Buffer {
  const data = opts?.data ?? Buffer.alloc(0);
  const hdr = Buffer.alloc(512);
  hdr.write(name.slice(0, 99), 0, 'utf8');
  hdr.write(`${data.length.toString(8).padStart(10, '0')}\0 `, 124, 'ascii');
  hdr.write('        ', 148, 'ascii');
  hdr.write(opts?.type ?? '0', 156, 'ascii');
  hdr.write('ustar\0', 257, 'ascii');
  hdr.write('00', 263, 'ascii');
  let sum = 0;
  for (const b of hdr) sum += b;
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  const pad = Buffer.alloc((512 - (data.length % 512)) % 512);
  return Buffer.concat([hdr, data, pad]);
}

/** 手拼一个 pax 'x' 条目（头 + 数据 + 补齐），用于构造恶意 pax 数据。 */
function xEntry(data: Buffer): Buffer {
  return rawEntry('x', { type: 'x', data });
}
async function collect(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of stream) chunks.push(c as Buffer);
  return Buffer.concat(chunks);
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiku-tar-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe('tar source', () => {
  it('基本：索引、树、has、size、readRange 闭区间精确', async () => {
    const tar = await makeTar(
      buildTar([
        { path: 'RJ000001/01.mp3', data: audio },
        { path: 'RJ000001/おまけ/02.wav', data: Buffer.from([1, 2, 3]) },
        { path: 'RJ000001/readme.txt', data: 'hi' },
        { path: 'RJ000001/sub', type: 'dir' },
      ]),
    );
    const src = await createTarSource(tar);
    expect(src.kind).toBe('tar');
    // 顶层包装目录 RJ000001 已剥离，hash 不再带前缀
    expect(await src.has('01.mp3')).toBe(true);
    expect(await src.has('RJ000001/01.mp3')).toBe(false);
    expect(await src.has('RJ000001/nope.mp3')).toBe(false);
    expect(await src.size('01.mp3')).toBe(audio.length);
    const mid = await collect(await src.readRange('01.mp3', 1000, 1003));
    expect(mid.equals(audio.subarray(1000, 1004))).toBe(true);
    const tree = await src.buildTree();
    // dir 条目不产生空节点；剥离后根级为 おまけ/ + 01.mp3 + readme.txt（folder 在前）
    expect(tree.map((n) => n.type)).toEqual(['folder', 'audio', 'text']);
    expect(tree[0]?.type === 'folder' && tree[0].title).toBe('おまけ');
  });

  it('顶层多个目录时不剥离', async () => {
    const tar = await makeTar(
      buildTar([
        { path: 'a/01.mp3', data: 'x' },
        { path: 'b/02.mp3', data: 'y' },
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has('a/01.mp3')).toBe(true);
    expect(await src.has('b/02.mp3')).toBe(true);
    expect((await src.buildTree()).map((n) => n.type)).toEqual([
      'folder',
      'folder',
    ]);
  });

  it('sanitize 拒绝的脏名条目（含冒号）不入树，正常条目不受影响', async () => {
    const tar = await makeTar(
      buildTar([
        { path: 'Track 2:30.mp3', data: 'x' },
        { path: '2:30/03.flac', data: 'x' },
        { path: '01.mp3', data: audio },
      ]),
    );
    const src = await createTarSource(tar);
    const tree = await src.buildTree();
    expect(tree.map((n) => n.type)).toEqual(['audio']);
    expect(tree[0]?.type === 'audio' && tree[0].hash).toBe('01.mp3');
    // 索引保持完整，但读取路径 sanitize 兜底 → 脏路径不可服务
    expect(await src.has('Track 2:30.mp3')).toBe(false);
    expect(await src.has('01.mp3')).toBe(true);
    expect(await src.size('01.mp3')).toBe(audio.length);
  });

  it('ustar prefix 拼接完整路径', async () => {
    const tar = await makeTar(
      buildTar([
        {
          path: 'prefix dir/RJ000002/a.mp3',
          data: 'x',
          prefix: 'prefix dir',
        },
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has('a.mp3')).toBe(true);
  });

  it('穿越与非法 hash 一律不存在', async () => {
    const tar = await makeTar(buildTar([{ path: 'a/b.mp3', data: 'x' }]));
    const src = await createTarSource(tar);
    expect(await src.has('../a/b.mp3')).toBe(false);
    expect(await src.has('a//b.mp3')).toBe(false);
  });

  it('损坏的 tar（伪 magic）报错', async () => {
    const bad = buildTar([{ path: 'a.mp3', data: 'x' }]);
    bad.write('nope!', 257, 'ascii');
    const tar = await makeTar(bad);
    await expect(createTarSource(tar)).rejects.toThrow(/tar|ustar/);
  });

  it('恶意 pax 数据（len 为 0 / 非 ASCII / 越界）显式报错而非挂死或静默错名', async () => {
    for (const pax of ['0 ', 'garbage', '99 path=a.mp3\n']) {
      const tar = await makeTar(
        Buffer.concat([
          xEntry(Buffer.from(pax, 'ascii')),
          buildTar([{ path: 'a.mp3', data: 'x' }]),
        ]),
      );
      await expect(createTarSource(tar)).rejects.toThrow(
        /malformed pax record length/,
      );
    }
  });

  it('合法 pax path 覆盖条目名', async () => {
    const tar = await makeTar(
      Buffer.concat([
        xEntry(Buffer.from('15 path=ab.mp3\n', 'ascii')),
        buildTar([{ path: 'dummy', data: 'x' }]),
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has('ab.mp3')).toBe(true);
    expect(await src.has('dummy')).toBe(false);
  });

  it("GNU 'L' 目录长名被目录条目消费，不污染后续普通文件", async () => {
    const longDir = `${'d'.repeat(120)}/`;
    const tar = await makeTar(
      Buffer.concat([
        rawEntry('dummy', { type: 'L', data: Buffer.from(longDir, 'utf8') }),
        rawEntry('dummy', { type: '5' }),
        rawEntry('b.mp3', { data: Buffer.from('abc') }),
        Buffer.alloc(1024),
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has('b.mp3')).toBe(true);
    expect(await src.size('b.mp3')).toBe(3);
    // 目录条目本身仍不建索引（长名以 / 结尾会被丢弃）
    expect(await src.has(longDir)).toBe(false);
  });

  it("pax 'x' 目录长名同样不被后续普通文件继承", async () => {
    const tar = await makeTar(
      Buffer.concat([
        xEntry(Buffer.from('21 path=verylongdir/\n', 'ascii')),
        rawEntry('dummy', { type: '5' }),
        rawEntry('c.mp3', { data: Buffer.from('xy') }),
        Buffer.alloc(1024),
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has('c.mp3')).toBe(true);
    expect(await src.has('verylongdir')).toBe(false);
    expect(await src.has('verylongdir/c.mp3')).toBe(false);
  });

  it("GNU 'L' 长名正常作用于紧随其后的普通文件", async () => {
    const longFile = `${'f'.repeat(150)}.mp3`;
    const tar = await makeTar(
      Buffer.concat([
        rawEntry('dummy', { type: 'L', data: Buffer.from(longFile, 'utf8') }),
        rawEntry('dummy', { data: Buffer.from('abc') }),
        Buffer.alloc(1024),
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has(longFile)).toBe(true);
    expect(await src.size(longFile)).toBe(3);
  });

  it("'L' 指向目录后被再次 'L' 覆盖，普通文件取后者长名", async () => {
    const longDir = `${'d'.repeat(120)}/`;
    const longFile = `${'g'.repeat(150)}.mp3`;
    const tar = await makeTar(
      Buffer.concat([
        rawEntry('dummy', { type: 'L', data: Buffer.from(longDir, 'utf8') }),
        rawEntry('dummy', { type: '5' }),
        rawEntry('dummy', { type: 'L', data: Buffer.from(longFile, 'utf8') }),
        rawEntry('dummy', { data: Buffer.from('abc') }),
        Buffer.alloc(1024),
      ]),
    );
    const src = await createTarSource(tar);
    expect(await src.has(longFile)).toBe(true);
    expect(await src.has(longDir)).toBe(false);
  });
});
