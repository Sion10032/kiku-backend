import { extname } from 'node:path';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import { openWorkMedia } from '../services/media.service.js';

// 通配参数（路由形如 /stream/:id/*）：媒体相对路径可含子文件夹（"早期特典/mp3/x.mp3"）
const mediaParamsSchema = z.object({
  id: z.string(),
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
): { start: number; end: number } | null | undefined {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader ?? '');
  if (!match) return undefined;

  const end = Math.min(match[2] === '' ? size - 1 : Number(match[2]), size - 1);
  // 后缀分片（bytes=-N）：最后 N 字节
  const start =
    match[1] === '' ? Math.max(0, size - Number(match[2])) : Number(match[1]);

  if (start > end || start >= size) return null;
  return { start, end };
}

export const mediaRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/stream/:id/*',
    {
      schema: {
        params: mediaParamsSchema,
      },
    },
    async (request, reply) => {
      const { id, '*': index } = request.params;

      try {
        const source = await openWorkMedia(id, index);
        if (!source || !(await source.has(index))) {
          return reply.status(404).send({ error: 'File not found' });
        }

        const size = await source.size(index);
        const ext = extname(index).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';

        const range = parseRange(request.headers.range, size);
        if (range === null) {
          return reply
            .status(416)
            .header('Content-Range', `bytes */${size}`)
            .send();
        }
        if (range) {
          const stream = await source.readRange(index, range.start, range.end);
          return reply
            .status(206)
            .header('Content-Type', contentType)
            .header('Accept-Ranges', 'bytes')
            .header(
              'Content-Range',
              `bytes ${range.start}-${range.end}/${size}`,
            )
            .header('Content-Length', range.end - range.start + 1)
            .send(stream);
        }

        const stream = await source.readRange(index, 0, size - 1);
        return reply
          .header('Content-Type', contentType)
          .header('Accept-Ranges', 'bytes')
          .header('Content-Length', size)
          .send(stream);
      } catch {
        return reply.status(404).send({ error: 'Work not found' });
      }
    },
  );

  fastify.get(
    '/download/:id/*',
    {
      schema: {
        params: mediaParamsSchema,
      },
    },
    async (request, reply) => {
      const { id, '*': index } = request.params;

      try {
        const source = await openWorkMedia(id, index);
        if (!source || !(await source.has(index))) {
          return reply.status(404).send({ error: 'File not found' });
        }

        const size = await source.size(index);
        const ext = extname(index).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const stream = await source.readRange(index, 0, size - 1);

        return reply
          .header('Content-Type', contentType)
          .header('Content-Length', size)
          .header('Content-Disposition', `attachment; filename="${index}"`)
          .send(stream);
      } catch {
        return reply.status(404).send({ error: 'Work not found' });
      }
    },
  );
};
