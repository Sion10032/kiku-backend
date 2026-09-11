import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pipeline } from 'node:stream/promises';
import { getConfig } from '../config/index.js';
import type { WorkSource } from '../fs/source/types.js';

/** 解析 ebur128 汇总段的 I（LUFS）与 Peak（dBFS）。 */
export function parseIntegratedLoudness(stderr: string): {
  lufs: number;
  truePeakDb: number;
} {
  const i = /I:\s*(-?[\d.]+|-inf)\s*LUFS/.exec(stderr);
  const peak = /Peak:\s*(-?[\d.]+|-inf)\s*dBFS/.exec(stderr);
  if (!i || !peak)
    throw new Error(
      `ebur128 summary not found in stderr:\n${stderr.slice(-500)}`,
    );
  if (i[1] === '-inf' || peak[1] === '-inf')
    throw new Error('audio is silent (loudness -inf)');
  return { lufs: Number(i[1]), truePeakDb: Number(peak[1]) };
}

export function runFfmpeg(
  args: string[],
  signal?: AbortSignal,
): Promise<{ stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const proc = spawn(getConfig().ffmpegPath, args, { signal });
    let stdout = '';
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => {
      stdout += c.toString();
    });
    proc.stderr.on('data', (c: Buffer) => {
      stderr += c.toString();
    });
    proc.on('error', reject); // ENOENT（找不到 ffmpeg）
    proc.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-500)}`));
    });
  });
}

let availableCache: boolean | null = null;
export async function checkFfmpegAvailable(): Promise<boolean> {
  if (availableCache !== null) return availableCache;
  availableCache = await runFfmpeg(['-version'])
    .then(() => true)
    .catch(() => false);
  return availableCache;
}

/** 解析 ametadata=print 输出：按 floor(pts_time) 秒分桶取末值 S，不可测量（-inf 或 ≤ -70）→ null，保留 1 位小数。 */
export function parseLoudnessCurve(stdout: string): Array<number | null> {
  const buckets = new Map<number, number | null>();
  let time = 0;
  for (const line of stdout.split('\n')) {
    const t = /pts_time:([\d.]+)/.exec(line);
    if (t) {
      time = Number(t[1]);
      continue;
    }
    const s = /lavfi\.r128\.S=(-[\d.]+|-inf)/.exec(line);
    if (!s) continue;
    // ffmpeg ≥8 对未满窗的 short-term 输出 -120.691 而非 -inf，
    // -70 LUFS 为「不可测量」门限（正常音频不会 ≤ -70），两者均存 null。
    const value = s[1] === '-inf' ? -Infinity : Number(s[1]);
    const sec = Math.floor(time);
    buckets.set(sec, value <= -70 ? null : Math.round(value * 10) / 10);
  }
  // 补齐空洞（某秒无帧输出极罕见，防御性填 null）
  const curve: Array<number | null> = [];
  for (let i = 0; i <= (buckets.size ? Math.max(...buckets.keys()) : -1); i++) {
    curve.push(buckets.get(i) ?? null);
  }
  return curve;
}

/** 单遍测量：Integrated loudness + True Peak（stderr 汇总）+ short-term 曲线（stdout）。 */
export async function measureLoudness(
  inputPath: string,
  signal?: AbortSignal,
): Promise<{ lufs: number; truePeakDb: number; curve: Array<number | null> }> {
  const { stdout, stderr } = await runFfmpeg(
    [
      '-hide_banner',
      '-nostats',
      '-i',
      inputPath,
      '-map',
      '0:a:0',
      '-af',
      'ebur128=peak=true:metadata=1,ametadata=print:key=lavfi.r128.S:file=-',
      '-f',
      'null',
      '-',
    ],
    signal,
  );
  return {
    ...parseIntegratedLoudness(stderr),
    curve: parseLoudnessCurve(stdout),
  };
}

/** 归档源条目 → 临时文件（响度分析需要 seekable 输入，且 mp4 家族 pipe 读不了尾部 moov）。 */
export async function extractToTemp(
  source: WorkSource,
  hash: string,
  signal?: AbortSignal,
): Promise<{ path: string; cleanup: () => Promise<void> }> {
  const dir = await mkdtemp(join(tmpdir(), 'kiku-analysis-'));
  const name = hash.split('/').pop() ?? 'track';
  const path = join(dir, name);
  const size = await source.size(hash);
  try {
    const stream = await source.readRange(hash, 0, size - 1);
    await pipeline(stream, createWriteStream(path), { signal });
  } catch (err) {
    await rm(dir, { recursive: true, force: true });
    throw err;
  }
  return { path, cleanup: () => rm(dir, { recursive: true, force: true }) };
}
