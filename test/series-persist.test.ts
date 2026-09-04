import { afterAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';
import { db } from '../src/infra/db/main/index.js';
import { series, works } from '../src/infra/db/main/schema.js';
import { updateWorkMetadata } from '../src/scanner/updater.js';
import {
  getSeries,
  getWorkById,
  upsertWork,
} from '../src/services/work.service.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// base 取 7 位数字：RJ{base}{1,2,3} 恰为 8 位，符合库内合法 RJ 号格式
const base = 1000000 + Math.floor(Math.random() * 2000000);
const S1 = `SRI${base}1`;
const S3 = `SRI${base}3`;
const S1_NAME = `系列甲${base}`;
const S3_NAME = `系列丙${base}`;
const W1 = `RJ${base}1`; // series S1
const W2 = `RJ${base}2`; // 无系列

/** 查作品当前关联的系列（单值：{ id, name } 或 null） */
async function workSeries(
  workId: string,
): Promise<{ id: string; name: string } | null> {
  const row = await db.query.works.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, workId) },
    with: { series: true },
  });
  return row?.series ? { id: row.series.id, name: row.series.name } : null;
}

/** 直接读 t_work.series_id 列 */
async function workSeriesIdColumn(workId: string): Promise<string | null> {
  const row = await db.query.works.findFirst({
    where: { RAW: (t, op) => op.eq(t.id, workId) },
    columns: { seriesId: true },
  });
  return row?.seriesId ?? null;
}

afterAll(async () => {
  await db
    .delete(works)
    .where(inArray(works.id, [W1, W2]))
    .catch(() => {});
  await db
    .delete(series)
    .where(inArray(series.id, [S1, S3]))
    .catch(() => {});
});

describe('series persistence (upsertWork / updateWorkMetadata)', () => {
  it('upsert 带系列的作品 → t_series 行创建且 t_work.series_id 正确', async () => {
    const res = await upsertWork({
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `系列作品${base}`,
      circleName: `系列测试社团${base}`,
      series: { id: S1, name: S1_NAME },
    });
    if (!res.success) throw new Error(res.error);

    expect(await workSeries(W1)).toEqual({ id: S1, name: S1_NAME });
    expect(await workSeriesIdColumn(W1)).toBe(S1);

    const seriesRow = await db.query.series.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, S1) },
    });
    expect(seriesRow?.name).toBe(S1_NAME);

    // FormattedWork 携带单值 series
    const work = await getWorkById(W1);
    expect(work.series).toEqual({ id: S1, name: S1_NAME });
  });

  it('同系列重复 upsert → 幂等，series_id 不变且不改名', async () => {
    // 传入同名系列
    let res = await upsertWork({
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `系列作品${base}`,
      circleName: `系列测试社团${base}`,
      series: { id: S1, name: S1_NAME },
    });
    if (!res.success) throw new Error(res.error);
    expect(await workSeriesIdColumn(W1)).toBe(S1);

    // 传入同 id 不同名字的系列：沿用库内记录，不改名
    res = await upsertWork({
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `系列作品${base}`,
      circleName: `系列测试社团${base}`,
      series: { id: S1, name: `改名系列${base}` },
    });
    if (!res.success) throw new Error(res.error);

    expect(await workSeriesIdColumn(W1)).toBe(S1);
    const seriesRow = await db.query.series.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, S1) },
    });
    expect(seriesRow?.name).toBe(S1_NAME);
  });

  it('upsert 不含系列的作品 → 不触碰任何系列数据', async () => {
    const res = await upsertWork({
      id: W2,
      rootFolder: 'testroot',
      dir: `q/${W2}`,
      title: `无系列作品${base}`,
      circleName: `系列测试社团${base}`,
    });
    if (!res.success) throw new Error(res.error);

    expect(await workSeries(W2)).toBeNull();
    // W1 的关联不受影响
    expect(await workSeries(W1)).toEqual({ id: S1, name: S1_NAME });
  });

  it('updateWorkMetadata 传非空 series → 设置 series_id（可换绑）', async () => {
    const res = await updateWorkMetadata(W1, {
      series: { id: S3, name: S3_NAME },
    });
    expect(res.success).toBe(true);
    expect(await workSeries(W1)).toEqual({ id: S3, name: S3_NAME });
  });

  it('updateWorkMetadata 不传/传 null series → 既有关联保持不变', async () => {
    // 不传 series
    let res = await updateWorkMetadata(W1, { title: `改名${base}` });
    expect(res.success).toBe(true);
    expect(await workSeries(W1)).toEqual({ id: S3, name: S3_NAME });

    // 传 null 同样不清空（存量不回填、不解除）
    res = await updateWorkMetadata(W1, { series: null });
    expect(res.success).toBe(true);
    expect(await workSeries(W1)).toEqual({ id: S3, name: S3_NAME });
  });

  it('getSeries 返回全部系列', async () => {
    const all = await getSeries();
    const ids = all.map((s) => s.id);
    expect(ids).toContain(S1);
    expect(ids).toContain(S3);
  });
});
