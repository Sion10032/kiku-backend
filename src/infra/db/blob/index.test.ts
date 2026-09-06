import { describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { getBlob, putBlobs } from './index.js';

setupTestEnvironment();

describe('putBlobs', () => {
  it('批量 upsert：一次写入多条且可覆盖', () => {
    putBlobs([
      {
        namespace: 'cover',
        key: 'RJ000001_full',
        data: Buffer.from('a'),
        mimeType: 'image/jpeg',
      },
      {
        namespace: 'cover',
        key: 'RJ000002_full',
        data: Buffer.from('b'),
        mimeType: 'image/jpeg',
      },
    ]);
    putBlobs([
      {
        namespace: 'cover',
        key: 'RJ000001_full',
        data: Buffer.from('a2'),
        mimeType: 'image/jpeg',
      },
    ]);
    expect(getBlob('cover', 'RJ000001_full')?.data.toString()).toBe('a2');
    expect(getBlob('cover', 'RJ000002_full')?.data.toString()).toBe('b');
  });

  it('空数组 no-op', () => {
    putBlobs([]);
    expect(getBlob('cover', 'none')).toBeNull();
  });
});
