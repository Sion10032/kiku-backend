import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memorySource } from '@test/helpers/memorySource.js';
import { collectAudioLeaves, probeDuration, probeTrackSizes } from './probe.js';
import type { TrackNode } from './utils.js';

const FIX = join(import.meta.dir, '../../../test/fixtures/audio');
function fixtureSource(): ReturnType<typeof memorySource> {
  return memorySource({
    'sine.mp3': readFileSync(join(FIX, 'sine.mp3')),
    'sine.flac': readFileSync(join(FIX, 'sine.flac')),
    'sine.wav': readFileSync(join(FIX, 'sine.wav')),
    'sine.ogg': readFileSync(join(FIX, 'sine.ogg')),
    'sine.m4a': readFileSync(join(FIX, 'sine.m4a')),
  });
}

test('各格式时长解析（容差区分精确/估算格式）', async () => {
  const src = fixtureSource();
  expect(await probeDuration(src, 'sine.wav')).toBeCloseTo(0.8, 2);
  expect(await probeDuration(src, 'sine.flac')).toBeCloseTo(0.8, 2);
  expect(await probeDuration(src, 'sine.ogg')).toBeCloseTo(0.8, 2);
  expect(await probeDuration(src, 'sine.m4a')).toBeCloseTo(0.8, 1);
  // mp3 CBR：按 码率×大小 估算，容差放宽
  const mp3 = await probeDuration(src, 'sine.mp3');
  expect(mp3).not.toBeNull();
  expect(Math.abs((mp3 ?? 0) - 0.8)).toBeLessThan(0.2);
});

test('解析失败返回 null 不抛错', async () => {
  const src = memorySource({ 'bad.mp3': Buffer.from('not an audio file') });
  expect(await probeDuration(src, 'bad.mp3')).toBeNull();
});

test('collectAudioLeaves 展平树并保留相对路径', () => {
  const tree: TrackNode[] = [
    { type: 'audio', title: 'a.mp3', hash: 'a.mp3' },
    {
      type: 'folder',
      title: 'sub',
      children: [
        { type: 'audio', title: 'b.flac', hash: 'sub/b.flac' },
        { type: 'text', title: 'c.txt', hash: 'sub/c.txt' },
      ],
    },
  ];
  expect(collectAudioLeaves(tree)).toEqual([
    { mediaIndex: 'a.mp3', title: 'a.mp3' },
    { mediaIndex: 'sub/b.flac', title: 'b.flac' },
  ]);
});

test('probeTrackSizes 单叶 size 失败容错：跳过该叶不抛错，其余正常返回', async () => {
  // memorySource 对不存在的 hash 抛错，充当「某一叶 size() 失败」的 fake source
  const src = memorySource({
    'a.mp3': Buffer.alloc(4),
    'b.mp3': Buffer.alloc(8),
  });
  const leaves = [
    { mediaIndex: 'a.mp3', title: 'a.mp3' },
    { mediaIndex: 'missing.mp3', title: 'missing.mp3' },
    { mediaIndex: 'b.mp3', title: 'b.mp3' },
  ];
  const out = await probeTrackSizes(src, leaves);
  // 被跳过的叶不出现在结果里 → planTrackSync 会把库内既有行归入 toDelete
  //（与「不可服务即不列出」口径一致）
  expect(out).toEqual([
    { mediaIndex: 'a.mp3', title: 'a.mp3', sizeBytes: 4 },
    { mediaIndex: 'b.mp3', title: 'b.mp3', sizeBytes: 8 },
  ]);
});
