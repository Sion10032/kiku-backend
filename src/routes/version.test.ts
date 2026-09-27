import { beforeAll, describe, expect, it } from 'bun:test';
import { setupTestEnvironment } from '@test/helpers/setup';
import { buildApp } from '../app.js';
import { getConfig, setConfigForTesting } from '../infra/config/index.js';

setupTestEnvironment();

let app: Awaited<ReturnType<typeof buildApp>>;

beforeAll(async () => {
  app = await buildApp();
});

/** 进程内配置单例：私有模式用例改完必须还原，避免泄漏到同进程其它用例 */
const baseConfig = getConfig();

describe('GET /api/version', () => {
  it('未打包时返回兜底值 dev / unknown', async () => {
    // 公开模式：本用例只管响应内容，鉴权行为交给下一条用例
    setConfigForTesting({ ...baseConfig, instanceMode: 'public' });
    try {
      const res = await app.inject({ method: 'GET', url: '/api/version' });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      // bun test 不走 build.ts 打包，两个标识符不存在 → 兜底值。
      // 注入路径（真值为 package.json 版本 + 传入的短 hash）由构建后跑 dist 验证，
      // 单测无法覆盖 define，只能锁住守卫不崩且落到约定兜底。
      expect(body.current).toBe('dev');
      expect(body.commit).toBe('unknown');
      expect(body.latest).toBe(null);
      expect(body.updateAvailable).toBe(false);
    } finally {
      setConfigForTesting(baseConfig);
    }
  });

  it('私有模式下匿名可访问（PUBLIC_PATHS 白名单）', async () => {
    setConfigForTesting({ ...baseConfig, instanceMode: 'private' });
    try {
      const anon = await app.inject({ method: 'GET', url: '/api/version' });
      expect(anon.statusCode).toBe(200);

      // 对照组：同模式下非白名单端点仍要 401，确认私有模式确实生效
      // （否则本用例会因为「模式没切过去」而假通过）
      const guarded = await app.inject({ method: 'GET', url: '/api/works' });
      expect(guarded.statusCode).toBe(401);
    } finally {
      setConfigForTesting(baseConfig);
    }
  });
});
