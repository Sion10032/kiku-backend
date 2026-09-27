import { cpSync, existsSync, rmSync } from 'node:fs';
import { build } from 'bun';
import pkg from './package.json';

const outDir = './dist';

/** 版本号：构建期由 build arg / CI（发布 tag）传入，不读 package.json（不传兜底 'dev'） */
const APP_VERSION = process.env.APP_VERSION_BACKEND?.trim() || 'dev';

/** commit：构建期由 build arg / CI 传入（不传兜底 'unknown'） */
const APP_COMMIT = process.env.GIT_COMMIT_BACKEND?.trim() || 'unknown';

/**
 * 迁移目录拷贝清单：打包后代码内联进 `dist/index.js`，
 * 迁移目录按 `src/infra/db/migrations.ts` 的布局约定落到 `dist/migrations/<db>`。
 */
const MIGRATIONS = [
  { from: './src/infra/db/main/migrations', to: './dist/migrations/main' },
  { from: './src/infra/db/blob/migrations', to: './dist/migrations/blob' },
];

if (existsSync(outDir)) {
  rmSync(outDir, { recursive: true, force: true });
}

const result = await build({
  entrypoints: ['./src/index.ts'],
  outdir: outDir,
  target: 'bun',
  format: 'esm',
  sourcemap: 'none',
  // 版本显示的版本号与 commit：构建期注入（Dockerfile build arg / CI），与前端同一套做法。
  // dev / test 不走打包，标识符不存在，由 version.ts 的 typeof 守卫兜底 'dev' / 'unknown'。
  define: {
    __APP_VERSION__: JSON.stringify(APP_VERSION),
    __APP_COMMIT__: JSON.stringify(APP_COMMIT),
  },
  // 依赖不打进 bundle：运行时读 node_modules（部署后仍需 bun install --production）
  external: Object.keys(pkg.dependencies),
});

if (!result.success) {
  console.error('❌ build 失败');
  for (const log of result.logs) {
    console.error(log);
  }
  process.exit(1);
}

for (const { from, to } of MIGRATIONS) {
  cpSync(from, to, { recursive: true });
  console.log(`✓ ${from} → ${to}`);
}

console.log(`✅ build 完成：${outDir}/index.js`);
