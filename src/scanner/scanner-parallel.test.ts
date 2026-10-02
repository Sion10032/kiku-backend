import { afterAll, beforeAll, describe, expect, it, mock } from 'bun:test';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { buildZip } from '@test/helpers/archive.js';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';

setupTestEnvironment();

// fetchDLsiteWorkInfo 带延迟 + 并发峰值跟踪：断言任务池并发度受 maxParallelism 控制
let active = 0;
let peak = 0;
mock.module('../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (rjCode: string) => {
    active++;
    peak = Math.max(peak, active);
    await new Promise((resolve) => setTimeout(resolve, 30));
    active--;
    return {
      title: `测试作品 ${rjCode}`,
      circle: '测试社团',
      ageRating: 'all' as const,
      releaseDate: '2024-01-01',
      tags: [],
      vas: [],
      rateCountDetail: {},
      rank: [],
    };
  },
}));
mock.module('../services/cover.service.js', () => ({
  coverExists: () => true,
  downloadCover: async () => true,
  importLocalCover: async () => true,
  deleteAllCovers: () => 0,
}));

const { performScan } = await import('./scanner.js');
const { db } = await import('../infra/db/main/index.js');
const { works, rootFolders } = await import('../infra/db/main/schema.js');

let root: string;
const base = 800000 + Math.floor(Math.random() * 100000);
const ids = [`RJ${base}`, `RJ${base + 1}`, `RJ${base + 2}`];

async function runScan(maxParallelism: number) {
  const events: unknown[] = [];
  for await (const ev of performScan(
    {
      ...(await import('../infra/config/index.js')).getConfig(),
      scannerMaxRecursionDepth: 2,
      maxParallelism,
    },
    new AbortController().signal,
  )) {
    events.push(ev);
  }
  return events;
}

function resultsOf(events: unknown[]) {
  return events.find(
    (e): e is { type: 'SCAN_RESULTS'; results: { added: number } } =>
      (e as { type: string }).type === 'SCAN_RESULTS',
  )?.results;
}

beforeAll(async () => {
  await db.delete(works);
  await db.delete(rootFolders);
  root = mkdtempSync(join(tmpdir(), 'kiku-parallel-'));
  await ensureRootFolder('parroot', root);
  for (const id of ids) {
    writeFileSync(
      join(root, `${id}.zip`),
      buildZip([{ path: `${id}/01.mp3`, data: 'audio' }]),
    );
  }
});

afterAll(async () => {
  rmSync(root, { recursive: true, force: true });
  await db.delete(works).catch(() => {});
  await removeRootFolder('parroot');
});

describe('performScan 任务池并发', () => {
  it('maxParallelism=3：多个任务重叠执行且全部入库', async () => {
    peak = 0;
    active = 0;
    const events = await runScan(3);
    expect(resultsOf(events)?.added).toBe(3);
    expect(peak).toBe(3);
  });

  it('maxParallelism=1：完全串行（峰值为 1）', async () => {
    // 先清掉上一用例入库的作品，让本用例重新建任务
    await db.delete(works);
    peak = 0;
    active = 0;
    const events = await runScan(1);
    expect(resultsOf(events)?.added).toBe(3);
    expect(peak).toBe(1);
  });

  it('任务事件按提交顺序整组产出（每任务 pending → scanning → completed 连续）', async () => {
    await db.delete(works);
    const events = await runScan(3);
    const statuses = events
      .filter(
        (e): e is { type: 'SCAN_TASK'; task: { id: number; status: string } } =>
          (e as { type: string }).type === 'SCAN_TASK',
      )
      .map((e) => `${e.task.id}:${e.task.status}`);
    // 滑窗按提交顺序产出：pending 为发现阶段全量发出，
    // 处理阶段每任务 scanning → completed 连续且任务序递增（不跨任务交错）
    expect(statuses).toEqual([
      '1:pending',
      '2:pending',
      '3:pending',
      '1:scanning',
      '1:completed',
      '2:scanning',
      '2:completed',
      '3:scanning',
      '3:completed',
    ]);
  });
});
