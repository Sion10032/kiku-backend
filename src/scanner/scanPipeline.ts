import { join } from 'node:path';
import { folderHasAudio } from '../infra/fs/source/folder.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import { treeHasAudio } from '../infra/fs/source/tree.js';
import { UnsupportedArchiveError } from '../infra/fs/source/types.js';
import type { WorkEntry } from '../infra/fs/utils.js';
import { workSourceResolver } from '../infra/sources/index.js';
import {
  logEvent,
  type ScanEvent,
  type ScanTask,
  stripTask,
} from './scanEvents.js';

/** 校验流水线的单条产出：直通事件（校验段日志/失败任务）或待入池任务。 */
export type DiscoveryOutput =
  | { kind: 'events'; events: ScanEvent[] }
  | { kind: 'task'; task: ScanTask };

/** 校验并发宽度：纯本地 I/O（readdir/索引），与 DLsite 限流无关，可大于任务池宽度。 */
export const DISCOVERY_CHECK_PARALLELISM = 8;

/** 分流后待处理的单条条目；knownSourceId 存在 ⇒ moved（DB 已有未软删、仅路径变更） */
export interface PendingEntry {
  entry: WorkEntry;
  knownSourceId?: string | null;
}

/** 单个 root 分流后的待处理条目集合（校验流水线的输入） */
export interface PendingRoot {
  name: string;
  path: string;
  entries: PendingEntry[];
}

/**
 * 校验/处理阶段的任务收集器：任务与失败任务的落点 + 任务 id 唯一来源。
 * 由编排层（performScan）持有，discover 闭包写入。
 */
export interface ScanCollector {
  tasks: ScanTask[];
  failedTasks: ScanTask[];
  nextTaskId: number;
}

/**
 * 完成结果队列：并发 worker 完成时 push、单消费者 next() 逐个取出；
 * close 后取尽返回 null。单生产者单消费者，唤醒语义按此设计。
 */
