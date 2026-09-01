import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/db/main/index.js';
import {
  circles,
  tracks,
  userProgress,
  users,
  works,
} from '../src/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const TEST_USER = `history_tester_${RUN}`;
const CIRCLE_ID_RAW = Math.floor(1_000_000 + Math.random() * 9_000_000);
const WORK_A = `RJ${String(CIRCLE_ID_RAW).padStart(8, '0')}`;
const WORK_B = `RJ${String(CIRCLE_ID_RAW + 1).padStart(8, '0')}`;
const WORK_C = `RJ${String(CIRCLE_ID_RAW + 2).padStart(8, '0')}`;
// 额外作品用于分页和软删测试
const WORK_D = `RJ${String(CIRCLE_ID_RAW + 3).padStart(8, '0')}`;

// 用显式的时间戳控制排序：T1 < T2 < T3 < T4
const T1 = '2024-01-01T00:00:00.000Z';
const T2 = '2024-01-02T00:00:00.000Z';
const T3 = '2024-01-03T00:00:00.000Z';
const T4 = '2024-01-04T00:00:00.000Z';
// 同作品多轨去重测试用的时间戳（T1-T4 已用于排序测试）
const T_NEW = '2024-01-11T00:00:00.000Z';

/** 创建测试作品（需先有 circle 外键） */
async function insertWork(id: string, title: string, circleId: number) {
  await db
    .insert(works)
    .values({
      id,
      rootFolder: 'test',
      dir: `test/${id}`,
      title,
      circleId,
    })
    .onConflictDoNothing();
}

/** 插入进度行（直接操作 DB，绕过 API 以控制 updatedAt） */
async function insertProgress(
  workId: string,
  mediaIndex: string,
  updatedAt: string,
) {
  await db.insert(userProgress).values({
    userName: TEST_USER,
    workId,
    mediaIndex,
    trackTitle: null,
    position: 100,
    duration: 300,
    updatedAt,
  });
}

