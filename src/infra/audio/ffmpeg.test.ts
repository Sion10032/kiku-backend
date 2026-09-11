import { expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { memorySource } from '@test/helpers/memorySource.js';
import {
  checkFfmpegAvailable,
  extractToTemp,
  measureLoudness,
  parseIntegratedLoudness,
  parseLoudnessCurve,
} from './ffmpeg.js';

const SINE = join(import.meta.dir, '../../../test/fixtures/audio/sine.wav');

const EBUR128_STDERR = `
[Parsed_ebur128_0 @ 0x...] Summary:
  Integrated loudness:
    I:         -18.4 LUFS
    Threshold: -28.6 LUFS
  Loudness range:
    LRA:       5.1 LU
    Threshold: -38.6 LUFS
  True peak:
    Peak:      -0.8 dBFS
`;

test('解析 ebur128 汇总（I 与 True Peak）', () => {
  const { lufs, truePeakDb } = parseIntegratedLoudness(EBUR128_STDERR);
  expect(lufs).toBeCloseTo(-18.4, 5);
  expect(truePeakDb).toBeCloseTo(-0.8, 5);
});

test('全静音（-inf）抛错', () => {
  const silent = EBUR128_STDERR.replace('-18.4', '-inf');
  expect(() => parseIntegratedLoudness(silent)).toThrow();
});

const AMETADATA_STDOUT = `frame:0    pts:0       pts_time:0
lavfi.r128.S=-inf
frame:43   pts:45056   pts_time:1.021625
lavfi.r128.S=-18.42
frame:86   pts:90112   pts_time:2.043250
lavfi.r128.S=-17.94
frame:129  pts:135168  pts_time:3.064875
lavfi.r128.S=-17.91
`;

test('解析响度曲线（按秒分桶取末值，-inf → null，1 位小数）', () => {
  expect(parseLoudnessCurve(AMETADATA_STDOUT)).toEqual([
    null,
    -18.4,
    -17.9,
    -17.9,
  ]);
});

// ffmpeg ≥8 实测：未满窗 short-term 输出 -120.691 而非 -inf
const FF8_METADATA_STDOUT = `frame:0    pts:0       pts_time:0
lavfi.r128.S=-120.691
frame:43   pts:45056   pts_time:1.021625
lavfi.r128.S=-18.42
frame:86   pts:90112   pts_time:2.043250
lavfi.r128.S=-120.691
`;

test('ffmpeg ≥8 未满窗 -120.691 → null（≤ -70 不可测量门限）', () => {
  expect(parseLoudnessCurve(FF8_METADATA_STDOUT)).toEqual([null, -18.4, null]);
});

test('空 stdout → 空曲线', () => {
  expect(parseLoudnessCurve('')).toEqual([]);
});

test('extractToTemp 写出后可读，cleanup 删除', async () => {
  const data = readFileSync(SINE);
  const tmp = await extractToTemp(
    memorySource({ 'a/sine.wav': data }),
    'a/sine.wav',
  );
  try {
    expect(existsSync(tmp.path)).toBe(true);
    expect(readFileSync(tmp.path).byteLength).toBe(data.length);
  } finally {
    await tmp.cleanup();
  }
  expect(existsSync(tmp.path)).toBe(false);
});

// 集成用例：无 ffmpeg 的环境自动跳过（CI/精简 devShell）
const hasFfmpeg = await checkFfmpegAvailable();
test.skipIf(!hasFfmpeg)('measureLoudness 实测 fixture', async () => {
  const r = await measureLoudness(SINE);
  // 0.8s 440Hz 正弦（lavfi sine 默认振幅 ≈ -18 dBFS）：实测约 -21.6 LUFS，宽松断言防生成器差异
  expect(r.lufs).toBeGreaterThan(-25);
  expect(r.lufs).toBeLessThan(-15);
  expect(r.truePeakDb).toBeLessThanOrEqual(0);
  // 0.8s 轨至少落在第 0 秒桶（首 3s 窗未满 → null），只断言形状
  expect(r.curve.length).toBeGreaterThanOrEqual(1);
});
