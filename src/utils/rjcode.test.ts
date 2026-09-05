import { describe, expect, it } from 'bun:test';
import {
  dlsiteAjaxSegment,
  dlsiteImgSegment,
  dlsiteSiteSegment,
  extractWorkCode,
  isValidWorkId,
  parseWorkCode,
} from './rjcode';

describe('extractWorkCode（提取第一个作品代码）', () => {
  it.each([
    ['RJ01578781', 'RJ01578781'],
    ['rj01578781', 'rj01578781'], // 保持原样（小写不归一）
    ['VJ01003042', 'VJ01003042'],
    ['vj01003042', 'vj01003042'],
    ['[RJ01578781][テストサークル] タイトル', 'RJ01578781'],
    ['RJ123456 与 VJ123456 并列时取第一个', 'RJ123456'],
  ])('%s → %s', (input, expected) => {
    expect(extractWorkCode(input)).toBe(expected);
  });

  it.each([
    ['RJ1234567'], // 7 位：不支持
    ['RJ123456789'], // 9 位：不得截断出片段
    ['VJ12345'], // 5 位：不支持
    ['BJ012345'], // 不支持 BJ
    ['no code here'],
  ])('%s → null', (input) => {
    expect(extractWorkCode(input)).toBeNull();
  });
});

describe('isValidWorkId（精确校验）', () => {
  it.each([
    ['RJ01578781', true],
    ['VJ01003042', true],
    ['RJ123456', true],
    ['rj123456', true],
    ['RJ1234567', false],
    ['RJ12345', false],
    ['BJ012345', false], // 明确不支持 BJ
    [' RJ123456', false],
    ['RJ123456 ', false],
    ['', false],
  ])('%s → %s', (input, expected) => {
    expect(isValidWorkId(input)).toBe(expected);
  });
});

describe('parseWorkCode（拆分前缀与数字）', () => {
  it('VJ01003042 → VJ / 01003042', () => {
    expect(parseWorkCode('VJ01003042')).toEqual({
      prefix: 'VJ',
      digits: '01003042',
    });
  });

  it('rj123456 → RJ / 123456（前缀归一为大写）', () => {
    expect(parseWorkCode('rj123456')).toEqual({
      prefix: 'RJ',
      digits: '123456',
    });
  });

  it('非法输入返回 null', () => {
    expect(parseWorkCode('123456')).toBeNull(); // 无前缀
    expect(parseWorkCode('RJ1234567')).toBeNull();
    expect(parseWorkCode('VJ')).toBeNull();
  });
});

describe('DLsite URL 段映射', () => {
  it('作品页站点段：RJ → maniax，VJ → pro', () => {
    expect(dlsiteSiteSegment('RJ')).toBe('maniax');
    expect(dlsiteSiteSegment('VJ')).toBe('pro');
  });

  it('Ajax 站点段：RJ → maniax-touch，VJ → pro-touch', () => {
    expect(dlsiteAjaxSegment('RJ')).toBe('maniax-touch');
    expect(dlsiteAjaxSegment('VJ')).toBe('pro-touch');
  });

  it('封面图路径段：RJ → doujin，VJ → professional', () => {
    expect(dlsiteImgSegment('RJ')).toBe('doujin');
    expect(dlsiteImgSegment('VJ')).toBe('professional');
  });
});
