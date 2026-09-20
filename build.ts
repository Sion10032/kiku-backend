import { cpSync, existsSync, rmSync } from 'node:fs';
import { build } from 'bun';
import pkg from './package.json';

const outDir = './dist';

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
