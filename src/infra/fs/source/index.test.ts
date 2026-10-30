import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from 'bun:test';
import {
  mkdtempSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildTar } from '@test/helpers/archive.js';
import {
  __resetSourceCacheForTesting,
  __setSourceCachePolicyForTesting,
  openWorkSource,
} from './index.js';
import { createTarSource } from './tar.js';

let dir: string;

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/** 第一个参数做文件名；每个用例用独立归档，避免跨用例干扰。 */
function makeTar(name: string, track = '01.mp3'): string {
  const p = join(dir, `${name}.tar`);
  writeFileSync(
    p,
    buildTar([
      { path: `RJ000001/${track}`, data: Buffer.alloc(64, 0x5a) },
      { path: 'RJ000001/readme.txt', data: 'hi' },
    ]),
  );
  return p;
}

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), 'kiku-source-cache-'));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));
beforeEach(() => __resetSourceCacheForTesting());

describe('openWorkSource 缓存', () => {
  it('命中：同路径两次 openWorkSource 返回同一实例', async () => {
    makeTar('hit');
    const first = await openWorkSource(dir, 'hit.tar');
    const second = await openWorkSource(dir, 'hit.tar');
    expect(first.kind).toBe('tar');
    expect(second).toBe(first);
  });

  it('mtime/size 变化后重建', async () => {
    const p = makeTar('touched');
    const first = await openWorkSource(dir, 'touched.tar');

    // 只改 mtime（size 不变）→ 失效
    const future = new Date(Date.now() + 5_000);
    utimesSync(p, future, future);
    const second = await openWorkSource(dir, 'touched.tar');
    expect(second).not.toBe(first);

    // 只改 size（内容变化）→ 失效
    const beforeSize = statSync(p).size;
    writeFileSync(p, Buffer.concat([buildTar([]), Buffer.alloc(512)]));
    expect(statSync(p).size).not.toBe(beforeSize);
    const third = await openWorkSource(dir, 'touched.tar');
    expect(third).not.toBe(second);
  });

  it('TTL 过期后重建', async () => {
    __setSourceCachePolicyForTesting({ ttlMs: 50 });
    makeTar('ttl');
    const first = await openWorkSource(dir, 'ttl.tar');
    await sleep(120);
    const second = await openWorkSource(dir, 'ttl.tar');
    expect(second).not.toBe(first);
  });

  it('访问滑动续期', async () => {
    // ttl=500：t=0 构建、t≈300 命中（刷新窗口）、t≈600 再命中。
    // 若不刷新 lastAccessAt，t≈600 时 600 > 500 会重建。
    __setSourceCachePolicyForTesting({ ttlMs: 500 });
    makeTar('sliding');
    const first = await openWorkSource(dir, 'sliding.tar');
    await sleep(300);
    const second = await openWorkSource(dir, 'sliding.tar');
    expect(second).toBe(first);
    await sleep(300);
    const third = await openWorkSource(dir, 'sliding.tar');
    expect(third).toBe(first);
  });

  it('个数淘汰', async () => {
    __setSourceCachePolicyForTesting({ maxEntries: 2 });
    makeTar('a');
    makeTar('b');
    makeTar('c');
    const a = await openWorkSource(dir, 'a.tar');
    const b = await openWorkSource(dir, 'b.tar');
    await openWorkSource(dir, 'c.tar'); // 插入 c → 淘汰最冷的 a
    // 命中 b 会把它前移，确保下一个被淘汰的仍是 a
    expect(await openWorkSource(dir, 'b.tar')).toBe(b);
    expect(await openWorkSource(dir, 'a.tar')).not.toBe(a);
  });

  it('总大小淘汰', async () => {
    // 预算取「恰好一个索引」的真实估算值：插入第二个后必须淘汰最冷的第一个
    makeTar('big-a');
    makeTar('big-b');
    const probe = await createTarSource(join(dir, 'big-a.tar'));
    const oneIndexBytes = probe.approxIndexBytes?.() ?? 0;
    expect(oneIndexBytes).toBeGreaterThan(0);
    __setSourceCachePolicyForTesting({ maxBytes: oneIndexBytes });

    const a = await openWorkSource(dir, 'big-a.tar');
    const b = await openWorkSource(dir, 'big-b.tar');
    expect(b).not.toBe(a);
    // b 仍在缓存（两次淘汰后剩下的应是最近访问的条目）
    expect(await openWorkSource(dir, 'big-b.tar')).toBe(b);
    // a 已被总大小淘汰 → 重建得到新实例
    expect(await openWorkSource(dir, 'big-a.tar')).not.toBe(a);
  });

  it('并发 open 同路径只构建一次', async () => {
    makeTar('concurrent');
    const [first, second] = await Promise.all([
      openWorkSource(dir, 'concurrent.tar'),
      openWorkSource(dir, 'concurrent.tar'),
    ]);
    expect(second).toBe(first);
  });

  it('构建失败后不缓存且可重试', async () => {
    // 同 mtime/size 下重试，隔离「失败结果残留缓存」这一个变量：
    // 先放同长度的损坏字节，再换回合法 tar 并把 mtime 拨回同一时刻。
    const valid = buildTar([
      { path: 'RJ000001/01.mp3', data: Buffer.from('ok') },
    ]);
    const p = join(dir, 'broken.tar');
    const stamp = new Date(Math.floor(Date.now() / 1000) * 1000);
    writeFileSync(p, Buffer.alloc(valid.length, 0xff));
    utimesSync(p, stamp, stamp);
    const brokenStat = statSync(p);

    await expect(openWorkSource(dir, 'broken.tar')).rejects.toThrow();
    // 重试仍走真实构建（失败 promise 不得被当作在途构建缓存）
    await expect(openWorkSource(dir, 'broken.tar')).rejects.toThrow();

    writeFileSync(p, valid);
    utimesSync(p, stamp, stamp);
    const repairedStat = statSync(p);
    expect(repairedStat.size).toBe(brokenStat.size);
    expect(repairedStat.mtimeMs).toBe(brokenStat.mtimeMs);

    const src = await openWorkSource(dir, 'broken.tar');
    expect(await src.has('01.mp3')).toBe(true);
  });
});
