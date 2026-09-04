import { describe, expect, it } from 'bun:test';
import { classifyMissingWorks } from './prune.js';

const DAY = 24 * 60 * 60 * 1000;
const now = new Date('2024-06-01T00:00:00.000Z');

describe('classifyMissingWorks（源缺失差集分类）', () => {
  it('磁盘上存在的作品不进入任何删除分类', () => {
    const result = classifyMissingWorks(
      [{ id: 'RJ100001', deletedAt: null }],
      new Set(['RJ100001']),
      now,
      30,
    );
    expect(result.toSoftDelete).toEqual([]);
    expect(result.toHardDelete).toEqual([]);
    expect(result.inGrace).toEqual([]);
  });

  it('源缺失且未软删标记 → 软删', () => {
    const result = classifyMissingWorks(
      [{ id: 'RJ100001', deletedAt: null }],
      new Set(),
      now,
      30,
    );
    expect(result.toSoftDelete).toEqual(['RJ100001']);
    expect(result.toHardDelete).toEqual([]);
  });

  it('源缺失、已软删且超过宽限期 → 物理删', () => {
    const deletedAt = new Date(now.getTime() - 31 * DAY).toISOString();
    const result = classifyMissingWorks(
      [{ id: 'RJ100001', deletedAt }],
      new Set(),
      now,
      30,
    );
    expect(result.toHardDelete).toEqual(['RJ100001']);
    expect(result.toSoftDelete).toEqual([]);
  });

  it('源缺失、已软删但仍在宽限期内 → 保持软删', () => {
    const deletedAt = new Date(now.getTime() - 5 * DAY).toISOString();
    const result = classifyMissingWorks(
      [{ id: 'RJ100001', deletedAt }],
      new Set(),
      now,
      30,
    );
    expect(result.inGrace).toEqual(['RJ100001']);
    expect(result.toHardDelete).toEqual([]);
    expect(result.toSoftDelete).toEqual([]);
  });

  it('软删时间恰好等于宽限期 → 不物理删（须严格超过）', () => {
    const deletedAt = new Date(now.getTime() - 30 * DAY).toISOString();
    const result = classifyMissingWorks(
      [{ id: 'RJ100001', deletedAt }],
      new Set(),
      now,
      30,
    );
    expect(result.toHardDelete).toEqual([]);
    expect(result.inGrace).toEqual(['RJ100001']);
  });

  it('混合场景：在盘/未标记/超期/宽限内各归其位', () => {
    const expired = new Date(now.getTime() - 40 * DAY).toISOString();
    const recent = new Date(now.getTime() - 2 * DAY).toISOString();
    const result = classifyMissingWorks(
      [
        { id: 'RJ1', deletedAt: null }, // 在盘 → 不动
        { id: 'RJ2', deletedAt: expired }, // 缺失 + 超期 → 物理删
        { id: 'RJ3', deletedAt: expired }, // 在盘 → 不动（即使超期）
        { id: 'RJ4', deletedAt: null }, // 缺失 + 未标记 → 软删
        { id: 'RJ5', deletedAt: recent }, // 缺失 + 宽限内 → 保持
      ],
      new Set(['RJ1', 'RJ3']),
      now,
      30,
    );
    expect(result.toSoftDelete).toEqual(['RJ4']);
    expect(result.toHardDelete).toEqual(['RJ2']);
    expect(result.inGrace).toEqual(['RJ5']);
  });
});
