import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectWorkEntries } from './utils.js';

let root: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), 'kiku-fs-utils-'));
});

afterAll(() => {
  rmSync(root, { recursive: true, force: true });
});

describe('collectWorkEntries（枚举结果对象语义）', () => {
  it('可枚举的空目录 → complete:true + 空数组（真正为空 ≠ 枚举失败）', async () => {
    const empty = join(root, 'empty');
    mkdirSync(empty);
    const result = await collectWorkEntries(empty, 2);
    if (!result.complete) {
      throw new Error('expected enumeration to be complete');
    }
    expect(result.entries).toEqual([]);
  });

  it('readdir 失败（路径不存在）→ complete:false + failedPath/reason，不抛异常、不静默当空', async () => {
    // ENOENT 与 EACCES / EIO / NAS 未挂载同属「枚举失败」，语义必须一致：
    // 通过返回值短路告知调用方，而非 reject 或返回空数组
    const missing = join(root, 'does-not-exist');
    const result = await collectWorkEntries(missing, 2);
    if (result.complete) {
      throw new Error('expected enumeration to be incomplete');
    }
    // 类型层锁定契约：判别联合收窄后 failedPath/reason 必为 string（非可选）
    const failedPath: string = result.failedPath;
    const reason: string = result.reason;
    // 失败分支不含 entries 字段（运行时锁定判别联合形状）
    expect('entries' in result).toBe(false);
    expect(failedPath).toBe(missing);
    expect(reason).toBeTruthy();
  });
});
