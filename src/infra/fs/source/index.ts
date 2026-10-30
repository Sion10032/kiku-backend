// 作品源分发：目录 → folder；.tar / .zip → 带 LRU 缓存的 tar / zip source。
// 缓存正确性靠 (mtimeMs, size) 指纹失效；活跃条目靠滑动 TTL 常驻；
// 内存由 16MB 总预算主控，maxEntries 仅兜底估算偏低与每条目固定对象开销。
import { type Stats, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { createFolderSource } from './folder.js';
import { createTarSource } from './tar.js';
import { UnsupportedArchiveError, type WorkSource } from './types.js';
import { createZipSource } from './zip.js';

export type { WorkSource } from './types.js';

interface CachePolicy {
  maxEntries: number;
  maxBytes: number;
  ttlMs: number;
}

interface SourceFingerprint {
  mtimeMs: number;
  size: number;
}

interface ReadyEntry extends SourceFingerprint {
  kind: 'ready';
  source: WorkSource;
  lastAccessAt: number;
  approxBytes: number;
}

/** 构建中的占位：并发 open 同一路径共享同一个 promise，避免击穿。 */
interface BuildingEntry {
  kind: 'building';
  promise: Promise<WorkSource>;
}

type CacheEntry = ReadyEntry | BuildingEntry;

const DEFAULT_POLICY: CachePolicy = {
  maxEntries: 512,
  maxBytes: 16 * 1024 * 1024,
  ttlMs: 3_600_000,
};

let policy: CachePolicy = { ...DEFAULT_POLICY };

/** key = 归档绝对路径；Map 插入顺序即 LRU 顺序（首键最冷）。 */
const cache = new Map<string, CacheEntry>();

function approxBytesOf(source: WorkSource): number {
  return source.approxIndexBytes?.() ?? 0;
}

/** 插入后执行：先清扫过期条目，再按 LRU 序淘汰到条目数与总内存都不超预算。 */
function enforceLimits(): void {
  const now = Date.now();
  for (const [key, entry] of cache) {
    if (entry.kind === 'ready' && now - entry.lastAccessAt >= policy.ttlMs) {
      cache.delete(key);
    }
  }

  let totalBytes = 0;
  for (const entry of cache.values()) {
    if (entry.kind === 'ready') totalBytes += entry.approxBytes;
  }

  while (cache.size > policy.maxEntries || totalBytes > policy.maxBytes) {
    const oldest = cache.keys().next();
    if (oldest.done) break;
    const entry = cache.get(oldest.value);
    cache.delete(oldest.value);
    if (entry?.kind === 'ready') totalBytes -= entry.approxBytes;
  }
}

async function openCached(
  fullPath: string,
  fingerprint: SourceFingerprint,
  build: () => Promise<WorkSource>,
): Promise<WorkSource> {
  const now = Date.now();
  const cached = cache.get(fullPath);
  if (cached) {
    if (cached.kind === 'building') return await cached.promise;
    const fresh =
      cached.mtimeMs === fingerprint.mtimeMs &&
      cached.size === fingerprint.size &&
      now - cached.lastAccessAt < policy.ttlMs;
    if (fresh) {
      cached.lastAccessAt = now;
      // LRU 前移：先删再插，落到 Map 尾部
      cache.delete(fullPath);
      cache.set(fullPath, cached);
      return cached.source;
    }
    cache.delete(fullPath);
  }

  const promise: Promise<WorkSource> = build()
    .then((source) => {
      const entry: ReadyEntry = {
        kind: 'ready',
        source,
        mtimeMs: fingerprint.mtimeMs,
        size: fingerprint.size,
        lastAccessAt: Date.now(),
        approxBytes: approxBytesOf(source),
      };
      cache.delete(fullPath);
      cache.set(fullPath, entry);
      enforceLimits();
      return source;
    })
    .catch((error: unknown) => {
      // 构建失败：移除在途占位，坏 source 绝不进缓存（下次 open 重新构建）
      const current = cache.get(fullPath);
      if (current?.kind === 'building' && current.promise === promise) {
        cache.delete(fullPath);
      }
      throw error;
    });

  cache.set(fullPath, { kind: 'building', promise });
  return await promise;
}

export async function openWorkSource(
  rootFolderPath: string,
  workDir: string,
): Promise<WorkSource> {
  const fullPath = join(rootFolderPath, workDir);
  let stats: Stats;
  try {
    stats = statSync(fullPath);
  } catch {
    throw new Error(`work path not found: ${workDir}`);
  }
  if (stats.isDirectory()) return createFolderSource(fullPath);

  // 复用同一次 stat：目录判断已用过，指纹再取 mtime/size
  const fingerprint: SourceFingerprint = {
    mtimeMs: stats.mtimeMs,
    size: stats.size,
  };
  const ext = extname(fullPath).toLowerCase();
  if (ext === '.tar') {
    return await openCached(fullPath, fingerprint, () =>
      createTarSource(fullPath),
    );
  }
  if (ext === '.zip') {
    return await openCached(fullPath, fingerprint, () =>
      createZipSource(fullPath),
    );
  }
  throw new UnsupportedArchiveError(
    workDir,
    '不是 tar / stored zip 格式的作品包',
  );
}

/** 测试钩子：清空缓存并恢复默认策略。 */
export function __resetSourceCacheForTesting(): void {
  cache.clear();
  policy = { ...DEFAULT_POLICY };
}

/** 测试钩子：部分覆盖策略（未传字段保持当前值）。 */
export function __setSourceCachePolicyForTesting(overrides: {
  maxEntries?: number;
  maxBytes?: number;
  ttlMs?: number;
}): void {
  if (overrides.maxEntries !== undefined) {
    policy.maxEntries = overrides.maxEntries;
  }
  if (overrides.maxBytes !== undefined) {
    policy.maxBytes = overrides.maxBytes;
  }
  if (overrides.ttlMs !== undefined) {
    policy.ttlMs = overrides.ttlMs;
  }
}
