import { describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import {
  deleteBlob,
  existingBlobKeys,
  getBlob,
  putBlob,
  putBlobs,
} from './index.js';

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

describe('existingBlobKeys', () => {
  it('命中子集：只返回给定期次里实际存在的 key', () => {
    putBlob('cover', 'RJ000010_main', Buffer.from('a'), 'image/jpeg');
    putBlob('cover', 'RJ000010_sam', Buffer.from('b'), 'image/jpeg');
    putBlob('cover', 'RJ000011_main', Buffer.from('c'), 'image/jpeg');
    try {
      const found = existingBlobKeys('cover', [
        'RJ000010_main',
        'RJ000010_240x240',
        'RJ000011_main',
      ]);
      expect(found).toEqual(new Set(['RJ000010_main', 'RJ000011_main']));
    } finally {
      for (const k of ['RJ000010_main', 'RJ000010_sam', 'RJ000011_main']) {
        deleteBlob('cover', k);
      }
    }
  });

  it('全部未命中 → 空 Set；空入参 → 空 Set', () => {
    expect(existingBlobKeys('cover', ['never/exists'])).toEqual(new Set());
    expect(existingBlobKeys('cover', [])).toEqual(new Set());
  });
});
