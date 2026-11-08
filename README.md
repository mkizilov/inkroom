# InkRoom

InkRoom is a collaborative whiteboard. People sign in, create boards, and draw together in real time.
Each board is a Yjs document that syncs over an authenticated WebSocket. Boards can be shared with
editors and viewers, work offline in the browser, and be exported and imported as PNG, SVG and
versioned JSON.

## Status

The features are implemented: accounts and sessions, boards with owner, editor and viewer roles,
the canvas editor, real-time sync, stored history with restore, offline editing, import and export,
presence, and the production deployment setup described below.

The code has not yet been built, type-checked, linted or tested in an environment with installed
dependencies. The authoring environment could not reach the package registry or run Docker. The
first CI run is the first full verification. [ROADMAP.md](ROADMAP.md) lists what has been verified,
what has not, and the prioritized next steps. See also [Limitations](#limitations).

One thing blocks CI and the Docker builds: `pnpm-lock.yaml` is not committed yet. Both use
`pnpm install --frozen-lockfile`, which fails without it. Generate it on a networked machine with
pnpm 9.15.4 (`pnpm install`), review the diff, and commit it.

## Repository layout

- `apps/api` is the Fastify API (Node.js 22, TypeScript, Drizzle ORM, PostgreSQL). Its entry points
  are `src/server.ts` (the server) and `src/db/scripts/migrate.ts` (the migration runner).
- `apps/web` is the React 19 and Vite client. `nginx.conf` and `Dockerfile` serve it in production.
- `packages/shared` holds the zod schemas and types used by both apps. It is consumed as TypeScript
  source, so it has no build step of its own.
- `docs/` holds design notes for each subsystem.
- `docker-compose.yml` runs PostgreSQL for development.
- `docker-compose.prod.yml` runs the production stack.
- `.github/workflows/ci.yml` runs the checks on every push and pull request.
- `ROADMAP.md` lists what has been verified, what has not, and the prioritized next steps.
- `AGENTS.md` describes the conventions for coding agents working in this repository.

## Installation

Prerequisites:

- Node.js 22.9 or newer. `.nvmrc` pins 22. The benchmark script needs Node 22.15 or newer.
- pnpm 9.15.4. With Corepack enabled, run `corepack enable`; the version comes from the
  `packageManager` field.
- Docker with Compose v2, for PostgreSQL in development and for the production stack.

To install the dependencies:

```sh
cp .env.example .env
pnpm install
```

## Development

Start PostgreSQL, apply migrations, and run both servers:

```sh
pnpm db:up          # PostgreSQL on 127.0.0.1:21432, waits until healthy
pnpm db:migrate     # apply migrations
pnpm db:seed        # optional: demo users, a board and an update (development only)
pnpm dev            # API on http://127.0.0.1:21080, web on http://127.0.0.1:21173
```

Open <http://127.0.0.1:21173>. The development seed creates `alice@example.com` (owner),
`bob@example.com` (editor) and `carol@example.com` (viewer), all with the password `demo-password-123`.

Commands run from the repository root:

- `pnpm dev` runs the API in watch mode and the web dev server together.
- `pnpm build` builds every package. The API bundles to `apps/api/dist/server.js` and
  `apps/api/dist/migrate.js`, and the web app to `apps/web/dist`.
- `pnpm lint`, `pnpm format:check` and `pnpm typecheck` run ESLint, Prettier and `tsc` over the
  repository. `pnpm format` rewrites files with Prettier.
- `pnpm test` runs the unit and component tests in every package.
- `pnpm check` runs lint, format check, typecheck and tests.
- `pnpm db:down` stops PostgreSQL. Its data stays in the `postgres-data` volume.
- `pnpm db:generate` creates a migration from `apps/api/src/db/schema.ts`.

The dev web server proxies `/api` to the API. If you change `API_PORT`, change the target in
`apps/web/vite.config.ts` as well.

## Configuration

Copy `.env.example` to `.env` for development, and `.env.production.example` to `.env.production`
for deployment. Both are git-ignored. The API validates its environment at startup and exits with a
message when a value is missing or invalid.

API settings:

- `NODE_ENV`: `development`, `test` or `production`. Production applies the stricter rules below.
- `API_HOST` and `API_PORT`: the listen address and port. Defaults are `127.0.0.1` and `21080`. The
  container image listens on `0.0.0.0`.
- `DATABASE_URL`: a `postgres://` URL. Required.
- `WEB_ORIGIN`: the origin users open in the browser. Cookie-authenticated writes must come from
  it. Defaults to `http://127.0.0.1:21173` outside production. Production requires it, and it must
  use `https://`.
- `COOKIE_SECURE`: makes the session cookie `Secure`. Secure by default in production. Production
  refuses `false`.
- `LOG_LEVEL`: `fatal`, `error`, `warn`, `info`, `debug`, `trace` or `silent`. Default `info`.
- `TRUST_PROXY`: comma-separated addresses or CIDR ranges of reverse proxies whose `X-Forwarded-For`
  is trusted. Empty by default. Set it only when a proxy sits in front of the API.

Test settings:

- `TEST_DATABASE_URL`: enables the database integration tests. Each test file uses its own schema,
  which is dropped afterwards.
- `REQUIRE_TEST_DATABASE=true`: makes a missing `TEST_DATABASE_URL` fail the run instead of skipping
  the integration tests. CI sets it.

Development database settings, used by `docker-compose.yml`:

- `POSTGRES_USER`, `POSTGRES_PASSWORD`, `POSTGRES_DB` and `POSTGRES_PORT`. Defaults are `inkroom`
  for the first three and `21432` for the port.

Production stack settings, used by `docker-compose.prod.yml`:

- `POSTGRES_USER`, `POSTGRES_PASSWORD` and `POSTGRES_DB`. Required, with no defaults. Use a long
  random password without `@ : / ? #`.
- `WEB_ORIGIN`. Required. The public `https://` origin.
- `WEB_PORT`: the loopback port the web container publishes. Default `21173`.
- `LOG_LEVEL`: as above.
- `INKROOM_TAG`: the tag for the built images. Default `local`. Use a release tag for rollbacks.

The local defaults use loopback ports in the 21000 to 21099 range. The development credentials are
for local use only and must not be reused anywhere else.

## Architecture

- **Shared contract** (`packages/shared`). The request and response schemas, the canvas object model,
  the Yjs wire protocol and the board export format. The API and the web app parse with the same
  schemas.
- **API** (`apps/api`). `buildApp` receives its dependencies, so routes can be tested with
  `app.inject`. `loadConfig` validates the environment. `server.ts` wires the pieces together and
  shuts down on `SIGINT` and `SIGTERM`. The bundled server and migration runner inline the shared
  package.
- **Database.** PostgreSQL 16 with a Drizzle schema in `apps/api/src/db/schema.ts` and migrations in
  `apps/api/drizzle`. Only the repository modules query tables directly. See
  [docs/database.md](docs/database.md).
- **Authentication.** Argon2id passwords, server-side sessions stored as token hashes, HTTP-only
  cookies, rate limits, and an Origin check on writes. See [docs/authentication.md](docs/authentication.md).
- **Boards.** Create, list, read, rename, delete, sharing with registered users, and roles enforced
  for each action. See [docs/boards.md](docs/boards.md).
- **Canvas.** A react-konva editor with pan and zoom, pen, rectangle, ellipse, line, arrow, text,
  selection, transforms, copy and paste, layer order, keyboard shortcuts, and undo and redo. Edits are
  Yjs transactions. See [docs/canvas.md](docs/canvas.md) and [docs/yjs-document.md](docs/yjs-document.md).
- **Real-time sync.** One Yjs room per board over an authenticated WebSocket, with roles enforced per
  connection, frame and connection limits, heartbeats, and reconnection with backoff. See
  [docs/sync.md](docs/sync.md).
- **Persistence and history.** Updates are stored before they are applied or acknowledged. Boards are
  rebuilt from the store after a restart, compaction folds the log into snapshots, and owners can
  restore a revision. See [docs/persistence.md](docs/persistence.md).
- **Offline editing.** A board opened online keeps a copy in the browser, in IndexedDB and per user.
  Edits made offline survive a reload, and the app opens offline through a service worker. See
  [docs/offline.md](docs/offline.md).
- **Import and export.** PNG, SVG and versioned JSON for the whole board, a selection or a region,
  and JSON import as a new board. See [docs/import-export.md](docs/import-export.md).
- **Presence.** Remote cursors, names, selection outlines and a participant list. Presence is never
  stored. See [docs/presence.md](docs/presence.md).
- **Security.** The boundaries, the review and the remaining risks are in
  [docs/security.md](docs/security.md).
- **Performance.** Measured results and remaining bottlenecks are in
  [docs/performance.md](docs/performance.md).

## Testing

Run the whole suite with `pnpm test`, or one package with `pnpm --filter @inkroom/api test`.

- `packages/shared` tests the schemas.
- `apps/api` tests configuration, the routes (in-process with `app.inject`), and the sync and
  persistence logic. Tests named `*.integration.test.ts` need PostgreSQL. They run when
  `TEST_DATABASE_URL` is set and are skipped otherwise.
- `apps/web` tests components with Vitest and Testing Library in jsdom.
- `apps/web/e2e` holds the browser tests. They cover sign-in, boards, real-time sync with two
  browsers, presence, offline editing, import and export, accessibility, and phone-sized layouts.
  They start the API and the web app themselves, so PostgreSQL must be running and migrated.
- `apps/web/bench` holds performance benchmarks. `pnpm --filter @inkroom/web bench:geometry` runs
  the pure canvas code without installed dependencies, and `pnpm --filter @inkroom/web bench` runs
  the document benchmarks after `pnpm install`.

To run the database tests and the browser tests locally:

```sh
pnpm db:up
pnpm db:migrate
export TEST_DATABASE_URL=postgres://inkroom:inkroom@127.0.0.1:21432/inkroom
pnpm --filter @inkroom/api test
pnpm --filter @inkroom/web exec playwright install chromium
pnpm test:e2e
```

The browser tests expect `WEB_ORIGIN=http://127.0.0.1:21173` and cookies that are not `Secure`. Those
are the defaults outside production and the values in `.env.example`. CI sets them for the browser job.

## Continuous integration

`.github/workflows/ci.yml` runs on pushes to `main` and on pull requests. It has five jobs.

- `verify` runs lint, format check, typecheck, the unit tests and the build.
- `integration` runs the API integration tests against PostgreSQL 16. It fails, rather than skips,
  when the database is missing.
- `production-build` applies the migrations from the built bundle twice, and checks that the built
  server answers `/api/ready`.
- `e2e` runs the Playwright suite against PostgreSQL 16.
- `images` validates the production compose file with placeholder values, and builds both images.

## Health and logs

- `GET /api/health` reports the process and the database. It returns `200` with `"status": "ok"`, or
  `503` with `"status": "degraded"` when the database is unreachable.
- `GET /api/ready` is the readiness check. It returns `200` only when the database answers and every
  migration the code ships with is applied. Otherwise it returns `503` with a reason:
  `database_unreachable`, `migrations_unavailable` or `migrations_pending`. The deployment waits on it.
- Logs are JSON lines on standard output. The `cookie` and `authorization` headers are censored. The
  level comes from `LOG_LEVEL`.

## Deployment

The production stack is four containers on an internal network: PostgreSQL, a one-off migration job,
the API, and the web app. Only the web container publishes a port, on loopback. Put a
TLS-terminating reverse proxy in front of it.

Steps:

1. Commit `pnpm-lock.yaml`, as described under [Status](#status).
2. Create the environment file: `cp .env.production.example .env.production`. Set a long random
   `POSTGRES_PASSWORD`, and set `WEB_ORIGIN` to the public `https://` origin.
3. Start the stack:

   ```sh
   docker compose -f docker-compose.prod.yml --env-file .env.production up -d --build --wait
   ```

4. Check readiness through the web container: `curl -fsS http://127.0.0.1:21173/api/ready`. The
   response should be `{"status":"ready"}`.
5. Point the TLS proxy at `http://127.0.0.1:21173` (or the value of `WEB_PORT`). Pass the `Origin`
   header through unchanged. Requests with a different origin are refused.

What happens on `up`:

- PostgreSQL starts and reports healthy.
- The `migrate` job applies pending migrations, each in its own transaction, then exits. The API
  starts only after it exits successfully. Look at `docker compose logs migrate` if it fails.
- The API starts. Its health check uses `/api/ready`.
- The web container starts after the API is healthy.

Upgrades: check out the new revision, then run the same `up -d --build --wait` command. Migrations
are forward only. To roll back after a migration has run, restore the database from a backup taken
before the upgrade, and then start the previous image tag (set `INKROOM_TAG` to the old value).

Client addresses: the API sees the web container's address as the connection source, and trusts
`X-Forwarded-For` only from the internal subnet, which `TRUST_PROXY` pins. If a TLS proxy runs on
the same host, nginx sees the proxy's address instead of the client's. Then enable the real-IP lines
in `apps/web/nginx.conf`, set the proxy's address, and rebuild the web image. Otherwise the sign-in
limits apply to every user together.

Operating notes:

- Logs: `docker compose -f docker-compose.prod.yml logs -f api`.
- Stop: `docker compose -f docker-compose.prod.yml down`. Data stays in the `inkroom_postgres-data`
  volume. `down -v` deletes it.
- Demo data is never created in production. `pnpm db:seed` refuses to run when `NODE_ENV=production`.

## Backup and restore

Back up with `pg_dump` in the custom format. It runs inside the database container, uses that
container's credentials, and works while the server is running.

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  sh -c 'pg_dump -U "$POSTGRES_USER" -d "$POSTGRES_DB" -Fc' > inkroom-$(date +%F).dump
```

Restore into the running database. Stop the API and the web app first, so no writes arrive during the
restore:

```sh
docker compose -f docker-compose.prod.yml --env-file .env.production stop api web
docker compose -f docker-compose.prod.yml --env-file .env.production exec -T postgres \
  sh -c 'pg_restore --clean --if-exists -U "$POSTGRES_USER" -d "$POSTGRES_DB"' < inkroom-2026-01-02.dump
docker compose -f docker-compose.prod.yml --env-file .env.production up -d --wait
```

Guidance:

- Take a dump before every upgrade, and keep dumps off the host, in encrypted storage.
- A dump contains every board, every account and every password hash. Restrict access to it.
- Test a restore on a separate stack from time to time. A backup that has never been restored is not
  known to work.
- Restoring a dump from an older version restores an older schema. Run the `up` command afterwards so
  the migration job brings it up to date.

## Troubleshooting

- The web app shows that the API is unreachable: the API is not running, or the proxy target is
  wrong. Check `docker compose ps` and the `api` logs.
- `/api/ready` returns `migrations_pending`: the migration job has not run. Check
  `docker compose logs migrate`.
- `/api/ready` returns `database_unreachable`: check the `postgres` container and the
  `DATABASE_URL` the API received.
- Sign-in is refused for every user: the per-address limit is counting the proxy's address. See
  [Deployment](#deployment).
- In development, port conflicts: change `API_PORT`, `POSTGRES_PORT` and the proxy target together.

## Limitations

- The lockfile is not committed yet. Installs with `--frozen-lockfile`, the CI jobs and both Docker
  builds fail until it is.
- Nothing has been run in the authoring environment: no install, type check, lint, test, build,
  Docker build, or browser test. The Compose file and the workflow were checked for YAML syntax, and
  the TypeScript for syntax. Expect the first CI run to find problems.
- Rate limits and connection counts are per API process. Several API processes would multiply the
  limits. A shared store is needed before scaling out.
- Writes check membership but not the session, so a session that ends in another process can still
  write for up to 30 seconds. Sign-out in the same process is immediate.
- Import always creates a new board. Merging into an existing board is not supported.
- Offline access covers only boards that were opened online on the same device.
- There is no email verification, password reset or multi-factor authentication.
- The application does not encrypt data at rest. Use an encrypted volume or disk.
- Most features have been written and reviewed, but not executed against installed dependencies. See
  [ROADMAP.md](ROADMAP.md) for the status of each area.

## Contributing

Read [AGENTS.md](AGENTS.md) before making changes. It describes the architecture conventions, the
required checks, and the rules for keeping changes scoped.
