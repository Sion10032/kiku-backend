import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq, inArray } from 'drizzle-orm';
import { db } from '../infra/db/main/index.js';
import { circles, rootFolders, works } from '../infra/db/main/schema.js';
import {
  createRootFolder,
  deleteRootFolder,
  getRootFolderPathByName,
  listRootFolders,
  updateRootFolder,
} from './rootFolder.service.js';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const CIRCLE = `RGRF${RUN.replace(/\D/g, '').slice(0, 3)}`;
const A = `a-${RUN}`;
const B = `b-${RUN}`;

async function makeWork(
  id: string,
  rootFolder: string,
  deletedAt: string | null = null,
) {
  await db
    .insert(works)
    .values({ id, rootFolder, dir: `d/${id}`, title: 't', circleId: CIRCLE });
  if (deletedAt)
    await db.update(works).set({ deletedAt }).where(eq(works.id, id));
}

describe('rootFolder.service', () => {
  beforeAll(async () => {
    await db.insert(circles).values({ id: CIRCLE, name: `rf-circle-${RUN}` });
  });

  afterAll(async () => {
    await db.delete(works).where(eq(works.circleId, CIRCLE));
    await db.delete(circles).where(eq(circles.id, CIRCLE));
    await db
      .delete(rootFolders)
      .where(inArray(rootFolders.name, [A, B, `c-${RUN}`]));
  });

  it('创建 / 列表 / 取 path', async () => {
    const created = await createRootFolder({ name: A, path: `/tmp/rf-${RUN}` });
    expect(created.ok).toBe(true);
    expect(await getRootFolderPathByName(A)).toBe(`/tmp/rf-${RUN}`);
    expect((await listRootFolders()).map((f) => f.name)).toContain(A);
  });

  it('path 未配置 → getRootFolderPathByName 返回 null', async () => {
    await db.insert(rootFolders).values({ name: `c-${RUN}`, path: null });
    expect(await getRootFolderPathByName(`c-${RUN}`)).toBeNull();
  });

  it('改名 → works.root_folder 由外键级联跟随', async () => {
    const id = `RJRFA${RUN}`.slice(0, 12);
    await makeWork(id, A);
    const renamed = await updateRootFolder(A, {
      name: B,
      path: `/tmp/rf-${RUN}`,
    });
    expect(renamed.ok).toBe(true);
    const row = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, id) },
    });
    // 关键断言：不是「查得到」而是「真的被级联改写」
    expect(row?.rootFolder).toBe(B);
  });

  it('改名撞已有名字 → name-taken，且原行未被改动', async () => {
    const dup = await updateRootFolder(B, { name: `c-${RUN}`, path: '/tmp/x' });
    expect(dup).toEqual({ ok: false, reason: 'name-taken' });
    expect(await getRootFolderPathByName(B)).toBe(`/tmp/rf-${RUN}`);
  });

  it('同名创建 → name-taken', async () => {
    expect(await createRootFolder({ name: B, path: '/tmp/other' })).toEqual({
      ok: false,
      reason: 'name-taken',
    });
  });

  it('删有名下作品（含软删）的目录 → has-works，计数包含软删', async () => {
    await makeWork(`RJRFC${RUN}`.slice(0, 12), B, '2026-01-01T00:00:00.000Z');
    const out = await deleteRootFolder(B);
    expect(out).toEqual({ ok: false, reason: 'has-works', workCount: 2 });
  });

  it('删不存在 / 空目录', async () => {
    expect(await deleteRootFolder('nope')).toEqual({
      ok: false,
      reason: 'not-found',
      workCount: 0,
    });
    expect(await deleteRootFolder(`c-${RUN}`)).toEqual({ ok: true });
  });
});
