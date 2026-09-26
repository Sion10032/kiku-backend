import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';
import {
  createRootFolder,
  deleteRootFolder,
  listRootFolders,
  updateRootFolder,
} from '../services/rootFolder.service.js';

const folderSchema = z.object({
  name: z.string(),
  // null = 迁移遗留的未配置路径，UI 需提示补配
  path: z.string().nullable(),
});

const folderInputSchema = z.object({
  name: z.string().min(1).max(200),
  path: z.string().min(1),
});

// 当前名字走 query（name 可能含 '/' 与日文，放 path 段会被路由拆断）
const currentNameQuery = z.object({ name: z.string().min(1) });

export const rootFolderRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/root-folders',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        response: { 200: z.object({ folders: z.array(folderSchema) }) },
      },
    },
    async () => ({ folders: await listRootFolders() }),
  );

  fastify.post(
    '/root-folders',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: { body: folderInputSchema, response: { 200: folderSchema } },
    },
    async (request, reply) => {
      const out = await createRootFolder(request.body);
      if (!out.ok) return reply.fail(409, 'errors.root-folder.name-taken');
      return out.folder;
    },
  );

  fastify.put(
    '/root-folders',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        querystring: currentNameQuery,
        body: folderInputSchema,
        response: { 200: folderSchema },
      },
    },
    async (request, reply) => {
      const out = await updateRootFolder(request.query.name, request.body);
      if (!out.ok) {
        return out.reason === 'not-found'
          ? reply.fail(404, 'errors.root-folder.not-found')
          : reply.fail(409, 'errors.root-folder.name-taken');
      }
      return out.folder;
    },
  );

  fastify.delete(
    '/root-folders',
    {
      preHandler: [fastify.authenticateAdmin],
      schema: {
        querystring: currentNameQuery,
        response: { 200: z.object({ success: z.boolean() }) },
      },
    },
    async (request, reply) => {
      const out = await deleteRootFolder(request.query.name);
      if (!out.ok) {
        if (out.reason === 'not-found')
          return reply.fail(404, 'errors.root-folder.not-found');
        return reply.fail(409, 'errors.root-folder.has-works', {
          count: out.workCount,
        });
      }
      return { success: true };
    },
  );
};
