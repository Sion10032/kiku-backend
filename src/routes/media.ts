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
  '.wv': 'audio/wavpack',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mkv': 'video/x-matroska',
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

/**
 * 构造 Content-Disposition（RFC 6266）。
 *
 * 文件名可能含日文等非 ASCII 字符，直接写进 `filename="..."` 会让 Node 抛
 * ERR_INVALID_CHAR（对客户端表现为 500），所以两个参数都使用百分号编码。
 * `filename*` 是标准写法（RFC 5987）；`filename=` 的百分号编码属于浏览器
 * de-facto 行为（Chrome/Firefox 会按 UTF-8 解码），用于不认 `filename*` 的旧客户端。
 */
function contentDisposition(index: string): string {
  const filename = index.split('/').pop() || 'download';
  // attr-char 之外的字符（含 filename* 分隔符 '）需要百分号编码
  const encoded = encodeURIComponent(filename).replace(
    /['()*]/g,
    (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return `attachment; filename="${encoded}"; filename*=UTF-8''${encoded}`;
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
          return reply.fail(404, 'errors.media.file-not-found');
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
        return reply.fail(404, 'errors.media.work-not-found');
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
          return reply.fail(404, 'errors.media.file-not-found');
        }

        const size = await source.size(index);
        const ext = extname(index).toLowerCase();
        const contentType = mimeTypes[ext] || 'application/octet-stream';
        const stream = await source.readRange(index, 0, size - 1);

        return reply
          .header('Content-Type', contentType)
          .header('Content-Length', size)
          .header('Content-Disposition', contentDisposition(index))
          .send(stream);
      } catch {
        return reply.fail(404, 'errors.media.work-not-found');
      }
    },
  );
};
