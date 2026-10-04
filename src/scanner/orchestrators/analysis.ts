// analysis 编排器（产源角色）：ffmpeg 可用性检查 → 待分析作品注入 [analyze] → barrier → SUMMARY。
// 每次调用 = 独立批次；AnalysisManager 的 priority/queuedLow/drainFullLow/runSeq/收尾接力
// 状态机整体删除——「已跑时受理排队」由队列天然支持（新任务继续入队），
// 手动 high 与 scan 接力 low 在 cpu 池内按优先级保序（spec §5）。

import { randomUUID } from 'node:crypto';
import { checkFfmpegAvailable } from '../../infra/audio/ffmpeg.js';
import type { Config } from '../../infra/config/schema.js';
import { getPendingAnalysisWorkIds } from '../../services/track.service.js';
import type { AnalysisSummaryResults } from '../taskEvents.js';
import { getTaskSystem, type TaskSystem } from '../taskSystem.js';

export interface AnalysisOrchestrationOptions {
  /** 测试注入；缺省用生产单例。 */
  sys?: TaskSystem;
  /** 路由层生成（立即可返回给前端）；缺省内部生成。 */
  batchId?: string;
}

/**
 * 执行一次响度分析（全量 pending 或指定子集）。返回 SUMMARY；null = ffmpeg 缺失或被取消。
 * priority：low = scan 收尾接力 / 全量；high = 作品页手动触发（cpu 池内插队）。
 */
export async function runAnalysisOrchestration(
  config: Config,
  signal: AbortSignal,
  workIds?: string[],
  priority: 'low' | 'high' = 'low',
  options: AnalysisOrchestrationOptions = {},
): Promise<AnalysisSummaryResults | null> {
  void config; // 并发宽度由队列 cpu 池持有（analysisParallelism）；config 留作签名对齐
  const sys = options.sys ?? getTaskSystem();
  const batchId = options.batchId ?? `analysis-${randomUUID()}`;

  try {
    // ffmpeg 缺失：立即失败收尾（对齐现状 ANALYSIS_ERROR），不注入任何任务
    if (!(await checkFfmpegAvailable())) {
      sys.startBatch('analysis', batchId);
      sys.log(
        'error',
        'ffmpeg not found — install ffmpeg or set ffmpegPath in config',
        batchId,
      );
      sys.finishBatch(batchId, 'failed');
      return null;
    }

    sys.startBatch('analysis', batchId);

    const targets = workIds ?? (await getPendingAnalysisWorkIds());
    if (targets.length === 0) {
      sys.log('info', 'Nothing to analyze', batchId);
    } else {
      sys.log(
        'info',
        `Analyzing ${targets.length} works (priority ${priority})`,
        batchId,
      );
      sys.submit(targets, ['analyze'], {
        priority,
        batchId,
        mode: 'if-needed',
      });
    }

    const outcome = await sys.barrier(batchId);

    // SUMMARY：analyzed/failed 轨从阶段结果累计；failedWorks = 阶段级失败（全轨失败才判作品失败）
    let analyzedTracks = 0;
    let failedTracks = 0;
    for (const [key, res] of sys.batchResults(batchId)) {
      if (!key.startsWith('analyze:')) continue;
      analyzedTracks += res.detail?.analyzed ?? 0;
      failedTracks += res.detail?.failed ?? 0;
    }
    const summary: AnalysisSummaryResults = {
      totalWorks: targets.length,
      analyzedTracks,
      failedTracks,
      failedWorks: outcome.failed,
    };

    const cancelled = signal.aborted;
    sys.finishBatch(batchId, cancelled ? 'cancelled' : 'completed', summary);
    return cancelled ? null : summary;
  } catch (err) {
    sys.finishBatch(batchId, signal.aborted ? 'cancelled' : 'failed');
    if (signal.aborted) return null;
    throw err;
  }
}
