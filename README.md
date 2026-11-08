# InkRoom

InkRoom is a collaborative whiteboard application. This repository currently contains the
engineering foundation only: a pnpm monorepo with a React web client, a Fastify API, a shared
contract package, PostgreSQL via Docker Compose, and the CI, lint, format, type-check and test
setup. Whiteboard features (canvas, shapes, real-time sync, boards) are not implemented yet.

## Repository layout

```
.
├── apps/
│   ├── api/                 Fastify API (Node.js 22, TypeScript, Drizzle ORM, PostgreSQL)
│   │   ├── src/app.ts       Fastify app factory and routes (GET /api/health)
│   │   ├── src/config.ts    Environment parsing and validation (zod)
│   │   ├── src/db/          Database client and Drizzle schema
│   │   └── src/server.ts    Process entry point: listen, graceful shutdown
│   └── web/                 React + Vite client (TypeScript)
│       ├── src/App.tsx      Root component; reads API health through the shared schema
│       └── vite.config.ts   Dev server (port 21173) and /api proxy to the API
├── packages/
│   └── shared/              Types and runtime validation shared by API and web
├── .github/workflows/ci.yml CI: install, lint, format check, typecheck, test, build
├── docker-compose.yml       Local PostgreSQL 16
├── .env.example             Environment variable template
├── eslint.config.mjs        ESLint flat config (TypeScript, React hooks)
├── tsconfig.base.json       Shared strict TypeScript settings
└── AGENTS.md                Instructions for coding agents working in this repository
```

## Prerequisites

- Node.js 22.9 or newer (`.nvmrc` pins 22 for CI and `nvm use`).
- pnpm 9. The version is pinned in the `packageManager` field; with Corepack enabled run
  `corepack enable`, or install pnpm 9 yourself.
- Docker with Compose v2, for the local PostgreSQL database.

## Quick start

```sh
cp .env.example .env
pnpm install
pnpm db:up          # starts PostgreSQL on 127.0.0.1:21432 and waits until it is healthy
pnpm dev            # API on http://127.0.0.1:21080, web on http://127.0.0.1:21173
```

Open <http://127.0.0.1:21173>. The page shows the API health status. The API keeps running if the
database is down, but `GET /api/health` then returns `503` with `"status": "degraded"`.

Stop the database with `pnpm db:down`. Data is kept in the `postgres-data` Docker volume; remove it
with `docker compose down -v` when you want a fresh database.

## Configuration

Copy `.env.example` to `.env`. The file is git-ignored.

| Variable            | Default                                              | Used by                 |
| ------------------- | ---------------------------------------------------- | ----------------------- |
| `API_HOST`          | `127.0.0.1`                                          | API listen address      |
| `API_PORT`          | `21080`                                              | API listen port         |
| `DATABASE_URL`      | `postgres://inkroom:inkroom@127.0.0.1:21432/inkroom` | API, Drizzle            |
| `POSTGRES_USER`     | `inkroom`                                            | Docker Compose database |
| `POSTGRES_PASSWORD` | `inkroom`                                            | Docker Compose database |
| `POSTGRES_DB`       | `inkroom`                                            | Docker Compose database |
| `POSTGRES_PORT`     | `21432`                                              | Docker Compose port     |
| `WEB_ORIGIN`        | `http://127.0.0.1:21173`                             | API origin check (CSRF) |
| `COOKIE_SECURE`     | `true` in production, `false` otherwise              | Session cookie `Secure` |

The API validates its environment at startup and exits with a clear error when `DATABASE_URL` is
missing or a port is out of range. The web dev server proxies `/api` to `http://127.0.0.1:21080`;
if you change `API_PORT`, update `apps/web/vite.config.ts` too.

Local defaults use loopback ports in the 21000–21099 range. The development credentials are for
local use only and must not be reused elsewhere.

## Scripts

Run from the repository root.

