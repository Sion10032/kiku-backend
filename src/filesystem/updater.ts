import { eq } from 'drizzle-orm';
import type { Config } from '../config/schema.js';
import { db } from '../db/main/index.js';
import type { AgeRating } from '../db/main/schema.js';
import {
  circles,
  series,
  tags,
  tagWork,
  vas,
  vaWork,
  works,
} from '../db/main/schema.js';

export interface UpdateResult {
  workId: string;
  title: string;
  success: boolean;
  error?: string;
}

export async function updateWorkMetadata(
  workId: string,
  metadata: {
    title?: string;
    circleName?: string;
    tags?: string[];
    vas?: Array<{ id: string; name: string }>;
    series?: { id: string; name: string } | null;
    /** 年龄分级（缺省不修改） */
    ageRating?: AgeRating;
    release?: string;
    dlCount?: number;
    price?: number;
    reviewCount?: number;
    rateCount?: number;
    rateAverage2dp?: number;
    rateCountDetail?: Record<string, number>;
    rank?: Record<string, number>;
  },
): Promise<UpdateResult> {
  try {
    const work = await db.query.works.findFirst({
      where: { RAW: (t, op) => op.eq(t.id, workId) },
    });

    if (!work) {
      return { workId, title: '', success: false, error: 'Work not found' };
    }

    // Update circle if provided
    if (metadata.circleName) {
      const circleName = metadata.circleName;
      let circle = await db.query.circles.findFirst({
        where: { RAW: (t, op) => op.eq(t.name, circleName) },
      });

      if (!circle) {
        const result = await db
          .insert(circles)
          .values({ name: metadata.circleName })
          .returning();
        circle = result[0];
      }

      if (circle) {
        await db
          .update(works)
          .set({ circleId: circle.id })
          .where(eq(works.id, workId));
      }
    }

    // Update work fields
    const updateData: Record<string, unknown> = {};
    if (metadata.title) updateData.title = metadata.title;
    if (metadata.ageRating !== undefined)
      updateData.ageRating = metadata.ageRating;
    if (metadata.release) updateData.release = metadata.release;
    if (metadata.dlCount !== undefined) updateData.dlCount = metadata.dlCount;
    if (metadata.price !== undefined) updateData.price = metadata.price;
    if (metadata.reviewCount !== undefined)
      updateData.reviewCount = metadata.reviewCount;
    if (metadata.rateCount !== undefined)
      updateData.rateCount = metadata.rateCount;
    if (metadata.rateAverage2dp !== undefined)
      updateData.rateAverage2dp = metadata.rateAverage2dp;
    if (metadata.rateCountDetail)
      updateData.rateCountDetail = JSON.stringify(metadata.rateCountDetail);
    if (metadata.rank) updateData.rank = JSON.stringify(metadata.rank);

    if (Object.keys(updateData).length > 0) {
      await db
        .update(works)
        .set(updateData)
        .where(eq(works.id, workId as string));
    }

    // Update tags if provided
    if (metadata.tags) {
      // Remove existing tag associations
      await db.delete(tagWork).where(eq(tagWork.workId, workId as string));

      // Add new tags
      for (const tagName of metadata.tags) {
        let tag = await db.query.tags.findFirst({
          where: { RAW: (t, op) => op.eq(t.name, tagName) },
        });

        if (!tag) {
          const result = await db
            .insert(tags)
            .values({ name: tagName })
            .returning();
          tag = result[0];
        }

        if (tag) {
          await db.insert(tagWork).values({
            tagId: tag.id,
            workId,
          });
        }
      }
    }

    // Update VAs if provided
    if (metadata.vas) {
      // Remove existing VA associations
      await db.delete(vaWork).where(eq(vaWork.workId, workId as string));

      // Add new VAs
      for (const va of metadata.vas) {
        let existingVa = await db.query.vas.findFirst({
          where: { RAW: (t, op) => op.eq(t.id, va.id) },
        });

        if (!existingVa) {
          const result = await db
            .insert(vas)
            .values({ id: va.id, name: va.name })
            .returning();
          existingVa = result[0];
        }

        if (existingVa) {
          await db.insert(vaWork).values({
            vaId: existingVa.id,
            workId,
          });
        }
      }
    }

    // Update series only when a non-null value is passed:
    // 不传或传 null 时保持既有 seriesId 不变（旧元数据源无系列信息，不得清空）。
    // 系列行按 id upsert，已存在则沿用库内名字，不合并不改名。
    if (metadata.series) {
      const s = metadata.series;
      let existingSeries = await db.query.series.findFirst({
        where: { RAW: (t, op) => op.eq(t.id, s.id) },
      });

      if (!existingSeries) {
        const result = await db
          .insert(series)
          .values({ id: s.id, name: s.name })
          .returning();
        existingSeries = result[0];
      }

      if (existingSeries) {
        await db
          .update(works)
          .set({ seriesId: existingSeries.id })
          .where(eq(works.id, workId as string));
      }
    }

    return { workId, title: metadata.title || work.title, success: true };
  } catch (err) {
    return { workId, title: '', success: false, error: String(err) };
  }
}

export async function updateAllWorksMetadata(
  _config: Config,
): Promise<UpdateResult[]> {
  const results: UpdateResult[] = [];
  const allWorks = await db.query.works.findMany();

  for (const work of allWorks) {
    // TODO: Implement actual metadata fetching from DLsite/HVDB
    // For now, just return success without actual updates
    results.push({
      workId: work.id,
      title: work.title,
      success: true,
    });
  }

  return results;
}
