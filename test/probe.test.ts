import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { collectAudioLeaves, probeDuration } from '../src/filesystem/probe.js';
import type { TrackNode } from '../src/filesystem/utils.js';
import { memorySource } from './helpers/memorySource.js';

const FIX = join(import.meta.dir, 'fixtures/audio');
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
