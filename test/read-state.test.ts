import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/db/main/index.js';
import {
  circles,
  readStates,
  userProgress,
  users,
  works,
} from '../src/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const TEST_USER = `read_state_tester_${RUN}`;
const CIRCLE_NAME = `已读测试社团_${RUN}`;

// 三个作品按用例拆分，避免状态互相污染：
// - WORK_MAIN：首报自动已读 → 手动未读 → 再上报不翻转（用例 1-3）
// - WORK_MANUAL：无进度纯手动标记已读（用例 4）
// - WORK_DEL：删进度级联清未读（用例 5）
const WORK_MAIN = `RJ${RUN}main`;
const WORK_MANUAL = `RJ${RUN}manual`;
const WORK_DEL = `RJ${RUN}del`;
// 不存在于库中的作品 id（404 用例）
const WORK_MISSING = `RJ${RUN}missing`;

/** 带 token 请求作品详情，返回注入的 read 字段 */
async function getWorkRead(
  app: FastifyInstance,
  token: string,
  workId: string,
): Promise<boolean> {
  const res = await app.inject({
    method: 'GET',
    url: `/api/work/${workId}`,
    headers: { authorization: `Bearer ${token}` },
  });
  expect(res.statusCode).toBe(200);
  return (res.json() as { read: boolean }).read;
}

/** 直查 t_read_state 行（存在即已读） */
function getReadStateRow(workId: string) {
  return db
    .select()
    .from(readStates)
    .where(
      and(eq(readStates.userName, TEST_USER), eq(readStates.workId, workId)),
    );
}

describe('已读状态（t_read_state）', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // 造数：用户 + 社团 + 3 个作品（进度/标记外键依赖）
    await db
      .insert(users)
      .values({ name: TEST_USER, password: 'test-password', group: 'user' });
    const circle = await db
      .insert(circles)
      .values({ name: CIRCLE_NAME })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    for (const id of [WORK_MAIN, WORK_MANUAL, WORK_DEL]) {
      await db.insert(works).values({
        id,
        rootFolder: 'test',
        dir: `test/${id}`,
        title: `已读测试作品_${id}`,
        circleId: circleRow.id,
      });
    }

    token = app.jwt.sign({ name: TEST_USER, group: 'user' });
  });

  afterAll(async () => {
    // 清理（readStates 外键级联随 user 删除，显式删一遍更稳）
    await db.delete(readStates).where(eq(readStates.userName, TEST_USER));
    await db.delete(userProgress).where(eq(userProgress.userName, TEST_USER));
    await db.delete(users).where(eq(users.name, TEST_USER));
    for (const wid of [WORK_MAIN, WORK_MANUAL, WORK_DEL]) {
      await db.delete(works).where(eq(works.id, wid));
    }
    await db.delete(circles).where(eq(circles.name, CIRCLE_NAME));
    await app.close();
  });

  describe('自动已读', () => {
    it('首报 PUT /api/progress → t_read_state 有行，详情 read: true', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          work_id: WORK_MAIN,
          media_index: 'track01.mp3',
          position: 30,
          duration: 300,
        },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ success: true });

      // 标记行已写入（自动已读）
      const rows = await getReadStateRow(WORK_MAIN);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.readAt).toBeString();

      // 详情接口注入 read: true
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(true);
    });
  });

  describe('手动未读保留进度（D3）', () => {
    it('DELETE /progress/:workId/read → read: false，进度行仍在', async () => {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_MAIN}/read`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ success: true });

      // 标记行被删除 → 详情 read: false
      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(false);

      // 未读不清理进度：进度行仍可读回
      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_MAIN}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.statusCode).toBe(200);
      const progressRows = get.json();
      expect(progressRows).toHaveLength(1);
      expect(progressRows[0]).toMatchObject({
        userName: TEST_USER,
        workId: WORK_MAIN,
        mediaIndex: 'track01.mp3',
      });
    });
  });

  describe('播放不翻转手动未读（D2）', () => {
    it('已有进度时再报 PUT /api/progress → read 仍为 false', async () => {
      // 此刻 WORK_MAIN 已有进度行（用例 2 确认过），自动已读不应再次触发
      const put = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          work_id: WORK_MAIN,
          media_index: 'track02.mp3',
          position: 60,
        },
      });
      expect(put.statusCode).toBe(200);

      // 手动未读状态不被播放翻回已读
      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(false);
    });
  });

  describe('纯手动标记已读', () => {
    it('无进度作品直接 PUT /progress/:workId/read → read: true', async () => {
      // 前置确认：WORK_MANUAL 无任何进度行
      const before = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_MANUAL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(before.json()).toHaveLength(0);

      const put = await app.inject({
        method: 'PUT',
        url: `/api/progress/${WORK_MANUAL}/read`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(put.statusCode).toBe(200);
      expect(put.json()).toEqual({ success: true });

      // 纯标记：不产生进度，只写已读
      expect(await getReadStateRow(WORK_MANUAL)).toHaveLength(1);
      const after = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_MANUAL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(after.json()).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MANUAL)).toBe(true);
    });
  });

  describe('删除进度级联清未读（D2）', () => {
    it('DELETE /progress/:workId → 进度清空且 read: false', async () => {
      // 前置：首报进度触发自动已读
      const put = await app.inject({
        method: 'PUT',
        url: '/api/progress',
        headers: { authorization: `Bearer ${token}` },
        payload: {
          work_id: WORK_DEL,
          media_index: 'track01.mp3',
          position: 10,
        },
      });
      expect(put.statusCode).toBe(200);
      expect(await getWorkRead(app, token, WORK_DEL)).toBe(true);

      // 删除全部进度
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_DEL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json()).toEqual({ deleted: 1 });

      // 进度清空
      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_DEL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.json()).toHaveLength(0);

      // 已读标记级联清除 → 回到未读态
      expect(await getReadStateRow(WORK_DEL)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_DEL)).toBe(false);
    });
  });

  describe('认证', () => {
    it('标记已读/未读不带 token → 401', async () => {
      const put = await app.inject({
        method: 'PUT',
        url: `/api/progress/${WORK_MAIN}/read`,
      });
      expect(put.statusCode).toBe(401);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_MAIN}/read`,
      });
      expect(del.statusCode).toBe(401);
    });
  });

  describe('不存在作品', () => {
    it('PUT /progress/:workId/read 作品不在库 → 404', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/progress/${WORK_MISSING}/read`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(404);
      expect(res.json().error).toContain(WORK_MISSING);
    });
  });
});
