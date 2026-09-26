import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { and, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/infra/db/main/index.js';
import {
  circles,
  readStates,
  tracks,
  userProgress,
  users,
  works,
} from '../src/infra/db/main/schema.js';
import { ensureRootFolder, removeRootFolder } from './helpers/rootFolder';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const TEST_USER = `read_state_tester_${RUN}`;
const CIRCLE_NAME = `已读测试社团_${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG93${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

// 作品按用例拆分，避免状态互相污染：
// - WORK_MAIN：2 轨已知时长，走完整生命周期（未听完 → 部分听完 → 全听完自动置
//   → 手动未读 → 已听完继续上报不翻转）
// - WORK_DEL：1 轨，删进度级联 + 重新听完再次置已读
// - WORK_MANUAL：无音轨（无法自动判定），纯手动标记
const WORK_MAIN = `RJ${RUN}main`;
const WORK_DEL = `RJ${RUN}del`;
const WORK_MANUAL = `RJ${RUN}manual`;
// - WORK_NULL：2 轨，验证缺省 duration 上报（保留库中旧时长）的听完判定
const WORK_NULL = `RJ${RUN}null`;
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

describe('已读状态（t_read_state，听完自动置）', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // 造数：用户 + 社团 + 3 个作品 + 音轨（作品听完判定依赖 t_track.duration_sec）
    await db
      .insert(users)
      .values({ name: TEST_USER, password: 'test-password', group: 'user' });
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: CIRCLE_NAME })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    await ensureRootFolder('test');
    for (const id of [WORK_MAIN, WORK_DEL, WORK_MANUAL, WORK_NULL]) {
      await db.insert(works).values({
        id,
        rootFolder: 'test',
        dir: `test/${id}`,
        title: `已读测试作品_${id}`,
        circleId: circleRow.id,
      });
    }
    await db.insert(tracks).values([
      {
        workId: WORK_MAIN,
        mediaIndex: 'track01.mp3',
        title: 'main-t1',
        sizeBytes: 1,
        durationSec: 300,
      },
      {
        workId: WORK_MAIN,
        mediaIndex: 'track02.mp3',
        title: 'main-t2',
        sizeBytes: 1,
        durationSec: 300,
      },
      {
        workId: WORK_DEL,
        mediaIndex: 'track01.mp3',
        title: 'del-t1',
        sizeBytes: 1,
        durationSec: 300,
      },
      {
        workId: WORK_NULL,
        mediaIndex: 'track01.mp3',
        title: 'null-t1',
        sizeBytes: 1,
        durationSec: 300,
      },
      {
        workId: WORK_NULL,
        mediaIndex: 'track02.mp3',
        title: 'null-t2',
        sizeBytes: 1,
        durationSec: 300,
      },
    ]);

    token = await signTokenFor(app, TEST_USER);
  });

  afterAll(async () => {
    // 清理（tracks 随 works 级联删除；readStates/userProgress 外键级联随 user）
    await db.delete(readStates).where(eq(readStates.userName, TEST_USER));
    await db.delete(userProgress).where(eq(userProgress.userName, TEST_USER));
    await db.delete(users).where(eq(users.name, TEST_USER));
    for (const wid of [WORK_MAIN, WORK_DEL, WORK_MANUAL, WORK_NULL]) {
      await db.delete(works).where(eq(works.id, wid));
    }
    await removeRootFolder('test');
    await db.delete(circles).where(eq(circles.name, CIRCLE_NAME));
    await app.close();
  });

  /** 登录态上报进度（断言 200） */
  async function report(
    workId: string,
    mediaIndex: string,
    position: number,
    duration?: number,
  ) {
    const res = await app.inject({
      method: 'PUT',
      url: '/api/progress',
      headers: { authorization: `Bearer ${token}` },
      payload: { work_id: workId, media_index: mediaIndex, position, duration },
    });
    expect(res.statusCode).toBe(200);
  }

  describe('听完自动置已读（修订 D2）', () => {
    it('未听完首报 → 不置已读', async () => {
      await report(WORK_MAIN, 'track01.mp3', 30, 300);
      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(false);
    });

    it('部分轨听完但未全部听完 → 仍未置', async () => {
      await report(WORK_MAIN, 'track02.mp3', 290, 300);
      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
    });

    it('全部已知时长音轨听完 → 自动置已读', async () => {
      await report(WORK_MAIN, 'track01.mp3', 290, 300);
      const rows = await getReadStateRow(WORK_MAIN);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.readAt).toBeString();
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(true);
    });
  });

  describe('手动未读（D3）', () => {
    it('DELETE read → read:false，进度行保留', async () => {
      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_MAIN}/read`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json<{ success: boolean }>()).toEqual({ success: true });

      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(false);

      // 未读不清理进度：2 轨进度行仍可读回
      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_MAIN}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.statusCode).toBe(200);
      expect(get.json()).toHaveLength(2);
    });

    it('已听完作品手动未读后继续上报 → 不翻转（手动意图优先）', async () => {
      await report(WORK_MAIN, 'track01.mp3', 295, 300);
      expect(await getReadStateRow(WORK_MAIN)).toHaveLength(0);
      expect(await getWorkRead(app, token, WORK_MAIN)).toBe(false);
    });
  });

  describe('删除进度级联（D2）', () => {
    it('听完 → 删进度清标记 → 重新听完再次自动置已读', async () => {
      await report(WORK_DEL, 'track01.mp3', 300, 300);
      expect(await getWorkRead(app, token, WORK_DEL)).toBe(true);

      const del = await app.inject({
        method: 'DELETE',
        url: `/api/progress/${WORK_DEL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(del.statusCode).toBe(200);
      expect(del.json<{ deleted: number }>()).toEqual({ deleted: 1 });
      expect(await getReadStateRow(WORK_DEL)).toHaveLength(0);
      const get = await app.inject({
        method: 'GET',
        url: `/api/progress/${WORK_DEL}`,
        headers: { authorization: `Bearer ${token}` },
      });
      expect(get.json()).toHaveLength(0);

      // 删进度构成新的一次「非听完 → 听完」跳变
      await report(WORK_DEL, 'track01.mp3', 300, 300);
      expect(await getReadStateRow(WORK_DEL)).toHaveLength(1);
    });
  });

  describe('缺省 duration 上报（保留库中旧时长）', () => {
    it('首报缺省 duration（无旧时长）→ 不置已读', async () => {
      await report(WORK_NULL, 'track01.mp3', 290);
      expect(await getReadStateRow(WORK_NULL)).toHaveLength(0);
    });

    it('缺省 duration 跨过旧时长 0.95 → 逐轨听完自动置已读', async () => {
      // 先带 duration 补齐两轨的库中时长
      await report(WORK_NULL, 'track01.mp3', 10, 300);
      await report(WORK_NULL, 'track02.mp3', 10, 300);
      expect(await getReadStateRow(WORK_NULL)).toHaveLength(0);

      // t1 缺省 duration 上报 290：保留旧时长 300，290/300 ≥ 0.95 → 该轨听完；
      // 但 t2 未听完，无跳变
      await report(WORK_NULL, 'track01.mp3', 290);
      expect(await getReadStateRow(WORK_NULL)).toHaveLength(0);

      // t2 缺省 duration 上报 290：两轨全部听完 → 跳变置已读
      await report(WORK_NULL, 'track02.mp3', 290);
      expect(await getReadStateRow(WORK_NULL)).toHaveLength(1);
      expect(await getWorkRead(app, token, WORK_NULL)).toBe(true);
    });
  });

  describe('纯手动标记（无音轨作品无法自动判定）', () => {
    it('无进度作品直接 PUT read → read:true，不产生进度', async () => {
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
      expect(put.json<{ success: boolean }>()).toEqual({ success: true });

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
