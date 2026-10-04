import { afterAll, describe, expect, mock, test } from 'bun:test';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../../infra/db/main/index.js';
import { circles, works } from '../../infra/db/main/schema.js';
import { upsertWork } from '../../services/work.service.js';
import type { PhaseContext, WorkLocation } from '../taskSystem.js';
import { metadataExecutor } from './metadata.js';

setupTestEnvironment();

// 可控 mock：fetchBehavior 切换成功/失败；manual 分支零网络断言依赖标题标记
let fetchBehavior: 'ok' | 'fail' = 'ok';
mock.module('../../infra/scraper/dlsite.js', () => ({
  fetchDLsiteWorkInfo: async (workCode: string) => {
    if (fetchBehavior === 'fail') throw new Error('DLsite 429');
    return {
      title: `DLsite 元数据 ${workCode}`,
      circle: '测试社团',
      circleId: 'circle-1',
      ageRating: 'all' as const,
      releaseDate: '2024-01-01',
      tags: [],
      vas: [],
      rateCountDetail: {},
      rank: [],
    };
  },
}));

const { ensureRootFolder: _ensure } = await import(
  '@test/helpers/rootFolder.js'
);

function makeCtx(partial: Partial<PhaseContext> & { workId: string }): {
  ctx: PhaseContext;
  logs: Array<{ level: string; message: string }>;
} {
  const logs: Array<{ level: string; message: string }> = [];
  const location: WorkLocation = {
    rootFolder: 'root1',
    relativePath: partial.workId,
    dirName: partial.workId,
    absDir: `/tmp/${partial.workId}`,
  };
  return {
    logs,
    ctx: {
      variant: undefined,
      signal: new AbortController().signal,
      log: (level, message) => logs.push({ level, message }),
      force: false,
      location,
      ...partial,
    },
  };
}

afterAll(async () => {
  await removeRootFolder('root1').catch(() => {});
});

describe('metadataExecutor（workSync 三分支迁移）', () => {
  test('dlsite 分支：抓取 + upsert + Added 日志，返回 title/created', async () => {
    await ensureRootFolder('root1');
    fetchBehavior = 'ok';
    const { ctx, logs } = makeCtx({ workId: 'RJ400001' });
    const result = await metadataExecutor(ctx);
    expect(result.created).toBe(true);
    expect(result.title).toBe('DLsite 元数据 RJ400001');
    const row = await db.select().from(works).where(eq(works.id, 'RJ400001'));
    expect(row[0]?.title).toBe('DLsite 元数据 RJ400001');
    const circle = await db
      .select()
      .from(circles)
      .where(eq(circles.id, row[0]?.circleId ?? ''));
    expect(circle[0]?.name).toBe('测试社团');
    expect(
      logs.some(
        (l) => l.message === 'Added: RJ400001 - DLsite 元数据 RJ400001',
      ),
    ).toBe(true);
  });

  test('dlsite 分支：已入库作品再次同步 → created=false + Updated 日志', async () => {
    fetchBehavior = 'ok';
    const { ctx, logs } = makeCtx({ workId: 'RJ400001' });
    const result = await metadataExecutor(ctx);
    expect(result.created).toBe(false);
    expect(
      logs.some(
        (l) => l.message === 'Updated: RJ400001 - DLsite 元数据 RJ400001',
      ),
    ).toBe(true);
  });

  test('dlsite 分支：抓取失败抛错（fail-pipeline）', async () => {
    fetchBehavior = 'fail';
    const { ctx } = makeCtx({ workId: 'RJ400002' });
    expect(metadataExecutor(ctx)).rejects.toThrow('DLsite 429');
  });

  test('manual 分支：标题本地推导 + unknown 社团，零网络', async () => {
    fetchBehavior = 'ok';
    const { ctx, logs } = makeCtx({
      workId: 'UW00000001',
      location: {
        rootFolder: 'root1',
        relativePath: 'UW00000001 手动作品',
        dirName: 'UW00000001 手动作品',
        absDir: '/tmp/UW00000001 手动作品',
      },
    });
    const result = await metadataExecutor(ctx);
    expect(result.created).toBe(true);
    // 标题来自目录名推导，不可能来自 DLsite mock
    expect(result.title).toBe('手动作品');
    expect(result.title).not.toContain('DLsite');
    const row = await db.select().from(works).where(eq(works.id, 'UW00000001'));
    expect(row[0]?.circleId).toBe('unknown');
    expect(
      logs.some((l) => l.level === 'info' && l.message.includes('Manual work')),
    ).toBe(true);
  });

  test('moved 分支：仅改路径，不重抓元数据，created=false', async () => {
    fetchBehavior = 'fail'; // moved 不应触网；若触网即失败暴露
    const seeded = await upsertWork({
      id: 'RJ400003',
      title: '已有作品',
      circleName: '已有社团',
      rootFolder: 'root1',
      dir: 'old/path',
    });
    expect(seeded.success).toBe(true);
    const { ctx, logs } = makeCtx({
      workId: 'RJ400003',
      variant: 'moved',
      location: { rootFolder: 'root1', relativePath: 'new/path' },
    });
    const result = await metadataExecutor(ctx);
    expect(result.created).toBe(false);
    const row = await db.select().from(works).where(eq(works.id, 'RJ400003'));
    expect(row[0]?.dir).toBe('new/path');
    expect(row[0]?.title).toBe('已有作品'); // 元数据未动
    expect(logs.some((l) => l.message === 'Moved: RJ400003 -> new/path')).toBe(
      true,
    );
  });

  test('moved 分支：作品不在库 → 抛错', async () => {
    const { ctx } = makeCtx({
      workId: 'RJ409999',
      variant: 'moved',
      location: { rootFolder: 'root1', relativePath: 'x' },
    });
    expect(metadataExecutor(ctx)).rejects.toThrow(
      'Moved work not found in database',
    );
  });
});
