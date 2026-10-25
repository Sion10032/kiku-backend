import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../src/app';
import { setupTestEnvironment } from './helpers/setup';
import { createTestUser, deleteTestUser, signTokenFor } from './helpers/token';

setupTestEnvironment();

const RUN = Date.now().toString(36);
const USER = `sb_eq_${RUN}`;

interface DetailDto {
  name: string;
  payload: string;
  updatedAt: string;
}

/** 前端 EqualizerPreset 结构（gains/qs 各 10 段） */
function preset(index: number) {
  return {
    id: `custom-${index}`,
    name: `Preset ${index}`,
    gains: [12, 8.5, 6, 3, 0, -0.5, -3, -6, -9.5, -12],
    qs: [1.4, 1.4, 1.4, 0.4, 0.4, 0.8, 1.2, 2, 4, 8],
  };
}

/** 8 套满载自定义 preset（前端 EQ_CUSTOM_PRESET_LIMIT 上限） */
function fullPresets() {
  return Array.from({ length: 8 }, (_, i) => preset(i));
}

describe('Settings Backup equalizer 字段', () => {
  let app: FastifyInstance;
  let token: string;

  beforeAll(async () => {
    app = await buildApp();
    await app.ready();
    await createTestUser(USER);
    token = await signTokenFor(app, USER);
  });

  afterAll(async () => {
    // 删除用户，settingsBackups 外键 onDelete: cascade 带走备份
    await deleteTestUser(USER);
    await app.close();
  });

  async function putBackup(payload: unknown) {
    const res = await app.inject({
      method: 'PUT',
      url: `/api/settings-backups/${`eq_${RUN}`}`,
      headers: { authorization: `Bearer ${token}` },
      payload: { payload },
    });
    return { statusCode: res.statusCode, body: res.json() };
  }

  async function getPayload(): Promise<unknown> {
    const res = await app.inject({
      method: 'GET',
      url: `/api/settings-backups/${`eq_${RUN}`}`,
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.statusCode).toBe(200);
    return JSON.parse((res.json() as DetailDto).payload);
  }

  it('合法 equalizer（8 套满载 preset）PUT 200，GET 回读深相等', async () => {
    const snapshot = {
      colorMode: 'dark',
      equalizer: {
        enabled: true,
        activeId: 'custom-3',
        customPresets: fullPresets(),
      },
    };

    const put = await putBackup(snapshot);
    expect(put.statusCode).toBe(200);

    expect(await getPayload()).toEqual(snapshot);
  });

  it('快照缺 equalizer 键 → 200（旧版本前端快照兼容）', async () => {
    const snapshot = { colorMode: 'light', uiScale: 100 };

    const put = await putBackup(snapshot);
    expect(put.statusCode).toBe(200);

    expect(await getPayload()).toEqual(snapshot);
  });

  it('customPresets 超 8 套 → 400', async () => {
    const put = await putBackup({
      equalizer: {
        enabled: false,
        activeId: 'flat',
        customPresets: Array.from({ length: 9 }, (_, i) => preset(i)),
      },
    });
    expect(put.statusCode).toBe(400);
  });

  it('gains 长度 ≠ 10 → 400', async () => {
    const put = await putBackup({
      equalizer: {
        enabled: true,
        activeId: 'custom-0',
        customPresets: [
          {
            id: 'custom-0',
            name: 'Short',
            gains: [1, 2, 3],
            qs: [1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4, 1.4],
          },
        ],
      },
    });
    expect(put.statusCode).toBe(400);
  });

  it('未知嵌套键被 strip：equalizer.extra 与 preset.label 剔除，已知键保留', async () => {
    const put = await putBackup({
      equalizer: {
        enabled: true,
        activeId: 'flat',
        customPresets: [{ ...preset(0), label: 'junk' }],
        extra: 'junk',
      },
    });
    expect(put.statusCode).toBe(200);

    expect(await getPayload()).toEqual({
      equalizer: {
        enabled: true,
        activeId: 'flat',
        customPresets: [preset(0)],
      },
    });
  });
});
