import { describe, expect, it } from 'bun:test';
import { sql } from 'drizzle-orm';
import { db } from './index.js';

// import db 即执行启动迁移（drizzle-orm/bun-sqlite/migrator，幂等）；
// 本文件断言元数据覆盖相关的迁移产物存在。
describe('元数据覆盖迁移产物', () => {
  it('3 张覆盖表存在', async () => {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'table'
           AND name IN ('t_work_meta_override', 'r_tag_work_override', 'r_va_work_override')`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual([
      'r_tag_work_override',
      'r_va_work_override',
      't_work_meta_override',
    ]);
  });

  it('3 个生效视图存在', async () => {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'view'
           AND name IN ('v_work', 'v_tag_work', 'v_va_work')`,
    );
    expect(rows.map((r) => r.name).sort()).toEqual(['v_tag_work', 'v_va_work', 'v_work']);
  });

  it('r_tag_work_override 带 tag_id 索引（add 探针按 tag 查找用）', async () => {
    const rows = await db.all<{ name: string }>(
      sql`SELECT name FROM sqlite_master WHERE type = 'index'
           AND tbl_name = 'r_tag_work_override' AND sql LIKE '%tag_id%'`,
    );
    expect(rows.length).toBeGreaterThanOrEqual(1);
  });
});