class CompletionQueue<T> {
  private items: T[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;

  push(item: T): void {
    this.items.push(item);
    this.waiters.shift()?.();
  }

  close(): void {
    this.closed = true;
    for (const w of this.waiters.splice(0)) w();
  }

  async next(): Promise<T | null> {
    const item = this.items.shift();
    if (item !== undefined) return item;
    if (this.closed) return null;
    await new Promise<void>((resolve) => this.waiters.push(resolve));
    return this.items.shift() ?? null;
  }
}

/**
 * 有界并发映射：对 items 以固定宽度并发执行 fn，按完成序产出非 null 结果。
 * fn 契约：错误应自行容错为 null（抛错 = 该条目被跳过，仅记 console.warn）。
 * signal 中止时不再提交新项，in-flight 项收尾后结束。
 */
export async function* mapPool<T, R>(
  items: readonly T[],
  width: number,
  fn: (item: T) => Promise<R | null>,
  signal: AbortSignal,
): AsyncGenerator<R> {
  const queue = new CompletionQueue<R>();
  const inflight = new Set<Promise<void>>();
  const producer = (async () => {
    try {
      for (const item of items) {
        if (signal.aborted) break;
        while (inflight.size >= width) {
          await Promise.race(inflight);
        }
        const p = fn(item)
          .then((r) => {
            if (r !== null) queue.push(r);
          })
          .catch((err) => {
            // 吞错保底（防 rejection 经 Promise.race 崩溃 producer），
            // 但必须有观测出口：静默跳过会让故障不可知
            console.warn(
              `[scanner] mapPool item failed (skipped): ${
                err instanceof Error ? err.message : String(err)
              }`,
            );
          })
          .finally(() => {
            inflight.delete(p);
          });
        inflight.add(p);
      }
    } finally {
      await Promise.allSettled([...inflight]);
      queue.close();
    }
  })();
  try {
    for (;;) {
      const r = await queue.next();
      if (r === null) break;
      yield r;
    }
  } finally {
    await producer;
  }
}

/**
 * 有界并发任务池（流式输入）：任务源（校验流水线）边产出边入池，
 * 校验与处理两段重叠执行，发现一个处理一个，不再整批等待。
 * 事件时序：任务进窗口即时 yield pending/scanning（UI 实时可见），
 * 完成时整组 yield 终态与日志；直通事件原样透传。
 * maxParallelism 控制同时在飞的任务数（DLsite 抓取受其限流约束，默认保守）。
 * abort 时停止消费任务源并传播 AbortError（in-flight 任务由各自 catch 收尾）。
 */
export async function* runTaskPool(
  taskStream: AsyncGenerator<DiscoveryOutput>,
  parallelism: number,
  runTask: (task: ScanTask) => Promise<ScanEvent[]>,
  signal: AbortSignal,
): AsyncGenerator<ScanEvent> {
  const width = Math.max(1, parallelism);
  const queue = new CompletionQueue<ScanEvent[]>();
  const inflight = new Set<Promise<void>>();

  const producer = (async () => {
    try {
      for await (const out of taskStream) {
        if (signal.aborted)
          throw new DOMException('Scan aborted', 'AbortError');
        if (out.kind === 'events') {
          queue.push(out.events);
          continue;
        }
        while (inflight.size >= width) {
          await Promise.race(inflight);
        }
        const task = out.task;
        // 进窗口即开跑：排队与开始执行状态即时推送，不随完成组缓冲
        queue.push([
          {
            type: 'SCAN_TASK',
            task: stripTask({ ...task, status: 'pending' }),
          },
          {
            type: 'SCAN_TASK',
            task: stripTask({ ...task, status: 'scanning' }),
          },
        ]);
        task.status = 'scanning';
        const p = runTask(task)
          .then((events) => queue.push(events))
          .catch((err) => {
            // 保底：runTask 契约要求自行容错为失败终态；意外抛错时在此
            // 转失败终态，保证任务必有终态事件且 rejection 不崩溃 producer
            task.status = 'failed';
            task.error = err instanceof Error ? err.message : String(err);
            queue.push([
              logEvent('error', `Failed: ${task.title} - ${task.error}`),
              { type: 'SCAN_TASK', task: stripTask(task) },
            ]);
          })
          .finally(() => {
            inflight.delete(p);
          });
        inflight.add(p);
      }
    } finally {
      await Promise.allSettled([...inflight]);
      queue.close();
    }
  })();

  try {
    for (;;) {
      const events = await queue.next();
      if (events === null) break;
      for (const ev of events) yield ev;
    }
  } finally {
    // 传播 producer 异常（含 abort；任务级错误已在 runTask 内部消化）
    await producer;
  }
}

/**
 * 单条目校验：unsupported 上报 / folder 提前退出探测 / archive 建索引校验。
 * 产出直通事件（日志/失败任务，失败任务落 collector.failedTasks）
 * 或待入池任务（落 collector.tasks）。id 在同步段内分配（原子）。
 */
async function checkEntry(
  rootName: string,
  rootPath: string,
  entry: WorkEntry,
  collector: ScanCollector,
  knownSourceId?: string | null,
): Promise<DiscoveryOutput | null> {
  // unsupported-archive: 明确失败而非静默跳过
  if (entry.kind === 'unsupported-archive') {
    const task: ScanTask = {
      id: ++collector.nextTaskId,
      title: `${entry.workCode} ${entry.name}`,
      relativePath: entry.relativePath,
      rootFolder: rootName,
      workCode: entry.workCode,
      dirName: entry.name,
      status: 'failed',
      error: String(
        new UnsupportedArchiveError(entry.name, '不是 tar / stored zip 格式'),
      ),
    };
    collector.failedTasks.push(task);
    return {
      kind: 'events',
      events: [
        logEvent('error', `Unsupported archive: ${task.title}`),
        { type: 'SCAN_TASK', task: stripTask(task) },
      ],
    };
  }

  // 新作品/路径变更/软删复活：校验含音频才建任务。
  // folder 用可提前退出的轻量遍历（首个可服务音频即返回，避免全量建树）；
  // archive 仍打开 source 建索引后建树（索引是后续读取的前提）。
  try {
    let hasAudio = false;
    if (entry.kind === 'folder') {
      hasAudio = await folderHasAudio(join(rootPath, entry.relativePath));
    } else {
      const source = await openWorkSource(rootPath, entry.relativePath);
      hasAudio = treeHasAudio(await source.buildTree());
    }
    if (!hasAudio) {
      // 无音频只记日志，不产生任务事件
      return {
        kind: 'events',
        events: [
          logEvent(
            'info',
            `Skipped (no audio): ${entry.workCode} ${entry.name}`,
          ),
        ],
      };
    }

    const task: ScanTask = {
      id: ++collector.nextTaskId,
      title: `${entry.workCode} ${entry.name}`,
      relativePath: entry.relativePath,
      rootFolder: rootName,
      workCode: entry.workCode,
      dirName: entry.name,
      status: 'pending',
      // 手动分支导入本地封面需要绝对路径（根目录绝对路径 + relativePath）
      absDir: join(rootPath, entry.relativePath),
      // moved：DB 已有未软删记录、仅路径变更 → 跳过元数据抓取
      moved: knownSourceId !== undefined,
      knownSourceId: knownSourceId ?? undefined,
    };
    collector.tasks.push(task);
    return { kind: 'task', task };
  } catch (err) {
    // 打不开/不支持的包：作为失败任务上报
    const errMsg = err instanceof Error ? err.message : String(err);
    const task: ScanTask = {
      id: ++collector.nextTaskId,
      title: `${entry.workCode} ${entry.name}`,
      relativePath: entry.relativePath,
      rootFolder: rootName,
      workCode: entry.workCode,
      dirName: entry.name,
      status: 'failed',
      error: errMsg,
    };
    collector.failedTasks.push(task);
    return {
      kind: 'events',
      events: [
        logEvent(
          'error',
          `Failed to open: ${entry.workCode} ${entry.name} - ${errMsg}`,
        ),
        { type: 'SCAN_TASK', task: stripTask(task) },
      ],
    };
  }
}

/**
 * 校验流水线：各 root 的待处理条目并发校验（DISCOVERY_CHECK_PARALLELISM），
 * 校验通过即产出任务供任务池入池，直通事件透传给消费方。
 * 任务/失败任务写入 collector（编排层由此统计与跟踪）。
 */
export async function* discoverTasks(
  pendingRoots: PendingRoot[],
  collector: ScanCollector,
  signal: AbortSignal,
): AsyncGenerator<DiscoveryOutput> {
  for (const root of pendingRoots) {
    if (signal.aborted) throw new DOMException('Scan aborted', 'AbortError');
    yield* mapPool(
      root.entries,
      DISCOVERY_CHECK_PARALLELISM,
      (item) =>
        checkEntry(
          root.name,
          root.path,
          item.entry,
          collector,
          item.knownSourceId,
        ),
      signal,
    );
  }
}
