// 播放触发的单轨响度分析（progress 钩子 → 守卫 → 入队）。
// 不走 runAnalysisOrchestration 的 startBatch/barrier 编排：单轨任务不建批次卡片
// （听一张专辑几十轨会刷满任务面板），状态经任务事件流（TASK_DELTA）自然透出。
// 永不 reject（fire-and-forget 调用方不 await）：内部兜底记日志。

import { checkFfmpegAvailable } from '../../infra/audio/ffmpeg.js';
import { getConfig } from '../../infra/config/index.js';
import { isTrackAnalysisEligible } from '../../services/track.service.js';
import { getTaskSystem, type TaskSystem } from '../taskSystem.js';

export interface TrackAnalysisOptions {
  /** 测试注入；缺省用生产单例。 */
  sys?: TaskSystem;
}

/** ffmpeg 可用性缓存：按 ffmpegPath 键控 + 60s TTL（路径改/装好 ffmpeg 后自动失效重查）。 */
const FFMPEG_CACHE_TTL_MS = 60_000;
let ffmpegCache: { path: string; ok: boolean; at: number } | null = null;

async function ffmpegAvailableCached(): Promise<boolean> {
  const path = getConfig().ffmpegPath;
  const now = Date.now();
  if (
    ffmpegCache &&
    ffmpegCache.path === path &&
    now - ffmpegCache.at < FFMPEG_CACHE_TTL_MS
  ) {
    return ffmpegCache.ok;
  }
  const ok = await checkFfmpegAvailable();
  ffmpegCache = { path, ok, at: now };
  return ok;
}

/** 测试专用：清 ffmpeg 可用性缓存。 */
export function resetTrackAnalysisFfmpegCacheForTesting(): void {
  ffmpegCache = null;
}

/**
 * 播放中按需单轨分析入口（progress 上报钩子调用，可安全 void）：
 * 开关关 / 轨已分析或已失败 / 作品软删 / ffmpeg 缺失 → 静默跳过；
 * 否则入 cpu 池高优任务（同 key 去重与优先级语义见 TaskSystem.submitTrackAnalysis）。
 */
export async function maybeEnqueueTrackAnalysis(
  workId: string,
  mediaIndex: string,
  options: TrackAnalysisOptions = {},
): Promise<void> {
  try {
    if (!getConfig().loudnessAnalysisOnPlay) return;
    if (!(await isTrackAnalysisEligible(workId, mediaIndex))) return;
    if (!(await ffmpegAvailableCached())) return;
    (options.sys ?? getTaskSystem()).submitTrackAnalysis(workId, mediaIndex);
  } catch (err) {
    console.error('[analysis] on-play enqueue failed:', err);
  }
}
