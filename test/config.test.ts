import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { configSchema } from '../src/infra/config/schema';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const CFG_USER = `cfg_tester_${RUN}`;

describe('Config Routes', () => {
  let app: FastifyInstance;
  let token = '';

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    // 私有模式全局守卫需要 JWT，回查鉴权要求用户真实入库
    await createTestUser(CFG_USER);
    token = await signTokenFor(app, CFG_USER);
  });

  afterAll(async () => {
    await deleteTestUser(CFG_USER);
    await app.close();
  });

  describe('已下线的公开配置端点', () => {
    it('带合法 token → 404（路由已删除）', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/config/shared',
        headers: { authorization: `Bearer ${token}` },
      });
      expect(response.statusCode).toBe(404);
    });

    it('匿名（私有模式）→ 401（白名单已移除，全局守卫先命中）', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/config/shared',
      });
      expect(response.statusCode).toBe(401);
    });
  });

  describe('configSchema 字段收窄', () => {
    const base = { md5secret: 'a', jwtsecret: 'b' };

    it('已下线键被 strip 且不抛错（旧 config.json 兼容）', () => {
      const cfg = configSchema.parse({
        ...base,
        pageSize: 48,
        enableGzip: true,
        rewindSeekTime: 12,
        forwardSeekTime: 60,
        offloadMedia: true,
        offloadStreamPath: '/media/stream/',
        offloadDownloadPath: '/media/download/',
      }) as Record<string, unknown>;

      for (const key of [
        'pageSize',
        'enableGzip',
        'rewindSeekTime',
        'forwardSeekTime',
        'offloadMedia',
        'offloadStreamPath',
        'offloadDownloadPath',
      ]) {
        expect(cfg).not.toHaveProperty(key);
      }
    });

    it('保留的实例键仍有默认值', () => {
      const cfg = configSchema.parse(base);
      expect(cfg.instanceMode).toBe('private');
      expect(cfg.allowRegistration).toBe(false);
      expect(cfg.tagLanguage).toBe('zh-cn');
      expect(cfg.autoLoudnessAnalysis).toBe(false);
    });
  });

  describe('GET /api/config/admin', () => {
    it('should require authentication', async () => {
      const response = await app.inject({
        method: 'GET',
        url: '/api/config/admin',
      });

      expect(response.statusCode).toBe(401);
    });
  });

  describe('Loudness Config Schema', () => {
    it('响度均衡配置键使用默认值', () => {
      const cfg = configSchema.parse({ md5secret: 'a', jwtsecret: 'b' });
      expect(cfg.autoLoudnessAnalysis).toBe(false);
      expect(cfg.ffmpegPath).toBe('ffmpeg');
      expect(cfg.analysisParallelism).toBe(2);
    });

    it('响度配置越界被拒绝', () => {
      const base = { md5secret: 'a', jwtsecret: 'b' };
      expect(() =>
        configSchema.parse({ ...base, analysisParallelism: 9 }),
      ).toThrow();
    });
  });
});
