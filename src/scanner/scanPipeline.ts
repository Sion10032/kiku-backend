import { join } from 'node:path';
import { folderHasMedia } from '../infra/fs/source/folder.js';
import { openWorkSource } from '../infra/fs/source/index.js';
import { treeHasMedia } from '../infra/fs/source/tree.js';
import { UnsupportedArchiveError } from '../infra/fs/source/types.js';
import type { WorkEntry } from '../infra/fs/utils.js';

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
 * 校验/处理阶段的任务收集器：失败任务的落点 + 任务 id 唯一来源。
 * 由编排层（scan 编排器）持有，discover 闭包写入。
 */
export interface ScanCollector {
  failedTasks: Array<{ title: string; error: string }>;
}

/** 校验段的直通日志（转 BATCH_LOG）。 */
export interface DiscoveryLog {
  level: string;
  message: string;
}

/** 校验段判失败的单条（unsupported 归档 / 打不开的包），计入 SUMMARY failed。 */
export interface DiscoveryFailure {
  title: string;
  error: string;
}

/**
 * 校验流水线的单条产出：直通日志 + 失败条目，或通过校验的待注入任务。
 */
export type DiscoveryOutput =
  | { kind: 'events'; logs: DiscoveryLog[]; failures: DiscoveryFailure[] }
  | {
      kind: 'task';
      workCode: string;
      title: string;
      relativePath: string;
      rootFolder: string;
      dirName: string;
      absDir?: string;
      moved: boolean;
    };

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
  const queue: R[] = [];
  const waiters: Array<() => void> = [];
  let closed = false;
  const push = (item: R): void => {
    queue.push(item);
    waiters.shift()?.();
  };
  const close = (): void => {
    closed = true;
    for (const w of waiters.splice(0)) w();
  };
  const next = (): Promise<R | null> => {
    const item = queue.shift();
    if (item !== undefined) return Promise.resolve(item);
    if (closed) return Promise.resolve(null);
    return new Promise<void>((resolve) => waiters.push(resolve)).then(
      () => queue.shift() ?? null,
    );
  };

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
            if (r !== null) push(r);
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
      close();
    }
  })();
  try {
    for (;;) {
      const r = await next();
      if (r === null) break;
      yield r;
    }
  } finally {
    await producer;
  }
}

/**
 * 单条目校验：unsupported 上报 / folder 提前退出探测 / archive 建索引校验。
 * 产出直通日志 + 失败条目，或通过校验的待注入任务。
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
    const error = String(
      new UnsupportedArchiveError(entry.name, '不是 tar / stored zip 格式'),
    );
    const title = `${entry.workCode} ${entry.name}`;
    collector.failedTasks.push({ title, error });
    return {
      kind: 'events',
      logs: [{ level: 'error', message: `Unsupported archive: ${title}` }],
      failures: [{ title, error }],
    };
  }

  // 新作品/路径变更/软删复活：校验含音频才建任务。
  // folder 用可提前退出的轻量遍历（首个可服务音频即返回，避免全量建树）；
  // archive 仍打开 source 建索引后建树（索引是后续读取的前提）。
  try {
    let hasMedia = false;
    if (entry.kind === 'folder') {
      hasMedia = await folderHasMedia(join(rootPath, entry.relativePath));
    } else {
      const source = await openWorkSource(rootPath, entry.relativePath);
      hasMedia = treeHasMedia(await source.buildTree());
    }
    if (!hasMedia) {
      // 无音频/视频只记日志，不产生任务
      return {
        kind: 'events',
        logs: [
          {
            level: 'info',
            message: `Skipped (no audio/video): ${entry.workCode} ${entry.name}`,
          },
        ],
        failures: [],
      };
    }

    return {
      kind: 'task',
      workCode: entry.workCode,
      title: `${entry.workCode} ${entry.name}`,
      relativePath: entry.relativePath,
      rootFolder: rootName,
      dirName: entry.name,
      // 手动分支导入本地封面需要绝对路径（根目录绝对路径 + relativePath）
      absDir: join(rootPath, entry.relativePath),
      // moved：DB 已有未软删记录、仅路径变更 → 跳过元数据抓取
      moved: knownSourceId !== undefined,
    };
  } catch (err) {
    // 打不开/不支持的包：作为失败条目上报
    const errMsg = err instanceof Error ? err.message : String(err);
    const title = `${entry.workCode} ${entry.name}`;
    collector.failedTasks.push({ title, error: errMsg });
    return {
      kind: 'events',
      logs: [
        {
          level: 'error',
          message: `Failed to open: ${entry.workCode} ${entry.name} - ${errMsg}`,
        },
      ],
      failures: [{ title, error: errMsg }],
    };
  }
}

/**
 * 校验流水线：各 root 的待处理条目并发校验（DISCOVERY_CHECK_PARALLELISM），
 * 校验通过即产出任务供编排器注入，直通日志透传给消费方。
 * 失败条目写入 collector（编排层由此统计）。
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