describe('GET /api/history', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // 造数：用户 + 社团
    await db.insert(users).values({
      name: TEST_USER,
      password: 'test-password',
      group: 'user',
    });
    const circle = await db
      .insert(circles)
      .values({ name: `历史测试社团_${RUN}` })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    const circleId = circleRow.id;

    // 造 4 个作品（A/B/C 用于核心场景，D 用于分页/软删）
    await insertWork(WORK_A, '作品A', circleId);
    await insertWork(WORK_B, '作品B', circleId);
    await insertWork(WORK_C, '作品C', circleId);
    await insertWork(WORK_D, '作品D', circleId);

    token = app.jwt.sign({ name: TEST_USER, group: 'user' });
  });

  afterAll(async () => {
    await db.delete(userProgress).where(eq(userProgress.userName, TEST_USER));
    await db.delete(users).where(eq(users.name, TEST_USER));
    for (const wid of [WORK_A, WORK_B, WORK_C, WORK_D]) {
      await db.delete(works).where(eq(works.id, wid));
    }
    await db.delete(circles).where(eq(circles.name, `历史测试社团_${RUN}`));
    await app.close();
  });

  describe('认证', () => {
    it('不带 token 应返回 401', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/history' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('倒序排列', () => {
    it('3 作品 updatedAt 为 T1 < T2 < T3 → 返回 [C, B, A]', async () => {
      // 每个作品只写一行进度，updatedAt 不同
      await insertProgress(WORK_A, 'a1.mp3', T1);
      await insertProgress(WORK_B, 'b1.mp3', T2);
      await insertProgress(WORK_C, 'c1.mp3', T3);

      const res = await app.inject({
        method: 'GET',
        url: '/api/history',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ids = body.works.map((w: { id: string }) => w.id);
      // C (T3) 最新排第一，B (T2) 次之，A (T1) 最后
      expect(ids).toEqual([WORK_C, WORK_B, WORK_A]);
      expect(body.pagination.totalCount).toBe(3);
    });
  });

  describe('同作品多轨去重', () => {
    it('同一作品两行不同 mediaIndex → 只出现一次，取新行时间排序', async () => {
      // WORK_A 已有 T1 进度（track a1.mp3）
      // 再加一行更新的进度（track a2.mp3），updatedAt = T_NEW
      await insertProgress(WORK_A, 'a2.mp3', T_NEW);

      const res = await app.inject({
        method: 'GET',
        url: '/api/history',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = res.json();
      const ids = body.works.map((w: { id: string }) => w.id);

      // WORK_A 只出现一次
      const aCount = ids.filter((id: string) => id === WORK_A).length;
      expect(aCount).toBe(1);

      // WORK_A 排在第一个（T_NEW 最新）
      expect(ids[0]).toBe(WORK_A);

      // userProgress.updatedAt 应为 T_NEW（取最新行）
      const workA = body.works.find((w: { id: string }) => w.id === WORK_A);
      expect(workA.userProgress.updatedAt).toBe(T_NEW);
    });
  });

  describe('分页', () => {
    it('pageSize=2 → 第一页 2 条 + totalCount: 3', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/history?page=1&pageSize=2',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.works).toHaveLength(2);
      expect(body.pagination).toEqual({
        currentPage: 1,
        pageSize: 2,
        totalCount: 3,
      });
    });

    it('page=2 → 剩余 1 条', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/history?page=2&pageSize=2',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.works).toHaveLength(1);
      expect(body.pagination).toEqual({
        currentPage: 2,
        pageSize: 2,
        totalCount: 3,
      });
    });
  });

  describe('软删排除', () => {
    it('最新作品 deletedAt 置值后不再出现，totalCount 减 1', async () => {
      // T4 是最新时间，给 WORK_D 插入进度
      await insertProgress(WORK_D, 'd1.mp3', T4);

      // 确认 WORK_D 在历史中
      const before = await app.inject({
        method: 'GET',
        url: '/api/history?page=1&pageSize=10',
        headers: { authorization: `Bearer ${token}` },
      });
      const idsBefore = before.json().works.map((w: { id: string }) => w.id);
      expect(idsBefore).toContain(WORK_D);
      const totalBefore = before.json().pagination.totalCount;

      // 软删 WORK_D
      await db
        .update(works)
        .set({ deletedAt: new Date().toISOString() })
        .where(eq(works.id, WORK_D));

      const after = await app.inject({
        method: 'GET',
        url: '/api/history?page=1&pageSize=10',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = after.json();
      const idsAfter = body.works.map((w: { id: string }) => w.id);
      expect(idsAfter).not.toContain(WORK_D);
      expect(body.pagination.totalCount).toBe(totalBefore - 1);
    });
  });

  describe('userProgress 注入', () => {
    it('响应内 work 的 userProgress.updatedAt 等于该作品最新进度行时间', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/history?page=1&pageSize=10',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = res.json();

      // WORK_B 只有一行进度，updatedAt = T2
      const workB = body.works.find((w: { id: string }) => w.id === WORK_B);
      expect(workB).toBeDefined();
      expect(workB.userProgress).not.toBeNull();
      expect(workB.userProgress.updatedAt).toBe(T2);
    });
  });

  describe('duration 注入', () => {
    it('有音轨的作品注入 SUM(duration_sec)，无音轨作品为 null', async () => {
      await db.insert(tracks).values([
        {
          workId: WORK_A,
          mediaIndex: 'dur-a1.mp3',
          title: 'a1',
          sizeBytes: 1,
          durationSec: 60,
        },
        {
          workId: WORK_A,
          mediaIndex: 'dur-a2.mp3',
          title: 'a2',
          sizeBytes: 1,
          durationSec: 30,
        },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/history?page=1&pageSize=10',
        headers: { authorization: `Bearer ${token}` },
      });
      const body = res.json();
      const workA = body.works.find((w: { id: string }) => w.id === WORK_A);
      const workB = body.works.find((w: { id: string }) => w.id === WORK_B);
      expect(workA.duration).toBe(90);
      expect(workB.duration).toBeNull();
    });
  });

  describe('空历史', () => {
    it('新用户无进度行 → works=[], totalCount=0', async () => {
      // 注册一个全新用户（无任何进度行）
      const freshUser = `history_fresh_${RUN}`;
      await db.insert(users).values({
        name: freshUser,
        password: 'test-password',
        group: 'user',
      });
      const freshToken = app.jwt.sign({ name: freshUser, group: 'user' });

      const res = await app.inject({
        method: 'GET',
        url: '/api/history',
        headers: { authorization: `Bearer ${freshToken}` },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.works).toEqual([]);
      expect(body.pagination).toEqual({
        currentPage: 1,
        pageSize: 20,
        totalCount: 0,
      });

      // 清理
      await db.delete(users).where(eq(users.name, freshUser));
    });
  });
});
