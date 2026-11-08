# InkRoom: project boundaries and working agreement

- Work only in `/Users/mk-rune/test_projects/01-inkroom`. This is one of fourteen independent repositories.
- Do not read, modify, clean up, or run commands in sibling repositories or the user's configuration.
- Work autonomously: choose sensible defaults and document assumptions; do not ask questions or delegate.
- Never install anything globally or use sudo, Homebrew, launchd, host credentials, or host Docker sockets.
- Dependencies, toolchains, caches, browser binaries, SDKs, temporary files and test data stay in this repository. Preserve the supplied project-local environment. Python packages go in `.venv`.
- `.agent-local/` is ignored, project-local build/runtime state. `.opencode/` is managed orchestration configuration; do not change or remove it or bypass the sandbox.
- Use existing system tools read-only, or install pinned tools under this repository. Do not change shell profiles, user settings, Keychain, or global Git settings.
- Bind test servers to loopback; use ports 21000–21099. Limit build/test workers to two unless a required benchmark explicitly needs more.
- Docker-dependent integration tests must remain reproducible but be reported as unverified here if they require access outside this repository. Do not bypass this boundary.
- Do not touch attached hardware, enroll services, flash firmware, install agents, or alter OS settings. Supply manual checklists for such steps.
- Implement only the current numbered prompt, preserving prior behavior. Run appropriate checks, fix failures, and report genuine limitations without fabricating test or benchmark results.
- Before finishing every numbered turn: stop its servers/watchers, remove scratch outputs, update relevant documentation, and make a local conventional-commit Git commit. Do not push.
- End each turn with a short summary of changes, checks actually run, remaining limitations, and commit hash. The orchestrator will provide the next prompt only after this turn ends.

Extend this file with the project's language-specific architecture and verification commands while retaining these boundaries.

## Project architecture and conventions

- Monorepo managed by pnpm workspaces: `apps/web` (React, Vite), `apps/api` (Fastify, Node 22),
  `packages/shared` (zod schemas and inferred types used by both apps). Consumers import the shared
  package from its TypeScript source; do not add a build step for it without a reason.
- API layering: `config.ts` parses the environment, `db/` holds the pg pool and Drizzle client,
  `app.ts` builds the Fastify instance from injected dependencies, `server.ts` is the only
  process entry point. Routes must be testable with `app.inject` and must not import `server.ts`.
- Naming: files and modules are kebab- or lower-case (`app.ts`, `config.ts`); React components are
  PascalCase in `.tsx`; tests sit beside the source as `*.test.ts(x)`; API routes live under `/api`.
- Database: PostgreSQL through Drizzle ORM. Table definitions go in `apps/api/src/db/schema.ts`
  (currently empty). Generate migrations with `pnpm db:generate` and commit them.
- TypeScript is strict in every package (`tsconfig.base.json`). Do not weaken compiler options or
  add `any`/`@ts-ignore` to get code to compile.
- Environment variables are documented in `.env.example` and the README. Add new variables to both
  and validate them in `apps/api/src/config.ts`.

## Verification

Run these before reporting a task as complete:

- `pnpm lint`, `pnpm format:check`, `pnpm typecheck`, `pnpm test`. `pnpm check` runs all four.
- `pnpm build` when you change build inputs, dependencies, or entry points.
- When touching the API runtime or the web app, start them with `pnpm dev` and check
  `http://127.0.0.1:21080/api/health` and `http://127.0.0.1:21173`, then stop the processes.
- Use loopback ports 21000–21099 for any server you start. Keep at most two build or test workers.

## Working rules for coding agents

- Keep changes scoped to the requested task. Do not implement features that were not asked for.
- Write tests for new behavior. Prefer behavior-level tests over tests of implementation details.
- Follow existing patterns before introducing new abstractions or dependencies. Justify any new
  dependency in the final report.
- Preserve user files and unrelated changes. Do not reformat or reorganize files outside the task.
- Clean up temporary files, scratch scripts, logs, and background processes you created.
- Report changed files, the exact commands run with their results, and remaining issues.
- Stop after completing the current task. Do not start the next numbered prompt.
