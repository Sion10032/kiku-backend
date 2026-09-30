import { describe, expect, test } from 'bun:test';
import { workSourceResolver } from './index';
import { deriveManualTitle, MANUAL_PREFIXES } from './manual';

describe('workSourceResolver.classify', () => {
  // 单例直连 MANUAL_PREFIXES：用例随生产常量联动（改前缀需同步核对本表）

  const cases: Array<{
    id: string;
    expected: 'dlsite' | 'manual' | null;
    note: string;
  }> = [
    { id: 'RJ01173549', expected: 'dlsite', note: 'RJ → dlsite' },
    { id: 'VJ01003042', expected: 'dlsite', note: 'VJ → dlsite' },
    { id: 'UW00000001', expected: 'manual', note: '已配置的人工前缀 → manual' },
    { id: 'UW123456', expected: 'manual', note: '6 位数字同样合法' },
    {
      id: 'XX00000001',
      expected: null,
      note: '未配置的前缀 → null',
    },
    { id: 'garbage', expected: null, note: '非作品代码 → null' },
  ];

  for (const { id, expected, note } of cases) {
    test(`${id} → ${expected}（${note}）`, () => {
      expect(workSourceResolver.classify(id)).toBe(expected);
    });
  }
});

describe('workSourceResolver.parse', () => {
  test('命中前缀时返回归一后的前缀与数字部分', () => {
    expect(workSourceResolver.parse('uw00000001')).toEqual({
      prefix: 'UW',
      digits: '00000001',
    });
  });

  test('未配置前缀返回 null', () => {
    expect(workSourceResolver.parse('XX00000001')).toBeNull();
  });
});

describe('deriveManualTitle', () => {
  const cases: Array<{
    folderName: string;
    code: string;
    expected: string;
    note: string;
  }> = [
    {
      folderName: 'UW00000001_测试作品',
      code: 'UW00000001',
      expected: '测试作品',
      note: '下划线分隔 → 取标题',
    },
    {
      folderName: 'UW00000001',
      code: 'UW00000001',
      expected: 'UW00000001',
      note: '无剩余部分 → 回退整个文件夹名',
    },
    {
      folderName: 'uw00000001-foo',
      code: 'UW00000001',
      expected: 'foo',
      note: '连字符分隔且大小写不敏感 → 取标题',
    },
  ];

  for (const { folderName, code, expected, note } of cases) {
    test(`${JSON.stringify(folderName)} → ${JSON.stringify(expected)}（${note}）`, () => {
      expect(deriveManualTitle(folderName, code)).toBe(expected);
    });
  }
});

describe('MANUAL_PREFIXES 守卫', () => {
  test('每项都是恰好两个大写字母', () => {
    for (const prefix of MANUAL_PREFIXES) {
      expect(prefix).toMatch(/^[A-Z]{2}$/);
    }
  });

  test('不含 DLsite 前缀 RJ / VJ', () => {
    for (const prefix of MANUAL_PREFIXES) {
      expect(prefix === 'RJ' || prefix === 'VJ').toBe(false);
    }
  });

  test('无重复', () => {
    expect(new Set(MANUAL_PREFIXES).size).toBe(MANUAL_PREFIXES.length);
  });
});
