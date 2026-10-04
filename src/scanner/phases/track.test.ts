import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { copyFileSync, mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  ensureRootFolder,
  removeRootFolder,
} from '@test/helpers/rootFolder.js';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../../infra/db/main/index.js';
import { works } from '../../infra/db/main/schema.js';
import { getTrackRows } from '../../services/track.service.js';
import { upsertWork } from '../../services/work.service.js';
import { trackExecutor } from './track.js';
import type { PhaseContext, WorkLocation } from './types.js';

setupTestEnvironment();

const WORK = 'RJ600001';
const LIB_PATH = join(tmpdir(), `kiku-track-phase-${Date.now().toString(36)}`);

// 真实文件系统：trackExecutor 内部 openWorkSource（不可注入 source）
beforeAll(async () => {
  await ensureRootFolder('lib-track', LIB_PATH);
  mkdirSync(join(LIB_PATH, WORK), { recursive: true });
  const wav = join(import.meta.dir, '../../../test/fixtures/audio/sine.wav');
  copyFileSync(wav, join(LIB_PATH, WORK, 'a.wav'));
  copyFileSync(wav, join(LIB_PATH, WORK, 'b.wav'));
  await upsertWork({
    id: WORK,
    title: 'T',
    circleName: 'C',
    rootFolder: 'lib-track',
    dir: WORK,
  });
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK));
  await removeRootFolder('lib-track');
  rmSync(LIB_PATH, { recursive: true, force: true });
});

function makeCtx(partial: Partial<PhaseContext> & { workId: string }): {
  ctx: PhaseContext;
  logs: Array<{ level: string; message: string }>;
} {
  const logs: Array<{ level: string; message: string }> = [];
  const location: WorkLocation = partial.location ?? {
    rootFolder: 'lib-track',
    relativePath: WORK,
  };
  const { location: _override, ...rest } = partial;
  void _override;
  return {
    logs,
    ctx: {
      variant: undefined,
      signal: new AbortController().signal,
      log: (level, message) => logs.push({ level, message }),
      force: false,
      ...rest,
      location,
    },
  };
}

describe('trackExecutor', () => {
  test('音轨入库：真实目录两个 wav → track rows 2 行，不抛错', async () => {
    const { ctx, logs } = makeCtx({ workId: WORK });
    const result = await trackExecutor(ctx);
    expect(result).toEqual({});
    const rows = await getTrackRows(WORK);
    expect(rows).toHaveLength(2);
    expect(
      logs.some(
        (l) => l.level === 'info' && l.message.includes('Tracks synced'),
      ),
    ).toBe(true);
  });

  test('root folder 不存在 → warning 跳过，不抛错', async () => {
    const { ctx, logs } = makeCtx({
      workId: WORK,
      location: { rootFolder: 'nonexistent-root', relativePath: WORK },
    });
    const result = await trackExecutor(ctx);
    expect(result).toEqual({});
    expect(
      logs.some(
        (l) =>
          l.level === 'warning' && l.message.includes('root folder not found'),
      ),
    ).toBe(true);
  });

  test('作品路径不可读 → warning 失败日志，不抛错（音轨失败不判任务失败）', async () => {
    const { ctx, logs } = makeCtx({
      workId: WORK,
      location: { rootFolder: 'lib-track', relativePath: 'no/such/dir' },
    });
    const result = await trackExecutor(ctx);
    expect(result).toEqual({});
    expect(
      logs.some(
        (l) => l.level === 'warning' && l.message.includes('Track sync failed'),
      ),
    ).toBe(true);
  });
});
