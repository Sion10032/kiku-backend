import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/infra/db/main/index.js';
import { circles, users, works } from '../src/infra/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const TEST_USER = `review_route_${RUN}`;
const WORK_ID = `RJ${RUN.padStart(8, '0').slice(-8)}`;
// 软删作品用不同的前缀构造，避免与 WORK_ID 撞 id（都进 t_work 主键）
const DELETED_WORK_ID = `RJDEL${RUN}`;
// circle 主键是 DLsite maker_id 形态的 text；RUN 的 base36 串未必含足够数字，补齐 3 位
const CIRCLE_ID = `RG91${RUN.replace(/\D/g, '').padEnd(3, '0').slice(0, 3)}`;

describe('Review Routes', () => {
  let app: FastifyInstance;
  let token: string;
  let circleId: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    // 造数：用户 + 社团 + 两个作品（正常 / 已软删，works.circleId 非空）
    await db
      .insert(users)
      .values({ name: TEST_USER, password: 'test-password', group: 'user' });
    const circle = await db
      .insert(circles)
      .values({ id: CIRCLE_ID, name: `评价路由测试社团_${RUN}` })
      .returning();
    const circleRow = circle[0];
    if (!circleRow) throw new Error('circle insert failed');
    circleId = circleRow.id;
    await db.insert(works).values({
      id: WORK_ID,
      rootFolder: 'test',
      dir: `test/${WORK_ID}`,
      title: '评价路由测试作品',
      circleId,
    });
    await db.insert(works).values({
      id: DELETED_WORK_ID,
      rootFolder: 'test',
      dir: `test/${DELETED_WORK_ID}`,
      title: '评价路由测试作品（已软删）',
      circleId,
      deletedAt: new Date().toISOString(),
    });

    token = await signTokenFor(app, TEST_USER);
  });

  afterAll(async () => {
    // 先删 works（reviews 靠 FK onDelete cascade 随之清理，
    // 且 works.circleId 无级联，必须先于 circle 删除），再删 circle / user
    await db.delete(works).where(eq(works.id, WORK_ID));
    await db.delete(works).where(eq(works.id, DELETED_WORK_ID));
    await db.delete(circles).where(eq(circles.id, circleId));
    await db.delete(users).where(eq(users.name, TEST_USER));
    await app.close();
  });

  describe('authentication', () => {
    it('PUT /api/review 应要求登录', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/review',
        payload: { work_id: WORK_ID, rating: 5 },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/review', () => {
    it('正常作品 → 200，返回体 workId 正确且 reviewCount 已回写', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/review',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: WORK_ID, rating: 4, review_text: '很好' },
      });
      expect(res.statusCode).toBe(200);
      const body = res.json() as { workId: string; rating: number };
      expect(body.workId).toBe(WORK_ID);
      expect(body.rating).toBe(4);

      // updateWorkReviewStats 确实执行（作品行 reviewCount 被回写为 1）
      const [work] = await db
        .select({ reviewCount: works.reviewCount })
        .from(works)
        .where(eq(works.id, WORK_ID));
      expect(work?.reviewCount).toBe(1);
    });

    it('幽灵 work_id（库中不存在）→ 404 而非 500', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/review',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: 'RJ99999999', rating: 5 },
      });
      // 修复前为外键违反导致的 500（SQLITE_CONSTRAINT_FOREIGNKEY）
      expect(res.statusCode).not.toBe(500);
      expect(res.statusCode).toBe(404);
    });

    it('已软删的作品 → 404（与 getWorkById 软删语义一致）', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/review',
        headers: { authorization: `Bearer ${token}` },
        payload: { work_id: DELETED_WORK_ID, rating: 5 },
      });
      expect(res.statusCode).toBe(404);
    });
  });
});
