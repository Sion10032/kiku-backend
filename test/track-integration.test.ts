import { afterAll, beforeAll, describe, expect, it } from 'bun:test';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { setupTestEnvironment } from './helpers/setup';

setupTestEnvironment();

const { buildApp } = await import('../src/app.js');
const { db } = await import('../src/infra/db/main/index.js');
const { circles, tracks, works } = await import(
  '../src/infra/db/main/schema.js'
);
const { eq } = await import('drizzle-orm');
const { setConfigForTesting, getConfig } = await import(
  '../src/infra/config/index.js'
);
const { openWorkSource } = await import('../src/infra/fs/source/index.js');
const { syncWorkTracks } = await import('../src/scanner/trackSync.js');
const { upsertWork } = await import('../src/services/work.service.js');
const { computeWorkLoudness, setTrackLoudness, upsertTrackRow } = await import(
  '../src/services/track.service.js'
);

const WORK = 'RJ00000004';
const ROOT_FOLDER = 'track-root';
const sine = readFileSync(join(import.meta.dir, 'fixtures/audio/sine.wav'));
// 非音频字节 → 探测失败 → durationSec=null（轨仍须出现在响应中）
const bad = Buffer.from('not an audio file');

let root: string;
let app: FastifyInstance;

interface TrackNodeJson {
  type: string;
  title: string;
  hash?: string;
  durationSec?: number | null;
}

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), 'kiku-tracks-'));
  mkdirSync(join(root, WORK), { recursive: true });
  writeFileSync(join(root, WORK, 'sine.wav'), sine);
  writeFileSync(join(root, WORK, 'bad.mp3'), bad);

  setConfigForTesting({
    ...getConfig(),
    instanceMode: 'public',
    rootFolders: [{ name: ROOT_FOLDER, path: root }],
  });
  app = await buildApp();
  await app.ready();

  // 播种：作品记录（upsertWork）→ 音轨行（syncWorkTracks）
  const seeded = await upsertWork({
    id: WORK,
    rootFolder: ROOT_FOLDER,
    dir: WORK,
    title: '时长集成测试作品',
    circleName: '时长测试社团',
  });
  expect(seeded.success).toBe(true);

  const source = await openWorkSource(root, WORK);
  const sync = await syncWorkTracks(WORK, source, await source.buildTree());
  expect(sync.added).toBe(2); // sine.wav + bad.mp3
});

afterAll(async () => {
  await db.delete(works).where(eq(works.id, WORK));
  const circle = await db.query.circles.findFirst({
    where: { RAW: (t, op) => op.eq(t.name, '时长测试社团') },
  });
  if (circle) await db.delete(circles).where(eq(circles.id, circle.id));
  await app.close();
  rmSync(root, { recursive: true, force: true });
  setConfigForTesting(); // 清缓存，恢复其他测试文件的配置隔离
});

async function getTracks(): Promise<TrackNodeJson[]> {
  const res = await app.inject({ method: 'GET', url: `/api/tracks/${WORK}` });
  expect(res.statusCode).toBe(200);
  return res.json() as TrackNodeJson[];
}

describe('GET /api/tracks/:id 附带 durationSec', () => {
  it('tracks 带 durationSec', async () => {
    const tracks = await getTracks();
    expect(JSON.stringify(tracks)).toContain('"durationSec"');

    const sineNode = tracks.find((n) => n.hash === 'sine.wav');
    expect(sineNode?.type).toBe('audio');
    expect(typeof sineNode?.durationSec).toBe('number');
    expect(sineNode?.durationSec).toBeCloseTo(0.8, 2);
  });

  it('解析失败轨 durationSec=null 也出现在响应中', async () => {
    const tracks = await getTracks();
    const badNode = tracks.find((n) => n.hash === 'bad.mp3');
    expect(badNode).not.toBeUndefined();
    expect(badNode?.type).toBe('audio');
    expect('durationSec' in (badNode ?? {})).toBe(true);
    expect(badNode?.durationSec).toBeNull();
  });
});

