// update 编排器（产源角色）：DB 已有作品重抓 DLsite 元数据（force 语义），
// 并顺带音轨 diff 回填。与 scan 共用 scan:all 互斥身份（对齐现状单飞）；
// manual 作品跳过（零网络红线）；不扫文件系统、不 prune（对齐现状 performUpdate）。

import { randomUUID } from 'node:crypto';
import type { Config } from '../../infra/config/schema.js';
import { workSourceResolver } from '../../infra/sources/index.js';
import { getAllWorkRefs } from '../../services/work.service.js';
import type { ScanSummaryResults } from '../taskEvents.js';
import { getTaskSystem, type TaskSystem } from '../taskSystem.js';
import { acquireIdentity, releaseIdentity, SCAN_ALL_IDENTITY } from './scan.js';

function abortError(): Error {
  return new DOMException('Scan aborted', 'AbortError');
}

export interface UpdateOrchestrationOptions {
  /** 测试注入；缺省用生产单例。 */
  sys?: TaskSystem;
  /** 路由层生成（立即可返回给前端）；缺省内部生成。 */
  batchId?: string;
}

/**
 * 执行一次元数据更新（全量或子集）。返回 SUMMARY；null = scan:all 已在跑或被取消。
 * 与 scan 的差异：mode=force（重抓是显式意图，if-needed 会因 TTL 内 completed 而跳过）。
 */
export async function runUpdateOrchestration(
  config: Config,
  signal: AbortSignal,
  workIds?: string[],
  options: UpdateOrchestrationOptions = {},
): Promise<ScanSummaryResults | null> {
  const sys = options.sys ?? getTaskSystem();
  if (!acquireIdentity(SCAN_ALL_IDENTITY)) return null;
  const batchId = options.batchId ?? `update-${randomUUID()}`;

  try {
    sys.startBatch('update', batchId);
    sys.log('info', 'Starting metadata update...', batchId);
    void config; // 并发宽度由队列池持有（net=maxParallelism）；config 留作签名对齐

    let refs = await getAllWorkRefs();
    if (workIds) {
      const wanted = new Set(workIds);
      refs = refs.filter((ref) => wanted.has(ref.id));
    }
    sys.log('info', `Found ${refs.length} works in database`, batchId);

    let skippedManual = 0;
    for (const ref of refs) {
      if (signal.aborted) throw abortError();

      // 手动作品无 DLsite 远端元数据：记日志跳过，不建任务
      if (workSourceResolver.classify(ref.id) === 'manual') {
        skippedManual++;
        sys.log(
          'info',
          `Skipped (manual work, no remote source): ${ref.id}`,
          batchId,
        );
        continue;
      }

      sys.submit([ref.id], ['metadata', 'cover', 'track'], {
        priority: 'low',
        batchId,
        mode: 'force',
        locations: {
          [ref.id]: {
            rootFolder: ref.rootFolder,
            relativePath: ref.dir,
            dirName: ref.dir,
          },
        },
      });
    }

    const outcome = await sys.barrier(batchId);

    // SUMMARY（对齐现状口径：update 重抓已有作品，created 计数通常全落 updated）
    let added = 0;
    let updated = 0;
    for (const [key, res] of sys.batchResults(batchId)) {
      if (!key.startsWith('metadata:')) continue;
      if (res.created) added++;
      else updated++;
    }
    const summary: ScanSummaryResults = {
      total: refs.length,
      added,
      updated,
      failed: outcome.failed,
      skipped: skippedManual,
      removed: 0,
      purged: 0,
    };

    const cancelled = signal.aborted;
    sys.finishBatch(batchId, cancelled ? 'cancelled' : 'completed', summary);
    return cancelled ? null : summary;
  } catch (err) {
    sys.finishBatch(batchId, signal.aborted ? 'cancelled' : 'failed');
    if (signal.aborted) return null; // 取消语义（对齐 scan 编排器）
    throw err;
  } finally {
    releaseIdentity(SCAN_ALL_IDENTITY);
  }
}
