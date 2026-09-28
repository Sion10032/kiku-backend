# kiku-backend

[English](README.md) · **简体中文**

[kiku](https://github.com/Sion10032/kiku) 的后端：自托管 DLsite 音声作品媒体服务器的 API 服务。

本项目是 [kikoeru-express](https://github.com/kikoeru-project/kikoeru-express) 的重写版（Express + Knex → Bun + Fastify + Drizzle）。

## 技术栈

Bun + Fastify 5 + Drizzle ORM（bun:sqlite）+ Zod（`fastify-type-provider-zod`）、@fastify/jwt 认证、@fastify/sse 推送、cheerio 抓取 DLsite / HVDB、music-metadata 解析音频标签。

## 开发

需要 [Bun](https://bun.sh/)。默认监听 `:8888`。

```bash
bun install
bun run dev        # 开发（watch）
bun run start      # 源码运行（无 watch）
bun run build      # 打包到 dist/（Bun.build，依赖 external）
bun run start:prod # 运行打包产物（需 node_modules）
```

质量检查：

```bash
bun run test       # bun test
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run format     # biome check --write
```

数据库迁移（两个库分开生成）：

```bash
bun run db:generate      # main 库（业务表）
bun run db:blob:generate # blob 库（封面等二进制）
```

## 目录结构

```
src/
├── index.ts      # 入口
├── app.ts        # Fastify 实例构建（插件注册、路由挂载）
├── routes/       # HTTP 适配：路由、zod schema、鉴权 hook
├── services/     # 用例编排
├── scanner/      # 媒体库扫描
├── infra/        # 纯能力：db / fs / scraper / audio / config / i18n
├── auth/         # 认证工具
├── migration/    # 从 kikoeru 迁移旧数据
└── utils/        # 纯函数
```

依赖只准向下：`routes → services / scanner → infra`。

## 数据库与配置

- 两个 SQLite 库：`main`（业务表）与 `blob`（封面等二进制），schema 与迁移分目录、分开生成，进程启动时自动应用（幂等）。
- 运行时配置读 `data/config.json`（`CONFIG_PATH` 可覆盖），经 zod 校验；文件不存在时自动创建并写入随机 secret。

## 测试

- 模块逻辑单测放模块旁 `<name>.test.ts`；需要 `buildApp` / inject 的端点测试放 `test/`（共享 helper 用 `@test/` 别名）。

## i18n

面向用户的错误消息一律 `reply.fail(status, key, params?)`，key 登记 `src/infra/i18n/locales/{zh-CN,en}.json`（两份必须同步）；语言由 `Accept-Language` 协商。

## 静态资源

前端产物放仓库根 `public/`（已 gitignore）：存在 `public/index.html` 时才注册 `@fastify/static` 并做 SPA 深链回落。私有模式的全局鉴权只覆盖 `/api`。

## 版本号

与前端同一套：版本与 commit 由构建期注入（`APP_VERSION_BACKEND` / `GIT_COMMIT_BACKEND`），不读 `package.json`；未注入时显示 `dev-unknown`。Docker 构建见父仓库 `Dockerfile`。

## License

GPL-3.0-or-later，与原项目一致。保留原项目版权声明：Copyright (C) Watanuki-Kimihiro 及贡献者。