| Command               | Description                                                      |
| --------------------- | ---------------------------------------------------------------- |
| `pnpm dev`            | Run the API (watch mode) and the web dev server in parallel      |
| `pnpm build`          | Build all packages (API bundle to `apps/api/dist`, web to `dist`) |
| `pnpm start`          | Run the built API (`node apps/api/dist/server.js`)               |
| `pnpm lint`           | ESLint over the whole repository                                 |
| `pnpm format`         | Prettier write                                                   |
| `pnpm format:check`   | Prettier check (used in CI)                                      |
| `pnpm typecheck`      | `tsc --noEmit` in every package (strict mode)                    |
| `pnpm test`           | Vitest in every package                                          |
| `pnpm check`          | lint + format check + typecheck + test                           |
| `pnpm db:up`          | Start PostgreSQL with Docker Compose and wait for health         |
| `pnpm db:down`        | Stop the Compose services                                        |
| `pnpm db:generate`    | Generate Drizzle migrations from `apps/api/src/db/schema.ts`     |
| `pnpm db:migrate`     | Apply pending database migrations                                |
| `pnpm db:seed`        | Insert demo users, a board and an update (skipped if present)    |

## Architecture

- **Shared contract (`packages/shared`)**: the health response schema and its inferred type. The API
  builds responses with these types, and the web client parses responses with the same schema. The
  package is consumed as TypeScript source, so there is no separate build step.
- **API (`apps/api`)**: `buildApp` creates a Fastify instance that receives its database dependency
  as a parameter, which keeps routes testable with `app.inject`. `loadConfig` validates the
  environment. `createDatabase` wraps a `pg` pool in a Drizzle client. `server.ts` wires these
  together and closes the pool on `SIGINT`/`SIGTERM`.
- **Database**: PostgreSQL 16 through Docker Compose locally. The Drizzle schema lives in
  `apps/api/src/db/schema.ts`, with versioned migrations in `apps/api/drizzle/`. Repository modules
  in `apps/api/src/db/repositories/` are the only code that queries tables directly. See
  [docs/database.md](docs/database.md) for the structure, deletion policies and migration workflow.
- **Authentication**: email and password accounts (Argon2id), server-side sessions stored as token
  hashes, HTTP-only cookies, login rate limiting and an Origin check on writes. See
  [docs/authentication.md](docs/authentication.md).
- **Boards**: authenticated create, list (keyset-paginated), read, rename and delete, with roles
  enforced per action and a dashboard in the web app. See [docs/boards.md](docs/boards.md).
- **Canvas**: a local react-konva editor with pan and zoom, pen, rectangle, ellipse, line, arrow,
  text, and selection. Objects are typed and serializable in `packages/shared` and stored in world
  coordinates. See [docs/canvas.md](docs/canvas.md).
- **Web (`apps/web`)**: React 19 with Vite. The app talks to the API only through relative `/api`
  URLs, which the dev server proxies, so no CORS configuration is needed in development.

## Testing

```sh
pnpm test                       # all packages
pnpm --filter @inkroom/api test # one package
```

- `packages/shared`: schema validation tests.
- `apps/api`: configuration tests and route tests that run the Fastify app in-process, without a
  database (the database dependency is stubbed). Database integration tests run only when
  `TEST_DATABASE_URL` is set; CI sets it.
- `apps/web`: component tests with Vitest and Testing Library in a jsdom environment.

Database integration tests use the Compose database on port 21432 (`pnpm db:up` first). Each run
uses a fresh schema and drops it afterward.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. It installs with
`pnpm install --frozen-lockfile` and then runs lint, format check, typecheck, tests and build on
Node 22. The `pnpm-lock.yaml` file must be committed for the frozen install to succeed.

## Troubleshooting

- **`API unreachable` in the web app**: the API is not running on `API_PORT`, or the port in
  `vite.config.ts` does not match it.
- **`API status: degraded (database: down)`**: PostgreSQL is not running or `DATABASE_URL` is wrong.
  Run `pnpm db:up` and check `docker compose ps`.
- **Port already in use**: change `API_PORT`, `POSTGRES_PORT` and the proxy target together.

## Project status and limitations

- Implemented: monorepo layout, strict TypeScript, ESLint, Prettier, Vitest, health endpoint,
  database connectivity check, Docker Compose PostgreSQL, CI workflow, database schema with
  versioned migrations, repository modules, seed data, integration tests, authentication
  (register, login, logout, current user, session expiry and revocation, rate limiting, CSRF
  origin checks) with login and registration pages, and board management with a dashboard.
- Not implemented: canvas persistence and undo, membership management, real-time collaboration,
  OAuth or social sign-in, Yjs update compaction, email verification, password reset, production
  Docker images.

## Contributing

Read [AGENTS.md](AGENTS.md) before making changes. It describes the architecture conventions,
the required checks, and the rules for keeping changes scoped.
