# InkRoom: project boundaries and working agreement

Read `ROADMAP.md` before starting work. It records what has been verified, what is only written, and
the known gaps.

## Boundaries

- Work only inside this repository. Do not read, modify, clean up, or run commands in other
  repositories, the user's personal configuration, shell profiles, or global Git settings.
- Choose sensible defaults, state assumptions in the report, and continue without waiting for answers.
- Do not install anything globally, and do not use sudo, Homebrew, launchd, host credentials, or host
  Docker sockets.
- Dependencies, toolchains, caches, browser binaries, SDKs, temporary files and test data stay inside this
  repository. `.agent-local/` is the ignored, project-local place for that state. Keep it, and never commit
  it. Python packages go in `.venv`.
- Use existing system tools read-only, or install pinned tools inside this repository.
- Do not modify hidden tool or environment configuration that the environment manages, and do not work
  around sandbox restrictions. If a restriction blocks a needed check, report that check as not run and
  say why.
- Bind test servers to loopback and use ports 21000–21099. Limit build and test workers to two, unless a
  benchmark explicitly needs more.
- Docker-dependent checks that cannot run here stay reproducible in the repository and are reported as
  unverified.
- Do not touch attached hardware, enroll services, install agents, or change OS settings. Supply a manual
  checklist for such steps.

## Project architecture and conventions

- Monorepo managed by pnpm workspaces: `apps/web` (React, Vite), `apps/api` (Fastify, Node 22), and
  `packages/shared` (zod schemas and inferred types used by both apps). The apps import the shared package
  from its TypeScript source. The API bundle inlines it (`apps/api/tsup.config.ts`), so do not add a
  separate build step for the shared package.
- API layering: `config.ts` parses and validates the environment. `db/` holds the pg pool, the Drizzle
  client and the migration helpers. `app.ts` builds the Fastify instance from injected dependencies.
  `server.ts` and `db/scripts/migrate.ts` are the only process entry points. Routes must be testable with
  `app.inject` and must not import an entry point.
- Naming: files and modules are kebab- or lower-case (`app.ts`, `config.ts`). React components are
  PascalCase in `.tsx`. Unit tests sit beside the source as `*.test.ts(x)`. Database tests are named
  `*.integration.test.ts`. API routes live under `/api`.
- Database: PostgreSQL through Drizzle ORM. Table definitions live in `apps/api/src/db/schema.ts`.
  Generate migrations with `pnpm db:generate`, and commit them with the schema change. Only repository
  modules query tables directly.
- TypeScript is strict in every package (`tsconfig.base.json`). Do not weaken compiler options, and do not
  add `any` or `@ts-ignore` to get code to compile.
- Environment variables are documented in `.env.example`, `.env.production.example` and the README. Add
  each new variable to those files, and validate it in `apps/api/src/config.ts`.
- `pnpm-lock.yaml` is committed, and installs use `--frozen-lockfile`. A dependency change updates the
  lockfile in the same commit.

## Verification

Install dependencies first (`pnpm install --frozen-lockfile`). Before reporting a task as complete, run the
checks that the environment allows, and report the results exactly:

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck` and `pnpm test`. `pnpm check` runs the first four.
- `pnpm build` when build inputs, dependencies or entry points change.
- Integration tests need PostgreSQL:
  `TEST_DATABASE_URL=... pnpm --filter @inkroom/api exec vitest run integration`. Set
  `REQUIRE_TEST_DATABASE=true` to make a missing database a failure.
- Browser tests (`pnpm test:e2e`) need the API, PostgreSQL and the Playwright browser. Install the
  browser once with `pnpm --filter @inkroom/web exec playwright install chromium`. The suite starts
  its own API and web servers.
- When touching the API runtime or the web app, start them with `pnpm dev` and check
  `http://127.0.0.1:21080/api/health` and `http://127.0.0.1:21173`. Then stop the processes.
- Use loopback ports 21000–21099 for any server you start. Keep at most two build or test workers.
- Do not report a check as passed unless it ran. Name any skipped or blocked check and give the reason.

## Working rules for coding agents

- Keep changes scoped to the requested task. Do not implement features that were not asked for.
- Write tests for new behavior. Prefer behavior-level tests over tests of implementation details.
- Follow existing patterns before introducing new abstractions or dependencies. Justify any new dependency
  in the commit message.
- Preserve user files and unrelated changes. Do not reformat or reorganize files outside the task.
- Clean up temporary files, scratch scripts, logs, caches you created, and background processes. Do not
  commit them.
- When a task is complete, make a local conventional commit. Do not push.
- Report the changed files, the exact commands run with their results, and the remaining issues.
