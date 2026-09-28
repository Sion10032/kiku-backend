# kiku-backend

**English** · [简体中文](README.zh-CN.md)

The backend for [kiku](https://github.com/Sion10032/kiku), a self-hosted media server for DLsite voice works.

A rewrite of [kikoeru-express](https://github.com/kikoeru-project/kikoeru-express) (Express + Knex → Bun + Fastify + Drizzle).

## Tech stack

Bun + Fastify 5 + Drizzle ORM (bun:sqlite) + Zod (`fastify-type-provider-zod`), `@fastify/jwt` for auth, `@fastify/sse` for push, cheerio for scraping DLsite / HVDB, music-metadata for audio tags.

## Development

Requires [Bun](https://bun.sh/). Listens on `:8888` by default.

```bash
bun install
bun run dev        # dev with watch
bun run start      # run from source (no watch)
bun run build      # bundle to dist/ (Bun.build, dependencies external)
bun run start:prod # run the bundled output (needs node_modules)
```

Checks:

```bash
bun run test       # bun test
bun run typecheck  # tsc --noEmit
bun run lint       # biome check
bun run format     # biome check --write
```

Migrations (generated separately for the two databases):

```bash
bun run db:generate      # main database (business tables)
bun run db:blob:generate # blob database (covers and other binary data)
```

## Project layout

```
src/
├── index.ts      # entry point
├── app.ts        # Fastify instance setup (plugins, route mounting)
├── routes/       # HTTP layer: routes, zod schemas, auth hooks
├── services/     # use-case orchestration
├── scanner/      # media library scanning
├── infra/        # pure capabilities: db / fs / scraper / audio / config / i18n
├── auth/         # auth helpers
├── migration/    # migration of legacy kikoeru data
└── utils/        # pure functions
```

Dependencies only point downwards: `routes → services / scanner → infra`.

## Database and config

- Two SQLite databases: `main` (business tables) and `blob` (covers and other binary data). Schemas and migrations live in separate directories and are generated separately; migrations are applied automatically on startup (idempotent).
- Runtime config is read from `data/config.json` (override with `CONFIG_PATH`) and validated with zod. If the file is missing it is created on first start with a random secret.

## Tests

- Unit tests for module logic sit next to the module as `<name>.test.ts`; endpoint tests that need `buildApp` / inject live in `test/` (shared helpers via the `@test/` alias).

## i18n

User-facing error messages always go through `reply.fail(status, key, params?)`; keys are registered in `src/infra/i18n/locales/{zh-CN,en}.json` and the two files must stay in sync. The language is negotiated from `Accept-Language`.

## Static assets

Frontend build output goes to `public/` at the repository root (gitignored): `@fastify/static` plus the SPA deep-link fallback are only registered when `public/index.html` exists. In private mode, global auth covers `/api` only.

## Version

Same scheme as the frontend: version and commit are injected at build time (`APP_VERSION_BACKEND` / `GIT_COMMIT_BACKEND`); `package.json` is not read. Without injection they show `dev-unknown`. See the `Dockerfile` in the parent repository for the Docker build.

## License

GPL-3.0-or-later, same as the original project. Original copyright notice retained: Copyright (C) Watanuki-Kimihiro and contributors.
