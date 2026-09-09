import { describe, expect, it } from 'bun:test';
import { translate } from './index.js';
import en from './locales/en.json';
import zhCN from './locales/zh-CN.json';

describe('translate', () => {
  it('按 locale 取值', () => {
    expect(translate('zh-CN', 'errors.auth.invalid-credentials')).toBe(
      '用户名或密码错误',
    );
    expect(translate('en', 'errors.auth.invalid-credentials')).toBe(
      'Invalid credentials',
    );
  });

  it('key 缺失时回退 zh-CN，再缺失回显 key', () => {
    expect(translate('en', 'errors.nonexistent-key')).toBe(
      'errors.nonexistent-key',
    );
  });

  it('插值替换 {{name}} 占位符', () => {
    expect(translate('zh-CN', 'errors.work.not-found', { id: 'VJ123' })).toBe(
      '作品 VJ123 不存在',
    );
  });
});

describe('字典完整性', () => {
  it('两份字典 key 集合一致', () => {
    expect(Object.keys(zhCN).sort()).toEqual(Object.keys(en).sort());
  });
});
