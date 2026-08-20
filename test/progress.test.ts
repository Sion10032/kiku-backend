import { describe, it, expect, beforeAll, afterAll } from 'bun:test';
import { setupTestEnvironment } from './helpers/setup';
import { buildApp } from '../src/app';
import { db } from '../src/db/index.js';
import { users, circles, works, userProgress, reviews } from '../src/db/schema.js';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const TEST_USER = `progress_tester_${RUN}`;
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;

describe('Progress Routes', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // 造数：用户 + 圈子 + 作品（progress 外键依赖）
    await db.insert(users).values({ name: TEST_USER, password: 'test-password', group: 'user' });
    const circle = await db.insert(circles).values({ name: `测试圈子_${RUN}` }).returning();
    await db.insert(works).values({
      id: WORK_ID,
      rootFolder: 'test',
      dir: `test/${WORK_ID}`,
      title: '进度测试作品',
      circleId: circle[0].id,
    });

    token = app.jwt.sign({ name: TEST_USER, group: 'user' });
  });

  afterAll(async () => {
    // 清理（progress/review 级联删除，仅清用户与作品、圈子）
    await db.delete(users).where(eq(users.name, TEST_USER));
    await db.delete(works).where(eq(works.id, WORK_ID));
    await db.delete(userProgress).where(eq(userProgress.workId, WORK_ID));
    await db.delete(reviews).where(eq(reviews.workId, WORK_ID));
    const circle = await db.query.circles.findFirst({ where: eq(circles.name, `测试圈子_${RUN}`) });
    if (circle) await db.delete(circles).where(eq(circles.id, circle.id));
    await app.close();
  });

  describe('authentication', () => {
    it('PUT /api/progress 应要求登录', async () => {
      const response = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        payload: { work_id: WORK_ID, media_index: 'a.mp3', position: 1 },
      });
      expect(response.statusCode).toBe(401);
    });

    it('GET /api/progress/:workId 应要求登录', async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });

    it('DELETE /api/progress/:workId 应要求登录', async () => {
      const response = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_ID}`,
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('upsert 与读取', () => {
    it('上报后能读回（同 track 覆盖更新）', async () => {
      const put1 = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          work_id: WORK_ID,
          media_index: 'track01.mp3',
          track_title: '第一轨',
          position: 30,
          duration: 300,
        },
      });
      expect(put1.statusCode).toBe(200);
      expect(put1.json()).toEqual({ success: true });

      // 同 track 再次上报：覆盖 position
      const put2 = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          work_id: WORK_ID,
          media_index: 'track01.mp3',
          position: 60,
        },
      });
      expect(put2.statusCode).toBe(200);

      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.statusCode).toBe(200);
      const rows = get.json();
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        userName: TEST_USER,
        workId: WORK_ID,
        mediaIndex: 'track01.mp3',
        position: 60,
      });
      // position 未带 duration 上报时保留原值
      expect(rows[0].duration).toBe(300);
      // track_title 未上报时保留原值
      expect(rows[0].trackTitle).toBe('第一轨');
    });
  });

  describe('works 列表注入 userProgress', () => {
    it('登录后 works/详情返回进度聚合（listenedCount ≥ 0.95 才计入）', async () => {
      // track01 已存在（60/300 = 20%，不算听完）
      // track02 自然结束（position = duration）
      // track03 听了 96%
      // track04 无 duration
      await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: WORK_ID, media_index: 'track02.mp3', track_title: '第二轨', position: 200, duration: 200 },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: WORK_ID, media_index: 'track03.mp3', position: 96, duration: 100 },
      });
      await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: WORK_ID, media_index: 'track04.mp3', position: 50 },
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/works',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const work = res.json().works.find((w: { id: string; }) => w.id === WORK_ID);
      expect(work).toBeDefined();
      expect(work.userProgress).not.toBeNull();
      expect(work.userProgress.listenedCount).toBe(2); // track02 + track03
      // 上次播放 = updatedAt 最新的 track04
      expect(work.userProgress.mediaIndex).toBe('track04.mp3');

      // 匿名请求：userProgress 恒 null
      const anon = await app.inject({ method: 'GET', url: '/api/works' });
      const anonWork = anon.json().works.find((w: { id: string; }) => w.id === WORK_ID);
      expect(anonWork.userProgress).toBeNull();
    });
  });

  describe('DELETE /api/progress/:workId', () => {
    it('删除全部进度后作品回到未读态', async () => {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json().deleted).toBe(4);

      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_ID}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.json()).toHaveLength(0);

      // works 列表注入回 null（未读）
      const res = await app.inject({
        method: 'GET',
        url: '/api/works',
        headers: { authorization: `Bearer ${token}` },
      });
      const work = res.json().works.find((w: { id: string; }) => w.id === WORK_ID);
      expect(work.userProgress).toBeNull();
    });
  });
});
