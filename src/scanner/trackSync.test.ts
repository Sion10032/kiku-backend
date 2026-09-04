import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memorySource } from '@test/helpers/memorySource.js';
import { setupTestEnvironment } from '@test/helpers/setup.js';
import { entriesToTrackTree } from '../infra/fs/source/tree.js';
import { getTrackRows } from '../services/track.service.js';
import { upsertWork } from '../services/work.service.js';
import { syncWorkTracks } from './trackSync.js';

setupTestEnvironment();

const WORK = 'RJ00000002';

test('syncWorkTracks：首轮入库带时长，次轮无变更零动作', async () => {
  await upsertWork({
    id: WORK,
    rootFolder: 'lib',
    dir: 'd',
    title: 'T',
    circleName: 'C',
    tags: [],
    vas: [],
  });
  const wav = readFileSync(
    join(import.meta.dir, '../../test/fixtures/audio/sine.wav'),
  );
  const src = memorySource({ 'a.wav': wav, 'b.wav': wav });
  const tree = entriesToTrackTree(['a.wav', 'b.wav']);

  const first = await syncWorkTracks(WORK, src, tree);
  expect(first.added).toBe(2);
  const rows = await getTrackRows(WORK);
  expect(rows).toHaveLength(2);
  expect(rows[0]?.durationSec).toBeGreaterThan(0.7);

  const second = await syncWorkTracks(WORK, src, tree);
  expect(second).toEqual({ added: 0, updated: 0, removed: 0 });
});

test('size 变化 → 重探测更新；消失 → 删行', async () => {
  const wav = readFileSync(
    join(import.meta.dir, '../../test/fixtures/audio/sine.wav'),
  );
  const tree = entriesToTrackTree(['a.wav']);
  await syncWorkTracks(WORK, memorySource({ 'a.wav': wav }), tree);

  // 内容变长（两个 wav 拼接 → size 变化）
  const r = await syncWorkTracks(
    WORK,
    memorySource({ 'a.wav': Buffer.concat([wav, wav]) }),
    tree,
  );
  expect(r.updated).toBe(1);
  expect((await getTrackRows(WORK))[0]?.sizeBytes).toBe(wav.length * 2);

  // 条目消失（buildTree 后树里不再有该条目 → 叶子为空 → 全部删行）
  const r2 = await syncWorkTracks(
    WORK,
    memorySource({}),
    entriesToTrackTree([]),
  );
  expect(r2.removed).toBe(1);
  expect(await getTrackRows(WORK)).toEqual([]);
});
