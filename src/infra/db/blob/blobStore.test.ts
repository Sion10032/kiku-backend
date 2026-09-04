import { beforeAll, describe, expect, it } from 'bun:test';
import { expectNotNull } from '@test/helpers/assert';
import { setupTestEnvironment } from '@test/helpers/setup';

setupTestEnvironment();

// 动态 import：确保 blobStore 开库发生在测试环境就绪之后
const { putBlob, getBlob, blobExists, deleteBlob } = await import('./index');

const NS = 'test-blob';

describe('blobStore', () => {
  beforeAll(() => {
    // 用例间隔离：清掉本 namespace 的旧数据
    deleteBlob(NS, 'a');
    deleteBlob(NS, 'b');
    deleteBlob(NS, 'cover');
  });

  it('put 后 get 能原样读回字节与元数据', () => {
    const bytes = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    putBlob(NS, 'a', bytes, 'image/png');

    const got = getBlob(NS, 'a');
    expectNotNull(got);
    expect(Buffer.isBuffer(got.data)).toBe(true);
    expect(got.data.equals(bytes)).toBe(true);
    expect(got.mimeType).toBe('image/png');
    expect(got.size).toBe(4);
  });

  it('get 不存在的 key 返回 null', () => {
    expect(getBlob(NS, 'nope')).toBeNull();
  });

  it('blobExists 反映存废', () => {
    expect(blobExists(NS, 'a')).toBe(true);
    expect(blobExists(NS, 'nope')).toBe(false);
  });

  it('同名 key 覆盖写，size/mime 更新', () => {
    putBlob(NS, 'a', Buffer.from([1, 2, 3, 4, 5]), 'image/jpeg');
    const got = getBlob(NS, 'a');
    expectNotNull(got);
    expect(got.size).toBe(5);
    expect(got.mimeType).toBe('image/jpeg');
    expect(got.data.equals(Buffer.from([1, 2, 3, 4, 5]))).toBe(true);
  });

  it('不同 namespace 互不可见', () => {
    putBlob('other', 'a', Buffer.from([9]), 'application/octet-stream');
    const other = getBlob(NS, 'a');
    expectNotNull(other);
    expect(other.data[0]).not.toBe(9);
    expect(blobExists('other', 'a')).toBe(true);
    deleteBlob('other', 'a');
  });

  it('mime 省略时存 null', () => {
    putBlob(NS, 'b', Buffer.from([0]));
    const gotB = getBlob(NS, 'b');
    expectNotNull(gotB);
    expect(gotB.mimeType).toBeNull();
  });

  it('deleteBlob 删除后不可读，再删返回 false', () => {
    putBlob(NS, 'cover', Buffer.from([1]), 'image/jpeg');
    expect(deleteBlob(NS, 'cover')).toBe(true);
    expect(getBlob(NS, 'cover')).toBeNull();
    expect(deleteBlob(NS, 'cover')).toBe(false);
  });
});
