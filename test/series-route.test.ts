import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { inArray } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { db } from '../src/infra/db/main/index.js';
import { series, works } from '../src/infra/db/main/schema.js';
import { upsertWork } from '../src/services/work.service.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// base 取 7 位数字：RJ{base}{1} 恰为 8 位，符合库内合法 RJ 号格式
const base = 3000000 + Math.floor(Math.random() * 2000000);
const S1 = `SRI${base}1`;
const S1_NAME = `路由测试系列甲${base}`;
const W1 = `RJ${base}1`; // series S1

const { buildApp } = await import('../src/app');

describe('GET /api/series/ 与作品详情 series 字段', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 私有模式全局守卫需要 JWT（verify 只验签，无需真实用户）
    token = app.jwt.sign({ name: `series_tester_${base}`, group: 'user' });

    const res = await upsertWork({
      id: W1,
      rootFolder: 'testroot',
      dir: `q/${W1}`,
      title: `系列路由作品${base}`,
      circleName: `系列路由测试社团${base}`,
      series: { id: S1, name: S1_NAME },
    });
    if (!res.success) throw new Error(res.error);
  });

  afterAll(async () => {
    await db
      .delete(works)
      .where(inArray(works.id, [W1]))
      .catch(() => {});
    await db
      .delete(series)
      .where(inArray(series.id, [S1]))
      .catch(() => {});
    await app.close();
  });

  it('GET /api/series/ 返回含新系列的全量列表', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/series/',
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const list = res.json<{ id: string; name: string }[]>();
    const found = list.filter((s) => s.id === S1);
    expect(found).toHaveLength(1);
    expect(found[0]?.name).toBe(S1_NAME);
  });

  it('GET /api/work/:id 的 series 字段携带关联系列', async () => {
    const res = await app.inject({
      method: 'GET',
      url: `/api/work/${W1}`,
      headers: { authorization: `Bearer ${token}` },
    });

    expect(res.statusCode).toBe(200);
    const work = res.json<{ series: { id: string; name: string } | null }>();
    expect(work.series).toEqual({ id: S1, name: S1_NAME });
  });
});
