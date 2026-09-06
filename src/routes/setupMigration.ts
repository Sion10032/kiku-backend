import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getConfig } from '../infra/config/index.js';
import {
  detectKikoeruData,
  getOldDataDir,
  migrateFromKikoeru,
} from '../migration/kikoeru.js';

const statsSchema = z.object({
  works: z.number(),
  users: z.number(),
  reviews: z.number(),
  playHistory: z.number(),
  covers: z.number(),
});

const migrationStatsSchema = z.object({
  circles: z.number(),
  works: z.number(),
  worksSkipped: z.number(),
  tags: z.number(),
  vas: z.number(),
  tagWork: z.number(),
  vaWork: z.number(),
  users: z.number(),
  usersSkipped: z.number(),
  reviews: z.number(),
  reviewsSkipped: z.number(),
  readStates: z.number(),
  readStatesSkipped: z.number(),
  coversImported: z.number(),
});

/** Setup 向导迁移步骤：status 探测 + run 执行（均白名单免鉴权，仅空库有意义） */
export const setupMigrationRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/status',
    {
      schema: {
        response: {
          200: z.object({
            available: z.boolean(),
            migrated: z.boolean(),
            flavor: z.enum(['number178-fork', 'vanilla']).optional(),
            stats: statsSchema.optional(),
          }),
        },
      },
    },
    async () => {
      const detection = detectKikoeruData(getOldDataDir());
      return {
        available: detection !== null,
        migrated: Boolean(getConfig().kikoeruMigratedAt),
        ...(detection
          ? { flavor: detection.flavor, stats: detection.stats }
          : {}),
      };
    },
  );

  fastify.post(
    '/run',
    {
      schema: {
        response: {
          200: z.object({ stats: migrationStatsSchema }),
          409: z.object({ error: z.string() }),
        },
      },
    },
    async (_request, reply) => {
      const result = migrateFromKikoeru(getOldDataDir());
      if (!result.ok || !result.stats) {
        return reply.status(409).send({ error: result.error ?? '迁移失败' });
      }
      return { stats: result.stats };
    },
  );
};
