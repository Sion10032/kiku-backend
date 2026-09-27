import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

/**
 * 版本信息：进程内解析一次并缓存。
 *
 * 两个字段都只在**构建期**由 `build.ts` 的 define 注入（与前端 vite define 同一套
 * 做法），既不跑 git 解析，也不读运行期环境变量：
 * - version：`__APP_VERSION__`（构建期取自 APP_VERSION_BACKEND，通常传发布 tag）→ `'dev'`
 * - commit：`__APP_COMMIT__`（构建期取自 GIT_COMMIT_BACKEND）→ `'unknown'`
 *
 * 不跑 git 解析的原因：构建上下文里没有 `.git`（`.dockerignore` 排除，且子模块的
 * `.git` 只是指向父仓库 `.git/modules/...` 的指针文件），运行镜像里也没有 git 二进制。
 *
 * `bun run dev` / `bun test` 不经过打包，这两个标识符在运行时不存在，所以只能用
 * `typeof` 守卫读取（裸标识符的 `typeof` 不会抛 ReferenceError），落在兜底值上：
 * `dev-unknown`。打包产物里则是 `1.0.0-<短 hash>`。
 */
declare const __APP_VERSION__: string | undefined;
declare const __APP_COMMIT__: string | undefined;

function resolveVersion(): string {
  const injected =
    typeof __APP_VERSION__ === 'string' ? __APP_VERSION__.trim() : '';
  return injected || 'dev';
}

function resolveCommit(): string {
  const injected =
    typeof __APP_COMMIT__ === 'string' ? __APP_COMMIT__.trim() : '';
  return injected || 'unknown';
}

let versionInfo: { current: string; commit: string } | null = null;

function getVersionInfo(): { current: string; commit: string } {
  versionInfo ??= { current: resolveVersion(), commit: resolveCommit() };
  return versionInfo;
}

export const versionRoutes: FastifyPluginAsyncZod = async (fastify) => {
  fastify.get(
    '/version',
    {
      schema: {
        response: {
          200: z.object({
            current: z.string(),
            commit: z.string(),
            latest: z.string().nullable(),
            updateAvailable: z.boolean(),
          }),
        },
      },
    },
    async () => {
      const { current, commit } = getVersionInfo();
      const latestVersion: string | null = null;

      return {
        current,
        commit,
        latest: latestVersion,
        updateAvailable: latestVersion !== null && latestVersion !== current,
      };
    },
  );
};
