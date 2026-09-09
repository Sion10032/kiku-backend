import { describe, expect, it } from 'bun:test';
import { FALLBACK_LOCALE, negotiate } from './negotiate.js';

describe('negotiate', () => {
  it('无头/空值回退 zh-CN', () => {
    expect(negotiate(undefined)).toBe('zh-CN');
    expect(negotiate('')).toBe('zh-CN');
  });

  it('精确匹配（大小写不敏感）', () => {
    expect(negotiate('zh-CN')).toBe('zh-CN');
    expect(negotiate('en')).toBe('en');
    expect(negotiate('ZH-cn')).toBe('zh-CN');
  });

  it('前缀归并：zh-TW → zh-CN（取支持列表中的 base 匹配项）', () => {
    expect(negotiate('zh-TW')).toBe('zh-CN');
    expect(negotiate('en-US,en;q=0.9')).toBe('en');
  });

  it('按 q 值降序选择', () => {
    expect(negotiate('en;q=0.3,zh-CN;q=0.8')).toBe('zh-CN');
  });

  it('q 相同保持声明顺序', () => {
    expect(negotiate('en,zh-CN')).toBe('en');
  });

  it('不支持的语言跳过，选下一个可匹配项', () => {
    expect(negotiate('ja,en-US;q=0.8,zh-CN;q=0.5')).toBe('en');
  });

  it('通配符与垃圾输入回退', () => {
    expect(negotiate('*')).toBe(FALLBACK_LOCALE);
    expect(negotiate('garbage,,*;q=1')).toBe(FALLBACK_LOCALE);
    expect(negotiate('ja-JP')).toBe(FALLBACK_LOCALE);
  });
});
