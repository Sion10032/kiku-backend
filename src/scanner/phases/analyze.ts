// analyze 阶段执行体：单作品响度分析（analysis.ts analyzeWork 的拆入）。
// 只处理 loudness IS NULL 的行（重跑只补未完成轨，天然可重试）；
// folder 源直接拼路径；归档源流式测量（readRange 全量流 pipe 进 ffmpeg stdin，不经临时文件），
// 不可流式格式（mp4 家族尾部 moov）先跳过不分析——行保持 NULL 待扩展后重跑。
// 单轨失败写 analyzeError 不中断（对齐现状）；全部轨失败才抛错（fail-pipeline）。
// 由 cpu 池调度，ffmpeg 缺失检查在编排器层。

import { extname, join } from 'node:path';
import type { Readable } from 'node:stream';
import {
  measureLoudness,
  measureLoudnessStream,
} from '../../infra/audio/ffmpeg.js';
import { openWorkSource } from '../../infra/fs/source/index.js';
import { getRootFolderPathByName } from '../../services/rootFolder.service.js';
import {
  computeWorkLoudness,
  getTrackRows,
  setTrackLoudness,
} from '../../services/track.service.js';
import { getWorkRow } from '../../services/work.service.js';
import type { PhaseExecutor } from './types.js';

function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** 可从不可 seek 输入（pipe）单遍分析的音频扩展名；mp4 家族（尾部 moov）除外，先跳过待扩展。 */
export const STREAMABLE_MEASURE_EXTS = new Set([
  '.mp3',
  '.flac',
  '.ogg',
  '.oga',
  '.opus',
  '.wav',
]);

export const analyzeExecutor: PhaseExecutor = async (ctx) => {
  const { workId, signal, log } = ctx;

  const work = await getWorkRow(workId);
  if (!work) throw new Error(`work ${workId} not found`);
  const rootPath = await getRootFolderPathByName(work.rootFolder);
  if (!rootPath) throw new Error(`root folder ${work.rootFolder} missing`);

  const source = await openWorkSource(rootPath, work.dir);
  const rows = (await getTrackRows(workId)).filter(
    (r) => r.loudnessLufs === null,
  );
  let analyzed = 0;
  let failed = 0;
  let skipped = 0;

  for (const row of rows) {
    if (signal.aborted)
      throw new DOMException('Analysis aborted', 'AbortError');

    // 归档源不可流式格式：先跳过不分析（行保持 NULL，待扩展后重跑补齐）
    const ext = extname(row.mediaIndex).toLowerCase();
    if (source.kind !== 'folder' && !STREAMABLE_MEASURE_EXTS.has(ext)) {
      skipped++;
      log(
        'warning',
        `Track skipped, archive source not streamable yet (${ext}): ${workId} ${row.mediaIndex}`,
      );
      continue;
    }

    let input: Readable | null = null;
    try {
      let result: {
        lufs: number;
        truePeakDb: number;
        curve: Array<number | null>;
      };
      if (source.kind === 'folder') {
        result = await measureLoudness(
          join(rootPath, work.dir, row.mediaIndex),
          signal,
        );
      } else {
        // 归档源流式：readRange 全量流直接 pipe 进 ffmpeg stdin（省解压写盘/读盘/删除）
        const size = await source.size(row.mediaIndex);
        input = await source.readRange(row.mediaIndex, 0, size - 1);
        result = await measureLoudnessStream(input, signal);
      }
      await setTrackLoudness(workId, row.mediaIndex, result);
      analyzed++;
    } catch (err) {
      if (signal.aborted) throw err;
      await setTrackLoudness(workId, row.mediaIndex, {
        error: errMessage(err),
      });
      failed++;
      log(
        'error',
        `Track failed: ${workId} ${row.mediaIndex}: ${errMessage(err)}`,
      );
    } finally {
      // 错误路径释放未消费完的流（正常消费完自动结束，destroy 无害）
      input?.destroy();
    }
  }

  await computeWorkLoudness(workId);

  // 全部实际测量的轨都失败 → 阶段失败；失败行已写 analyzeError，重跑仍只处理 NULL 行
  if (analyzed === 0 && failed > 0) {
    throw new Error(`${failed} tracks failed`);
  }
  return { detail: { analyzed, failed, skipped } };
};
