# kiku-backend 开发约定

Bun + Fastify + Drizzle ORM + Zod + Biome。

## 命令

```bash
bun run dev            # 开发（watch）
bun run start          # 源码运行（无 watch）
bun run build          # 打包到 dist/（Bun.build：依赖 external + 拷贝迁移目录）
bun run start:prod     # 运行打包产物（需 node_modules 已安装）
bun run test           # bun test
bun run typecheck      # tsc --noEmit
bun run lint           # biome check
bun run format         # biome check --write
bun run db:generate    # main 库迁移生成（drizzle.config.ts）
bun run db:migrate     # main 库迁移应用
bun run db:blob:generate / db:blob:migrate   # blob 库（drizzle.blob.config.ts）
```

## 分层（依赖只准向下或同层）

| 目录 | 角色 | 可依赖 | 禁止依赖 |
|---|---|---|---|
| `src/routes/` | HTTP 适配：路由、zod schema、鉴权 hook、错误映射 | services、scanner、auth | — |
| `src/services/` | 用例编排（新代码默认落点） | infra、auth、其他 service（谨慎） | routes |
| `src/scanner/` | 扫描业务进程 | services、infra | routes |
| `src/infra/` | 纯能力：db / fs / scraper / audio / config | 同层（db→config、scraper→fs 合法） | routes、services、scanner、auth |
| `src/auth/` | 认证工具（utils/init） | infra | routes、services |
| `src/migration/` | 从 kikoeru 迁移数据（job + kikoeru） | infra | routes、services、scanner |
| `src/utils/` | 纯函数工具（如 rjcode） | 无 | 其他所有层 |

新代码决策树：是 HTTP 关注点 → routes；是扫描流程 → scanner；
是纯能力（不认识业务）→ infra；是纯函数 → utils；其他 → services。

判断口诀：「换一个 HTTP 框架它还有用吗？」有用 → service；没用 → route。

## 数据库与配置

- 两个 SQLite 库，schema 与 migrations 分目录，**迁移分开生成**：
  - `main`（业务表）：`src/infra/db/main/`，配置 `drizzle.config.ts` → `bun run db:*`
  - `blob`（封面等二进制，按 namespace + key 定位）：`src/infra/db/blob/`，配置 `drizzle.blob.config.ts` → `bun run db:blob:*`
- 改完 schema 必须在对应库跑 `db:generate` 并提交生成的迁移目录。
- **迁移在进程启动时自动应用**（`src/infra/db/{main,blob}/index.ts` 里 `migrate()`，靠 `__drizzle_migrations` 幂等），
  所以 `db:migrate` 只用于手动/调试，正常开发改完 schema 生成迁移即可。
- **表重建类迁移不要用 `db:migrate`**：drizzle-kit CLI 用 better-sqlite3 且开启了 foreign_keys，
  会在 `DROP TABLE t_circle` 处报 `FOREIGN KEY constraint failed` 并整体回滚（不丢数据），
  这类迁移只认运行时迁移器。另外，`db:generate` 出的表重建迁移必须手工在 `DROP TABLE` 前加上
  `DROP VIEW v_work; DROP VIEW v_tag_work; DROP VIEW v_va_work;`，并在重建完成后把三者原样重建——
  SQLite ≥3.25 的 `ALTER TABLE ... RENAME` 会重新解析整个 schema，`DROP TABLE` 留下的悬空视图会让它直接报错。
- 运行时配置读 `data/config.json`（可用 `CONFIG_PATH` 覆盖），经 `src/infra/config/schema.ts` 的 zod 校验；
  文件不存在时自动创建并写入随机 secret（首次启动）。读配置一律走 `getConfig()`。

## 测试

- 测单个模块的逻辑（不起 HTTP）→ 放模块旁 `<name>.test.ts`（与被测文件同名、平铺同目录）
- 测端点行为（需要 `buildApp`/inject）→ `test/`
- 共享 helpers/fixtures → `test/helpers`、`test/fixtures`，用 `@test/` 别名引用（tsconfig paths）
- 需要库隔离的测试：文件顶部调用 `setupTestEnvironment()`（先于 db 首查）

## 风格

- src 下 import 带 `.js` 后缀（verbatimModuleSyntax）；测试文件不带（现状惯例）
- Biome：单引号、2 空格、分号；`bun run lint` / `bun run format`

## 打包与静态资源

- `bun run build` 用 `Bun.build`（`build.ts`）把 `src/index.ts` 打成 `dist/index.js`，依赖全部 external，
  所以运行产物仍需 `node_modules`；两个库的 migrations 目录被拷到 `dist/migrations/{main,blob}`。
- 迁移目录定位统一走 `src/infra/db/migrations.ts` 的 `resolveMigrationsFolder()`，同时兼容
  源码态（`src/infra/db/<db>/migrations`）与打包态（`dist/migrations/<db>`）；新增库时
  `build.ts` 的 `MIGRATIONS` 清单与 `MigrationTarget` 一起加。
- 前端产物放仓库根 `public/`（cwd 相对，与 `CONFIG_PATH` 同约定，已 gitignore）：`public/index.html`
  存在时 `buildApp()` 才注册 `@fastify/static` 并做 SPA 深链回落，否则跳过（开发态前端走 Vite）。
- 私有模式的全局鉴权只覆盖 `/api`；非 `/api` 路径是前端静态产物与 SPA 入口，匿名可访问。

## i18n

- 面向用户的错误消息一律 `reply.fail(status, key, params?)`，key 登记 `src/infra/i18n/locales/{zh-CN,en}.json`（两份同步）
- 语言由 Accept-Language 协商（`request.language`）；zod 校验消息随请求语言自动本地化
- service/scanner 内部日志文案不进字典
