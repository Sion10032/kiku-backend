import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../../infra/db/main/index.js';
import { works } from '../../infra/db/main/schema.js';
import { upsertWork } from '../../services/work.service.js';
import { coverExecutor } from './cover.js';
import type { PhaseContext, PhaseResult, WorkLocation } from './types.js';

setupTestEnvironment();

// 可控 mock：单作品一次 existingCoverTypes 查询（不逐类型查 blob、不全库拉取）
const downloadCalls: Array<{ id: string; type: string; sourceId?: string }> =
  [];
const importCalls: string[] = [];
let existingTypes = new Set<string>();
let existingCoverTypesCalls = 0;
let downloadError: Error | null = null;
let importResult = false;

mock.module('../../services/cover.service.js', () => ({
  existingCoverTypes: (id: string, types: string[]) => {
    existingCoverTypesCalls++;
    void id;
    void types;
    return existingTypes;
  },
  downloadCover: async (
    id: string,
    type: string,
    _signal: AbortSignal,
    sourceId?: string,
  ) => {
    if (downloadError) throw downloadError;
    downloadCalls.push({ id, type, sourceId });
    return true;
  },
  importLocalCover: async (id: string, dir: string) => {
    importCalls.push(`${id}@${dir}`);
    return importResult;
  },
}));

afterAll(async () => {
  await db.delete(works).where(eq(works.id, 'RJ500001'));
  await removeRootFolder('root-cover').catch(() => {});
});

function makeCtx(partial: Partial<PhaseContext> & { workId: string }): {
  ctx: PhaseContext;
  logs: Array<{ level: string; message: string }>;
} {
  const logs: Array<{ level: string; message: string }> = [];
  const location: WorkLocation = {
    rootFolder: 'root-cover',
    relativePath: partial.workId,
    absDir: `/tmp/${partial.workId}`,
  };
  return {
    logs,
    ctx: {
      variant: undefined,
      location,
      signal: new AbortController().signal,
      log: (level, message) => logs.push({ level, message }),
      force: false,
      ...partial,
    },
  };
}

describe('coverExecutor', () => {
  test('缺失类型才下载：existingCoverTypes 单作品一次查询', async () => {
    downloadCalls.length = 0;
    existingCoverTypesCalls = 0;
    existingTypes = new Set(['main']);
    const { ctx } = makeCtx({ workId: 'RJ500001' });
    await coverExecutor(ctx);
    expect(existingCoverTypesCalls).toBe(1); // 单作品仅一条查询
    expect(downloadCalls.map((c) => c.type).sort()).toEqual(['240x240', 'sam']);
  });

  test('全部封面已存在 → 零下载调用，且查询次数与类型数无关', async () => {
    downloadCalls.length = 0;
    existingCoverTypesCalls = 0;
    existingTypes = new Set(['main', 'sam', '240x240']);
    const { ctx, logs } = makeCtx({ workId: 'RJ500001' });
    const result: PhaseResult = await coverExecutor(ctx);
    expect(result).toEqual({});
    expect(downloadCalls).toHaveLength(0);
    expect(existingCoverTypesCalls).toBe(1);
    expect(logs).toHaveLength(0);
  });

  test('downloadCover 抛错（404 等）→ warning 日志，不抛错', async () => {
    downloadCalls.length = 0;
    existingTypes = new Set();
    downloadError = new Error('HTTP 404');
    const { ctx, logs } = makeCtx({ workId: 'RJ500001' });
    const result = await coverExecutor(ctx);
    expect(result).toEqual({});
    const warnings = logs.filter((l) => l.level === 'warning');
    expect(warnings.length).toBe(3); // 每个类型一条
    expect(warnings[0]?.message).toContain('HTTP 404');
    downloadError = null;
  });

  test('dlsite 作品：sourceId 用 DB 既有值', async () => {
    downloadCalls.length = 0;
    existingTypes = new Set();
    await ensureRootFolder('root-cover');
    await upsertWork({
      id: 'RJ500001',
      title: 'T',
      circleName: 'C',
      rootFolder: 'root-cover',
      dir: 'RJ500001',
      sourceId: 'RJ00000001',
    });
    const { ctx } = makeCtx({ workId: 'RJ500001' });
    await coverExecutor(ctx);
    expect(downloadCalls[0]?.sourceId).toBe('RJ00000001');
  });

  test('manual 作品：只导入本地封面，零网络下载零 blob 查询', async () => {
    downloadCalls.length = 0;
    importCalls.length = 0;
    existingCoverTypesCalls = 0;
    importResult = true;
    const { ctx, logs } = makeCtx({ workId: 'UW00000002' });
    const result = await coverExecutor(ctx);
    expect(result).toEqual({});
    expect(importCalls).toEqual([`UW00000002@/tmp/UW00000002`]);
    expect(downloadCalls).toHaveLength(0);
    expect(existingCoverTypesCalls).toBe(0); // manual 分支不查 blob
    expect(
      logs.some((l) => l.message === 'Local cover imported for UW00000002'),
    ).toBe(true);
    importResult = false;
  });

  test('manual 作品：目录无图片 → warning，不抛错', async () => {
    importCalls.length = 0;
    const { ctx, logs } = makeCtx({ workId: 'UW00000002' });
    const result = await coverExecutor(ctx);
    expect(result).toEqual({});
    expect(
      logs.some(
        (l) => l.level === 'warning' && l.message.includes('No local cover'),
      ),
    ).toBe(true);
  });
});
