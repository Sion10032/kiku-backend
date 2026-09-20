# kiku-backend 开发约定

Bun + Fastify + Drizzle ORM + Zod + Biome。

## 命令

```bash
bun run dev            # 开发（watch）
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

## i18n

- 面向用户的错误消息一律 `reply.fail(status, key, params?)`，key 登记 `src/infra/i18n/locales/{zh-CN,en}.json`（两份同步）
- 语言由 Accept-Language 协商（`request.language`）；zod 校验消息随请求语言自动本地化
- service/scanner 内部日志文案不进字典