describe('响度 API 输出', () => {
  // works 端点可选鉴权（公开模式匿名亦放行）；带合法 token 走登录用户路径
  let auth: { authorization: string };

  /** 响度用例公共准备：sine.wav 写入响度（可选曲线）并重算作品响度。 */
  async function seedLoudness(tp: number, curve?: Array<number | null>) {
    await setTrackLoudness(WORK, 'sine.wav', {
      lufs: -20,
      truePeakDb: tp,
      curve,
    });
    await computeWorkLoudness(WORK);
  }

  beforeAll(() => {
    auth = {
      authorization: `Bearer ${app.jwt.sign({ name: 'loudness-tester', group: 'user' })}`,
    };
  });

  it('work 带 loudness（有分析数据即下发）', async () => {
    // 准备：rootFolder + RJ00000004 目录 + sine.wav → syncWorkTracks 填行 +
    // setTrackLoudness(-20, tp=-6) + computeWorkLoudness；gainDb 由前端按用户设置计算，服务端不下发
    await seedLoudness(-6);
    const work = (
      await app.inject({
        method: 'GET',
        url: '/api/work/RJ00000004',
        headers: auth,
      })
    ).json();
    expect(work.loudnessLufs).toBeCloseTo(-20, 5);
  });

  it('未分析作品 → loudness 均为 null', async () => {
    // 独立作品：有音轨行但从未分析 → 工作级两字段全 null
    const id = 'RJ00000005';
    await upsertWork({
      id,
      rootFolder: ROOT_FOLDER,
      dir: WORK,
      title: '未分析作品',
      circleName: '时长测试社团',
    });
    await upsertTrackRow({
      workId: id,
      mediaIndex: 'u.wav',
      title: 'u.wav',
      sizeBytes: 1,
      durationSec: 10,
    });
    try {
      const work = (
        await app.inject({
          method: 'GET',
          url: `/api/work/${id}`,
          headers: auth,
        })
      ).json();
      expect(work.loudnessLufs).toBeNull();
    } finally {
      await db.delete(tracks).where(eq(tracks.workId, id));
      await db.delete(works).where(eq(works.id, id));
    }
  });

  it('tracks 树 audio 节点带 loudnessLufs', async () => {
    // 同上准备（sine.wav 已 setTrackLoudness(-20)）；树里 audio 节点 hash 即 mediaIndex
    await seedLoudness(-6);
    const tree = (
      await app.inject({
        method: 'GET',
        url: '/api/tracks/RJ00000004',
        headers: auth,
      })
    ).json() as Array<Record<string, unknown>>;
    const flat: Array<{ hash: string; loudnessLufs?: number | null }> = [];
    const walk = (nodes: typeof tree): void =>
      nodes.forEach((n) => {
        if ('children' in n) {
          walk(n.children as typeof tree);
        } else if (n.type === 'audio') {
          flat.push(n as never);
        }
      });
    walk(tree);
    expect(flat.find((n) => n.hash === 'sine.wav')?.loudnessLufs).toBeCloseTo(
      -20,
      5,
    );
  });

  it('loudness-curve 端点返回按秒曲线', async () => {
    // 同上准备，setTrackLoudness 带 curve: [-70, null, -19.5]
    await seedLoudness(-1, [-70, null, -19.5]);
    const res = await app.inject({
      method: 'GET',
      url: '/api/work/RJ00000004/loudness-curve?mediaIndex=sine.wav',
      headers: auth,
    });
    // （代码库惯例：json() 返回 any 会命中 expect 的 undefined 重载，需显式泛型）
    expect(
      res.json<{
        mediaIndex: string;
        intervalSec: number;
        curve: Array<number | null>;
      }>(),
    ).toEqual({
      mediaIndex: 'sine.wav',
      intervalSec: 1,
      curve: [-70, null, -19.5],
    });
  });

  it('loudness-curve 未分析轨 → curve null（200）', async () => {
    // bad.mp3 从未 setTrackLoudness
    const res = await app.inject({
      method: 'GET',
      url: '/api/work/RJ00000004/loudness-curve?mediaIndex=bad.mp3',
      headers: auth,
    });
    expect(res.statusCode).toBe(200);
    expect(res.json().curve).toBeNull();
  });

  it('loudness-curve 未知 mediaIndex → 404', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/work/RJ00000004/loudness-curve?mediaIndex=nope.wav',
      headers: auth,
    });
    expect(res.statusCode).toBe(404);
  });
});
