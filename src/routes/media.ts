import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getWorkById } from '../services/work.service.js';
import { getConfig } from '../config/index.js';
import { existsSync, statSync, createReadStream } from 'fs';
import { join, extname } from 'path';

const mediaParamsSchema = z.object({
  id: z.coerce.number().int().positive(),
  index: z.string().min(1),
});

const mimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

export const mediaRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get('/stream/:id/:index', {
    schema: {
      params: mediaParamsSchema,
    },
  }, async (request, reply) => {
    const { id, index } = request.params;
    const config = getConfig();

    try {
      const work = await getWorkById(id);
      const rootFolder = config.rootFolders.find(f => f.name === work.rootFolder);

      if (!rootFolder) {
        return reply.status(404).send({ error: 'Root folder not found' });
      }

      const filePath = join(rootFolder.path, work.dir, index);
      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const stat = statSync(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      return reply
        .header('Content-Type', contentType)
        .header('Content-Length', stat.size)
        .send(createReadStream(filePath));
    }
    catch {
      return reply.status(404).send({ error: 'Work not found' });
    }
  });

  fastify.get('/download/:id/:index', {
    schema: {
      params: mediaParamsSchema,
    },
  }, async (request, reply) => {
    const { id, index } = request.params;
    const config = getConfig();

    try {
      const work = await getWorkById(id);
      const rootFolder = config.rootFolders.find(f => f.name === work.rootFolder);

      if (!rootFolder) {
        return reply.status(404).send({ error: 'Root folder not found' });
      }

      const filePath = join(rootFolder.path, work.dir, index);
      if (!existsSync(filePath)) {
        return reply.status(404).send({ error: 'File not found' });
      }

      const stat = statSync(filePath);
      const ext = extname(filePath).toLowerCase();
      const contentType = mimeTypes[ext] || 'application/octet-stream';

      return reply
        .header('Content-Type', contentType)
        .header('Content-Length', stat.size)
        .header('Content-Disposition', `attachment; filename="${index}"`)
        .send(createReadStream(filePath));
    }
    catch {
      return reply.status(404).send({ error: 'Work not found' });
    }
  });

  fastify.get('/check-lrc/:id/:index', {
    schema: {
      params: mediaParamsSchema,
      response: {
        200: z.object({
          id: z.number(),
          index: z.string(),
          hasLrc: z.boolean(),
        }),
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id, index } = request.params;
    const config = getConfig();

    try {
      const work = await getWorkById(id);
      const rootFolder = config.rootFolders.find(f => f.name === work.rootFolder);

      if (!rootFolder) {
        return reply.status(404).send({ error: 'Root folder not found' });
      }

      const lrcFile = `${index}.lrc`;
      const filePath = join(rootFolder.path, work.dir, lrcFile);
      const hasLrc = existsSync(filePath);

      return { id, index, hasLrc };
    }
    catch {
      return reply.status(404).send({ error: 'Work not found' });
    }
  });
};
