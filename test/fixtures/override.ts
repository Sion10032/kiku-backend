import { eq, inArray } from 'drizzle-orm';
import { db } from '../../src/infra/db/main/index.js';
import {
  circles,
  series,
  tags,
  vas,
  works,
} from '../../src/infra/db/main/schema.js';
import { upsertWork } from '../../src/services/work.service.js';
import { ensureRootFolder, removeRootFolder } from '../helpers/rootFolder.js';

/** 同进程所有测试共享一个临时库，fixture 文本一律带随机 base 后缀隔离。 */
const base = 1000000 + Math.floor(Math.random() * 2000000);

export const OVR = {
  base,
  circleA: `社团A_${base}`,
  circleB: `社团B_${base}`,
  tagX: `标签X_${base}`,
  tagY: `标签Y_${base}`,
  va1: `va_ovr_${base}`,
  va1Name: `声优甲_${base}`,
  seriesX: `SRIOVR${base}`,
  seriesXName: `系列X_${base}`,
  w1: `RJ${base}1`, // circleA + tagX + tagY + va1 + seriesX，标题「标题甲」
  w2: `RJ${base}2`, // circleA + tagX + seriesX，标题「标题乙」
  w3: `RJ${base}3`, // circleB + tagY，无系列，标题「标题丙」
} as const;

export async function insertOverrideFixtures(): Promise<void> {
  const rows = [
    {
      id: OVR.w1,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w1}`,
      title: `标题甲_${base}`,
      circleName: OVR.circleA,
      ageRating: 'all' as const,
      release: '2024-01-01',
      tags: [OVR.tagX, OVR.tagY],
      vas: [{ id: OVR.va1, name: OVR.va1Name }],
      series: { id: OVR.seriesX, name: OVR.seriesXName },
    },
    {
      id: OVR.w2,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w2}`,
      title: `标题乙_${base}`,
      circleName: OVR.circleA,
      ageRating: 'r18' as const,
      release: '2024-01-02',
      tags: [OVR.tagX],
      vas: [],
      series: { id: OVR.seriesX, name: OVR.seriesXName },
    },
    {
      id: OVR.w3,
      rootFolder: 'testroot',
      dir: `ovr/${OVR.w3}`,
      title: `标题丙_${base}`,
      circleName: OVR.circleB,
      ageRating: 'all' as const,
      release: '2024-01-03',
      tags: [OVR.tagY],
      vas: [],
    },
  ];
  // FK 前置：works.root_folder → t_root_folder.name
  await ensureRootFolder('testroot');
  for (const row of rows) {
    const res = await upsertWork(row);
    if (!res.success) throw new Error(res.error);
  }
}

export async function cleanupOverrideFixtures(): Promise<void> {
  // works 级联删除关系行与覆盖行（FK ON DELETE CASCADE）
  await db
    .delete(works)
    .where(inArray(works.id, [OVR.w1, OVR.w2, OVR.w3]))
    .catch(() => {});
  await db
    .delete(tags)
    .where(eq(tags.name, OVR.tagX))
    .catch(() => {});
  await db
    .delete(tags)
    .where(eq(tags.name, OVR.tagY))
    .catch(() => {});
  await db
    .delete(vas)
    .where(eq(vas.id, OVR.va1))
    .catch(() => {});
  await db
    .delete(circles)
    .where(eq(circles.name, OVR.circleA))
    .catch(() => {});
  await db
    .delete(circles)
    .where(eq(circles.name, OVR.circleB))
    .catch(() => {});
  await db
    .delete(series)
    .where(eq(series.id, OVR.seriesX))
    .catch(() => {});
  await removeRootFolder('testroot');
}
