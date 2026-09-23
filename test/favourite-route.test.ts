import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/infra/db/main/index.js';
import { circles, series, users, works } from '../src/infra/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const TEST_USER = `fav_route_${RUN}`;
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;
const SERIES_ID = `SRI${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG90${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

describe('Favourite Routes', () => {
  let app: FastifyInstance;
  let token: string;
  let circleId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({ name: TEST_USER, password: 'test-password', group: 'user' });
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `路由测试社团_${RUN}` })
      .returning();
    circleId = circle[0]!.id;
    await db
      .insert(series)
      .values({ id: SERIES_ID, name: `路由测试系列_${RUN}` });
    await db.insert(works).values({
      id: WORK_ID,
      rootFolder: 'test',
      dir: `test/${WORK_ID}`,
      title: '路由测试作品',
      circleId,
      seriesId: SERIES_ID,
    });

    token = await signTokenFor(app, TEST_USER);
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.id, WORK_ID));
    await db.delete(series).where(eq(series.id, SERIES_ID));
    await db.delete(circles).where(eq(circles.id, circleId));
    await db.delete(users).where(eq(users.name, TEST_USER));
    await app.close();
  });

  describe('authentication', () => {
    it('GET /api/favourites 应要求登录', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/favourites' });
      expect(res.statusCode).toBe(401);
    });

    it('POST /api/favourites 应要求登录', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        payload: { targetType: 'work', targetId: WORK_ID },
      });
      expect(res.statusCode).toBe(401);
    });

    it('DELETE /api/favourites/:type/:id 应要求登录', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: `/api/favourites/work/${WORK_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET /api/favourites/status 应要求登录', async () => {
      const res = await app.inject({
        method: 'GET',
        url: `/api/favourites/status?targetType=work&ids=${WORK_ID}`,
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('CRUD 与状态', () => {
    it('收藏 → 列表 → 状态 → 取消 全链路', async () => {
      const put = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'work', targetId: WORK_ID },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json<{ favourited: boolean }>()).toEqual({ favourited: true });

      const list = await app.inject({
        method: 'GET',
        url: '/api/favourites?targetType=work',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as {
        favourites: Array<{
          targetType: string;
          targetId: string;
          target: unknown;
        }>;
      };
      expect(body.favourites.length).toBe(1);
      expect(body.favourites[0]!.targetId).toBe(WORK_ID);
      expect(body.favourites[0]!.target).toMatchObject({
        id: WORK_ID,
        title: '路由测试作品',
      });

      const status = await app.inject({
        method: 'GET',
        url: `/api/favourites/status?targetType=work&ids=${WORK_ID},RJ00000000`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json<Record<string, boolean>>()).toEqual({
        [WORK_ID]: true,
        RJ00000000: false,
      });

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/favourites/work/${WORK_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json<{ message: string }>()).toEqual({
        message: 'Favourite removed',
      });

      const empty = await app.inject({
        method: 'GET',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
      });
      expect((empty.json() as { favourites: unknown[] }).favourites).toEqual(
        [],
      );
    });

    it('收藏系列 → 实体摘要带 workCount', async () => {
      await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'series', targetId: SERIES_ID },
      });
      const list = await app.inject({
        method: 'GET',
        url: '/api/favourites?targetType=series',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = list.json() as {
        favourites: Array<{ target: { workCount: number } }>;
      };
      expect(body.favourites[0]!.target.workCount).toBe(1);
    });

    it('收藏社团（maker_id）→ 实体摘要 id 为字符串且可读回', async () => {
      const post = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'circle', targetId: CIRCLE_ID },
      });
      expect(post.statusCode).toBe(200);
      expect(post.json<{ favourited: boolean }>()).toEqual({
        favourited: true,
      });

      const list = await app.inject({
        method: 'GET',
        url: '/api/favourites?targetType=circle',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(list.statusCode).toBe(200);
      const body = list.json() as {
        favourites: Array<{
          targetId: string;
          target: { id: string; name: string; workCount: number };
        }>;
      };
      expect(body.favourites.length).toBe(1);
      expect(body.favourites[0]).toMatchObject({
        targetId: CIRCLE_ID,
        target: {
          id: CIRCLE_ID,
          name: `路由测试社团_${RUN}`,
          workCount: 1,
        },
      });

      // 数值比较下 maker_id 转不成整数，这条状态查询会返回 false
      const status = await app.inject({
        method: 'GET',
        url: `/api/favourites/status?targetType=circle&ids=${CIRCLE_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(status.statusCode).toBe(200);
      expect(status.json<Record<string, boolean>>()).toEqual({
        [CIRCLE_ID]: true,
      });
    });

    it('收藏不存在的目标 → 404；非法 targetType → 400', async () => {
      const missing = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'work', targetId: 'RJ99999999' },
      });
      expect(missing.statusCode).toBe(404);

      const bad = await app.inject({
        method: 'POST',
        url: '/api/favourites',
        headers: { authorization: `Bearer ${token}` },
        payload: { targetType: 'tag', targetId: '1' },
      });
      expect(bad.statusCode).toBe(400);
    });
  });
});
