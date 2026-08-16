import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { getWorkById } from '../services/work.service.js';
import { getConfig } from '../config/index.js';
import { existsSync, statSync, createReadStream } from 'fs';
import { join, extname } from 'path';

// 通配参数（路由形如 /stream/:id/*）：媒体相对路径可含子文件夹（"早期特典/mp3/x.mp3"）
const mediaParamsSchema = z.object({
  'id': z.string(),
  '*': z.string().min(1),
});

const mimeTypes: Record<string, string> = {
  '.mp3': 'audio/mpeg',
  '.ogg': 'audio/ogg',
  '.wav': 'audio/wav',
  '.flac': 'audio/flac',
  '.m4a': 'audio/mp4',
};

/**
 * 解析单段 Range 头（"bytes=start-end" / "bytes=start-" / "bytes=-suffix"）。
 *
 * html5 audio 拖动到未缓冲位置时浏览器发送 Range 请求并期待 206 分片，
 * 返回 undefined 表示无 Range 头（整文件 200），返回 null 表示范围非法（416）。
 */
function parseRange(
  rangeHeader: string | undefined,
  size: number,
): { start: number; end: number; } | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  if (!match) return undefined;

  const end = Math.min(
    match[2] === '' ? size - 1 : Number(match[2]),
    size - 1,
  );
  // 后缀分片（bytes=-N）：最后 N 字节
  const start = match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);

  if (start > end || start >= size) return null;
  return { start, end };
}

export const mediaRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get('/stream/:id/*', {
    schema: {
      params: mediaParamsSchema,
    },
  }, async (request, reply) => {
    const { id, '*': index } = request.params;
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

      const range = parseRange(request.headers.range, stat.size);
      if (range === null) {
        return reply
          .status(416)
          .header('Content-Range', `bytes */${stat.size}`)
          .send();
      }
      if (range) {
        return reply
          .status(206)
          .header('Content-Type', contentType)
          .header('Accept-Ranges', 'bytes')
          .header('Content-Range', `bytes ${range.start}-${range.end}/${stat.size}`)
          .header('Content-Length', range.end - range.start + 1)
          .send(createReadStream(filePath, range));
      }

      return reply
        .header('Content-Type', contentType)
        .header('Accept-Ranges', 'bytes')
        .header('Content-Length', stat.size)
        .send(createReadStream(filePath));
    }
    catch {
      return reply.status(404).send({ error: 'Work not found' });
    }
  });

  fastify.get('/download/:id/*', {
    schema: {
      params: mediaParamsSchema,
    },
  }, async (request, reply) => {
    const { id, '*': index } = request.params;
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

  fastify.get('/check-lrc/:id/*', {
    schema: {
      params: mediaParamsSchema,
      response: {
        200: z.object({
          id: z.string(),
          index: z.string(),
          hasLrc: z.boolean(),
        }),
        404: z.object({ error: z.string() }),
      },
    },
  }, async (request, reply) => {
    const { id, '*': index } = request.params;
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
