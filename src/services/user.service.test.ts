import { afterAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { eq, inArray } from 'drizzle-orm';
import { hashPassword } from '../auth/utils.js';
import { db } from '../infra/db/main/index.js';
import { users } from '../infra/db/main/schema.js';
import { createUser, createUserAccount } from './user.service.js';

setupTestEnvironment();

// 每次运行生成唯一标识，避免与其他测试数据冲突；结束后清理
const RUN = Date.now().toString(36);
const created: string[] = [];

function uniqueName(tag: string): string {
  return `svc_${tag}_${RUN}`;
}

describe('user.service 建户', () => {
  afterAll(async () => {
    await db.delete(users).where(inArray(users.name, created));
  });

  describe('createUser', () => {
    it('首次插入返回行，重名返回 undefined 且不抛异常', async () => {
      const name = uniqueName('dup');
      created.push(name);
      const data = { name, password: hashPassword('pass-123'), group: 'user' };

      const first = await createUser(data);
      expect(first?.name).toBe(name);

      // 关键契约：重名用返回值表达，不再冒泡 UNIQUE 约束异常
      await expect(createUser(data)).resolves.toBeUndefined();

      // 旧行未被覆盖
      const rows = await db.select().from(users).where(eq(users.name, name));
      expect(rows).toHaveLength(1);
      expect(rows[0]?.password).toBe(data.password);
    });
  });

  describe('createUserAccount', () => {
    it('重名返回 conflict', async () => {
      const name = uniqueName('taken');
      created.push(name);

      expect(await createUserAccount(name, 'pass-123', 'user')).toMatchObject({
        ok: true,
      });
      expect(await createUserAccount(name, 'pass-123', 'guest')).toEqual({
        ok: false,
        reason: 'conflict',
      });
    });

    it('并发同名：一个 ok、一个 conflict，不抛异常', async () => {
      const name = uniqueName('race');
      created.push(name);

      const results = await Promise.all([
        createUserAccount(name, 'pass-123', 'user'),
        createUserAccount(name, 'pass-123', 'user'),
      ]);

      expect(results.filter((r) => r.ok)).toHaveLength(1);
      const failures = results.filter((r) => !r.ok);
      expect(failures).toHaveLength(1);
      expect(failures[0]).toMatchObject({ reason: 'conflict' });
    });
  });
});
