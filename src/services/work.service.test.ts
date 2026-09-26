import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { ensureRootFolder, removeRootFolder } from '@test/helpers/rootFolder';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { circles, works } from '../infra/db/main/schema.js';
import { liveWorkExists, workExists } from './work.service.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;
const DELETED_ID = `RJDEL${RUN}`;
const MISSING_ID = `RJmissing${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG96${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

describe('workExists / liveWorkExists 的软删语义差异', () => {
  let circleId: string;

  beforeAll(async () => {
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `workExists 测试社团_${RUN}` })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    circleId = circleRow.id;

    await ensureRootFolder('test');
    await db.insert(works).values([
      {
        id: WORK_ID,
        rootFolder: 'test',
        dir: `test/${WORK_ID}`,
        title: 'workExists 测试作品',
        circleId,
      },
      {
        id: DELETED_ID,
        rootFolder: 'test',
        dir: `test/${DELETED_ID}`,
        title: 'workExists 测试作品（已软删）',
        circleId,
        deletedAt: new Date().toISOString(),
      },
    ]);
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.id, WORK_ID));
    await db.delete(works).where(eq(works.id, DELETED_ID));
    await removeRootFolder('test');
    await db.delete(circles).where(eq(circles.id, circleId));
  });

  it('liveWorkExists：在库作品 → true', async () => {
    expect(await liveWorkExists(WORK_ID)).toBe(true);
  });

  it('liveWorkExists：库中不存在的 id → false', async () => {
    expect(await liveWorkExists(MISSING_ID)).toBe(false);
  });

  it('liveWorkExists：已软删作品视为不存在 → false', async () => {
    expect(await liveWorkExists(DELETED_ID)).toBe(false);
  });

  // 对照组：workExists 是「行存在」，含软删行（workAdmin 删除路由判 404 用）
  it('workExists：软删行仍算存在 → true', async () => {
    expect(await workExists(DELETED_ID)).toBe(true);
    expect(await workExists(MISSING_ID)).toBe(false);
  });
});
