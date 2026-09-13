import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { db } from '../src/infra/db/main/index.js';
import { users } from '../src/infra/db/main/schema.js';
import { setupTestEnvironment } from './helpers/setup';
import { signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const USER_A = `sb_a_${RUN}`;
const USER_B = `sb_b_${RUN}`;

interface SummaryDto {
  name: string;
  updatedAt: string;
}

interface DetailDto {
  name: string;
  payload: string;
  updatedAt: string;
}

describe('Settings Backup Routes', () => {
  let app: FastifyInstance;
  let tokenA: string;
  let tokenB: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();

    await db
      .insert(users)
      .values({ name: USER_A, password: 'test-password', group: 'user' });
    await db
      .insert(users)
      .values({ name: USER_B, password: 'test-password', group: 'user' });

    tokenA = await signTokenFor(app, USER_A);
    tokenB = await signTokenFor(app, USER_B);
  });

  afterAll(async () => {
    // 删除用户，settingsBackups 外键 onDelete: cascade 带走备份
    await db.delete(users).where(eq(users.name, USER_A));
    await db.delete(users).where(eq(users.name, USER_B));
    await app.close();
  });

  /** PUT 备份的快捷方式 */
  async function putBackup(
    token: string,
    name: string,
    payload: unknown,
  ): Promise<{
    statusCode: number;
    body: { name?: string; updatedAt?: string; error?: string };
  }> {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/settings-backups/${name}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { payload },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  /** GET 备份详情的快捷方式 */
  async function getBackup(
    token: string,
    name: string,
  ): Promise<{
    statusCode: number;
    body: Partial<DetailDto> & { error?: string };
  }> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/settings-backups/${name}`,
      headers: { authorization: `Bearer ${token}` },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  /** GET 备份列表的快捷方式 */
  async function listBackups(token: string): Promise<SummaryDto[]> {
    const res = await app.inject({
      method: 'GET',
      url: '/api/settings-backups',
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return (res.json() as { backups: SummaryDto[] }).backups;
  }

  describe('认证', () => {
    it('GET 列表不带 token → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings-backups',
      });
      expect(res.statusCode).toBe(401);
    });

    it('GET :name 不带 token → 401', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/settings-backups/whatever',
      });
      expect(res.statusCode).toBe(401);
    });

    it('PUT :name 不带 token → 401', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings-backups/whatever',
        payload: { payload: {} },
      });
      expect(res.statusCode).toBe(401);
    });

    it('DELETE :name 不带 token → 401', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/settings-backups/whatever',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('空列表', () => {
    it('新用户 GET 列表 → { backups: [] }（此用例先于任何 PUT 执行）', async () => {
      const backups = await listBackups(tokenA);
      expect(backups).toEqual([]);
    });
  });

  describe('新建', () => {
    it('PUT 新备份 → 200；列表含该项；详情 payload 原样返回', async () => {
      const payload = {
        colorMode: 'dark',
        floatingLyrics: { enabled: true, fontSize: 14, lines: 2, opacity: 0.8 },
      };
      const put = await putBackup(tokenA, 'basic_a', payload);
      expect(put.statusCode).toBe(200);
      expect(put.body.name).toBe('basic_a');
      expect(typeof put.body.updatedAt).toBe('string');

      // 列表含该项，updatedAt 与 PUT 响应一致
      const backups = await listBackups(tokenA);
      const item = backups.find((b) => b.name === 'basic_a');
      expect(item).toBeDefined();
      expect(item!.updatedAt).toBe(put.body.updatedAt!);

      // 详情 payload 可 parse 回原嵌套结构
      const detail = await getBackup(tokenA, 'basic_a');
      expect(detail.statusCode).toBe(200);
      expect(detail.body.name).toBe('basic_a');
      expect(JSON.parse(detail.body.payload!)).toEqual(payload);
      expect(detail.body.updatedAt).toBe(put.body.updatedAt!);
    });
  });

  describe('覆盖更新', () => {
    it('同名 PUT 不同 payload → 200，updatedAt 变新，列表仍 1 条', async () => {
      const first = await putBackup(tokenA, 'overwrite_x', {
        mediaNotification: true,
      });
      expect(first.statusCode).toBe(200);
      const firstUpdatedAt = first.body.updatedAt!;

      // ISO 时间戳精确到毫秒，稍等确保可比
      await new Promise((r) => setTimeout(r, 5));

      const secondPayload = {
        mediaNotification: false,
        preview: { textFontSize: 16, textWordWrap: false },
      };
      const second = await putBackup(tokenA, 'overwrite_x', secondPayload);
      expect(second.statusCode).toBe(200);
      expect(second.body.updatedAt! > firstUpdatedAt).toBe(true);

      // 覆盖后 overwrite_ 前缀仍只有 1 条
      const names = (await listBackups(tokenA))
        .map((b) => b.name)
        .filter((n) => n.startsWith('overwrite_'));
      expect(names).toEqual(['overwrite_x']);

      // payload 已被覆盖
      const detail = await getBackup(tokenA, 'overwrite_x');
      expect(JSON.parse(detail.body.payload!)).toEqual(secondPayload);
    });
  });

  describe('404 与幂等删除', () => {
    it('GET 不存在的备份 → 404 { error: 备份不存在 }', async () => {
      const detail = await getBackup(tokenA, 'no_such_backup');
      expect(detail.statusCode).toBe(404);
      expect(detail.body).toEqual({ error: '备份不存在' });
    });

    it('DELETE 不存在的备份 → 200（幂等）', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/settings-backups/no_such_backup',
        headers: { authorization: `Bearer ${tokenA}` },
      });
      expect(res.statusCode).toBe(200);
      expect(typeof (res.json() as { message: string }).message).toBe('string');
    });
  });

  describe('上限', () => {
    it('连续 PUT 10 个新 name 全部 200；第 11 个 → 409；覆盖已有仍 200', async () => {
      // USER_B 此时尚无备份，独立从 0 数起
      for (let i = 0; i < 10; i++) {
        const put = await putBackup(
          tokenB,
          `lim_${String(i).padStart(2, '0')}`,
          { i },
        );
        expect(put.statusCode).toBe(200);
      }

      const eleventh = await putBackup(tokenB, 'lim_10', { i: 10 });
      expect(eleventh.statusCode).toBe(409);
      expect(eleventh.body).toEqual({ error: '最多保留 10 条备份' });

      // 覆盖更新已有备份不受上限限制
      const overwrite = await putBackup(tokenB, 'lim_03', {
        i: 'overwritten',
      });
      expect(overwrite.statusCode).toBe(200);

      // 列表仍是 10 条
      expect(await listBackups(tokenB)).toHaveLength(10);
    });
  });

  describe('用户隔离', () => {
    it('USER_B 的列表看不到 USER_A 的备份', async () => {
      const namesB = (await listBackups(tokenB)).map((b) => b.name);
      // USER_B 只有自己上限用例创建的 lim_* 备份
      expect(namesB.every((n) => n.startsWith('lim_'))).toBe(true);
      expect(namesB).not.toContain('basic_a');
      expect(namesB).not.toContain('overwrite_x');

      const namesA = (await listBackups(tokenA)).map((b) => b.name);
      expect(namesA.every((n) => !n.startsWith('lim_'))).toBe(true);

      // 删除一条已有备份腾出名额（同时覆盖 DELETE 已有备份的正常路径）
      const del = await app.inject({
        method: 'DELETE',
        url: '/api/settings-backups/lim_09',
        headers: { authorization: `Bearer ${tokenB}` },
      });
      expect(del.statusCode).toBe(200);
      expect(typeof (del.json() as { message: string }).message).toBe('string');
      expect(await listBackups(tokenB)).toHaveLength(9);
    });

    it('两用户同名备份互不干扰（payload 各自独立）', async () => {
      const payloadA = { colorMode: 'light', worksHistoryStrip: true };
      const payloadB = { colorMode: 'dark', worksHistoryStrip: false };

      const putA = await putBackup(tokenA, 'iso_same', payloadA);
      const putB = await putBackup(tokenB, 'iso_same', payloadB);
      expect(putA.statusCode).toBe(200);
      expect(putB.statusCode).toBe(200);

      const detailA = await getBackup(tokenA, 'iso_same');
      const detailB = await getBackup(tokenB, 'iso_same');
      expect(JSON.parse(detailA.body.payload!)).toEqual(payloadA);
      expect(JSON.parse(detailB.body.payload!)).toEqual(payloadB);
    });
  });

  describe('参数校验', () => {
    it('PUT payload 缺失 → 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings-backups/bad_payload',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });

    it('payload 非对象 → 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/settings-backups/bad_payload',
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { payload: 'str' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('name 超长（>50 字符）→ 400', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: `/api/settings-backups/${'x'.repeat(51)}`,
        headers: { authorization: `Bearer ${tokenA}` },
        payload: { payload: { ok: true } },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('payload 严格校验', () => {
    it('完整快照（11 键齐全）PUT → 200；GET parse 后结构与值原样保留', async () => {
      const snapshot = {
        dynamicColor: false,
        colorMode: 'auto',
        mediaNotification: false,
        floatingLyrics: { enabled: true, fontSize: 16, lines: 3, opacity: 0.5 },
        preview: { textFontSize: 20, textWordWrap: false },
        coverBlurMode: 'hover',
        timeDisplayMode: 'remaining',
        worksPaginationMode: 'infinite',
        worksPaginatorPosition: 'bottom',
        worksHistoryStrip: false,
        uiScale: 110,
      };
      const put = await putBackup(tokenA, 'strict_full', snapshot);
      expect(put.statusCode).toBe(200);

      const detail = await getBackup(tokenA, 'strict_full');
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body.payload!)).toEqual(snapshot);
    });

    it('枚举全值合法 → 200：colorMode 三值各自 PUT，其余枚举逐值覆盖', async () => {
      for (const colorMode of ['light', 'dark', 'auto'] as const) {
        const res = await putBackup(tokenA, 'strict_enum', { colorMode });
        expect(res.statusCode).toBe(200);
      }
      const others = [
        { coverBlurMode: 'always' },
        { coverBlurMode: 'hover' },
        { coverBlurMode: 'never' },
        { timeDisplayMode: 'total' },
        { timeDisplayMode: 'remaining' },
        { worksPaginationMode: 'paginate' },
        { worksPaginationMode: 'infinite' },
        { worksPaginatorPosition: 'top' },
        { worksPaginatorPosition: 'bottom' },
        { worksPaginatorPosition: 'both' },
      ] as const;
      for (const payload of others) {
        const res = await putBackup(tokenA, 'strict_enum', payload);
        expect(res.statusCode).toBe(200);
      }
    });

    it('未知顶层键被 trim：入库 payload 无 evil/hack，已知键保留', async () => {
      const res = await putBackup(tokenA, 'strict_trim_top', {
        colorMode: 'dark',
        evil: { a: 1 },
        hack: 'x',
      });
      expect(res.statusCode).toBe(200);

      const detail = await getBackup(tokenA, 'strict_trim_top');
      expect(detail.statusCode).toBe(200);
      // 精确相等：证明 handler 拿到的是 strip 后的 body（zod 验证结果替换了 request.body）
      expect(JSON.parse(detail.body.payload!)).toEqual({ colorMode: 'dark' });
    });

    it('未知嵌套键被 trim：floatingLyrics.extra 被剔除，已知键保留', async () => {
      const res = await putBackup(tokenA, 'strict_trim_nested', {
        floatingLyrics: {
          enabled: true,
          fontSize: 14,
          lines: 1,
          opacity: 0.5,
          extra: 'junk',
        },
      });
      expect(res.statusCode).toBe(200);

      const detail = await getBackup(tokenA, 'strict_trim_nested');
      expect(detail.statusCode).toBe(200);
      expect(JSON.parse(detail.body.payload!)).toEqual({
        floatingLyrics: { enabled: true, fontSize: 14, lines: 1, opacity: 0.5 },
      });
    });

    it('枚举非法值 → 400（colorMode: sepia）', async () => {
      const res = await putBackup(tokenA, 'strict_bad_enum', {
        colorMode: 'sepia',
      });
      expect(res.statusCode).toBe(400);
    });

    it('嵌套字段类型错误 → 400（floatingLyrics.enabled 为字符串）', async () => {
      const res = await putBackup(tokenA, 'strict_bad_type', {
        floatingLyrics: {
          enabled: 'yes',
          fontSize: 14,
          lines: 1,
          opacity: 0.5,
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('嵌套字段缺失 → 400（floatingLyrics 无 opacity）', async () => {
      const res = await putBackup(tokenA, 'strict_bad_missing', {
        floatingLyrics: { enabled: true, fontSize: 14, lines: 1 },
      });
      expect(res.statusCode).toBe(400);
    });

    it('payload 超过 4KB（含超大未知键）→ 400 且 error 含「4KB」', async () => {
      // 若大小闸在 zod 验证之后，超大未知键会被先 strip 掉而返回 200；
      // 400 证明 preValidation 在验证前拦截
      const res = await putBackup(tokenA, 'strict_too_big', {
        colorMode: 'dark',
        junk: 'x'.repeat(5000),
      });
      expect(res.statusCode).toBe(400);
      expect(res.body.error).toContain('4KB');
    });

    it('字段类型错误 → 400（uiScale 为字符串）', async () => {
      const res = await putBackup(tokenA, 'strict_bad_ui_scale', {
        uiScale: '110',
      });
      expect(res.statusCode).toBe(400);
    });
  });
});
