# Roadmap

This file records what has been verified, what is implemented but not verified, and the next steps in
priority order. It was rewritten after the final verification pass on 8 November 2026.

## Status vocabulary

- **Verified**: executed in the authoring environment, with the result recorded in the README.
- **Implemented, partly verified**: the code exists and some of its checks have run, but a named part
  has not.
- **Implemented, unverified**: written and reviewed, but its tests or checks have not run.
- **Not implemented**: a requirement from the original brief that has no code yet.

## Verified on 8 November 2026

The environment was macOS on an Apple M4 with 16 GB. Node.js 22.23.4 was used for the project checks,
which matches `.nvmrc`. Dependencies came from the registry through the project's pnpm 9.15.4. PostgreSQL
16.15 ran as a local cluster inside the repository.

- `pnpm install --frozen-lockfile` succeeds with the committed `pnpm-lock.yaml`.
- `pnpm typecheck` passes in `packages/shared`, `apps/api` and `apps/web`.
- `pnpm lint` and `pnpm format:check` pass.
- `pnpm test` with the database passes: 116 shared tests, 204 API tests including 123 integration tests
  against PostgreSQL 16, and 242 web tests.
- The CI integration command, `vitest run integration` in `apps/api`, passes 123 tests with none skipped.
- `pnpm build` produces the API bundles and the web build.
- The bundled migration runner applies the migrations, and a second run changes nothing.
- The bundled server reports `ready` on `/api/ready` and `ok` on `/api/health`, and returns 404 for an
  unknown route.
- `pnpm deploy --prod` for the API produces a directory with `dist/`, `drizzle/` and a working native
  `argon2` module.
- `pnpm test:e2e` passes 20 of 22 browser tests.
- The geometry benchmark's equivalence checks pass on Node 22.23.4 and 26.13.0.
- Both Compose files validate with `docker-compose` 5.7.0, and no Docker daemon was contacted.
- The MIT license is in place, and each package declares it.

## Implemented, partly verified

- **Canvas editing, sync, presence, offline editing and sharing.** The unit and integration tests run and
  pass, and 20 of the 22 browser tests pass. The two failing browser tests are the download tests in step 2.
- **Import and export.** The shared format, server import and browser export are covered by unit and
  integration tests. The browser round trip and region export cannot complete here, because downloads are
  cancelled in this sandbox.
- **Deployment.** The API and web Dockerfiles, nginx configuration and production Compose file are
  written. The Compose files validate, and the API deploy output works. The images have not been built, and
  nginx has not been parsed.
- **Security boundaries.** Auth, origin checks, rate limits, membership checks and session re-checks are
  covered by integration tests. The review in `docs/security.md` lists residual risks.

## Implemented, unverified

- The Docker image builds and the full production stack, including the WebSocket path through nginx.
- The nginx configuration and its Content Security Policy in a browser.
- The document benchmark (`pnpm bench`, Vitest bench). It needs installed dependencies and has not run.
- The accessibility of the canvas, the board page and the dialogs. Only the shell, the forms and the
  dashboard are covered by browser tests.

## Partially implemented against the original brief

- **Responsive layouts.** The shell, sign-in and dashboard fit a 375 px screen in tests. The board page,
  whose toolbar and canvas start below the sharing panel, has no phone-width test.
- **Polished error states.** The main forms and the board page show plain messages and a retry control.
  No systematic review of every error state has been made.
- **Keyboard and focus behaviour.** Focus is visible, there is a skip link, and the dashboard works from
  the keyboard. The whiteboard cannot be operated fully from the keyboard.
- **Performance.** The pure canvas code is measured. The 1,000-object target has not been shown in a
  browser, and per-move work has not been reduced.
- **Offline.** An edit is written to the device copy about 12 ms after it is drawn, measured on an idle
  browser. Closing the page inside that window can lose the last edit.

## Not implemented

- Multi-process rate limits and connection counts.
- Email verification and password reset.
- Keyboard operation of every whiteboard action.

## Publication status

- The MIT license is committed with copyright 2026 Mykyta Kizilov.
- The git history contains a personal absolute path, `/Users/mk-rune/...`, in `AGENTS.md` from commit
  `10e6b08`. Commit `37a053a` removed it from the working tree, but it remains in history. See step 1.
- No GitHub repository has been created and nothing has been pushed. The parent orchestrator publishes.

## 1. Decide how to handle the personal path in the public history

- **Scope:** the path `/Users/mk-rune/...` appears in commit `10e6b08`. Choose one of three paths with
  the orchestrator: accept it, rewrite the history with `git filter-repo` before publication, or squash
  nothing and leave a note. The working tree is already clean.
- **Rationale:** the path reveals a local username and folder layout. It is not a secret, but it is personal
  data in a public history, and a rewrite would change every commit hash after it.
- **Dependencies:** the orchestrator's publication decision. Any rewrite must cover all 21 commits and
  every branch and tag.
- **Acceptance criteria:** `git log --all -S'/Users/mk-rune'` returns no commits, or the orchestrator
  records that the path is accepted.
- **Effort:** 1 to 2 hours, including the decision.

## 2. Make the two download tests run

- **Scope:** `apps/web/e2e/import-export.spec.ts` has two tests that read the JSON and SVG/PNG files the
  browser downloads. In this sandbox every download is cancelled, even a plain `data:` link, so the tests
  fail at `download.path()`. Find out whether the cause is the sandbox, the headless shell, or the project's
  temporary directory setting, and run the tests on a machine where downloads work. Do not change the
  project's temporary directory to get around the sandbox.
- **Rationale:** these tests are the only browser evidence that the export files have the right contents.
- **Dependencies:** a machine or CI runner where Chromium downloads succeed.
- **Acceptance criteria:** both tests pass on CI, and the README's verification section names the runner.
- **Effort:** 3 to 6 hours.

## 3. Smoke-test the production stack on a machine with a Docker daemon

- **Scope:** build `apps/api/Dockerfile` and `apps/web/Dockerfile`, then run
  `docker compose -f docker-compose.prod.yml --env-file ... up -d --build --wait`. Check `/api/ready` through
  the web container, sign in, open a board, edit it, and confirm the WebSocket stays open through nginx.
  Add the smoke test to the `images` job in CI.
- **Rationale:** the images and the nginx proxy path have never run. The Compose file only validates.
- **Dependencies:** a Docker daemon the operator controls. This sandbox does not operate a daemon.
- **Acceptance criteria:** both images build in CI, the stack reports ready, sign-in and an edit work, and
  the WebSocket upgrade succeeds through nginx.
- **Effort:** 6 to 10 hours.

## 4. Validate the nginx configuration and the Content Security Policy

- **Scope:** run `nginx -t` on the web image in CI. Load the built app through the stack and check the browser
  console for Content Security Policy violations. Confirm that inline styles from React and the same-origin
  WebSocket are allowed, and change the policy only as far as needed.
- **Rationale:** the policy has never been checked in a browser. A violation would break the canvas or sync
  in production while every other check passes.
- **Dependencies:** step 3.
- **Acceptance criteria:** `nginx -t` passes in CI, and the stack shows no CSP violations in a browser run.
- **Effort:** 2 to 4 hours.

## 5. Re-measure the benchmarks on a quiet machine

- **Scope:** run `bench:geometry` on Node 22 and 26 with no other load, then run the document benchmark with
  `pnpm bench`. Record the results in `docs/performance.md`, and say which run they came from.
- **Rationale:** the Node 22 run in this turn passed its equivalence checks, but its timings were taken right
  after the browser suite and are not comparable with earlier runs. The document benchmark has never run.
- **Dependencies:** installed dependencies (already present).
- **Acceptance criteria:** `docs/performance.md` has one clean Node 22 run and one document-benchmark run,
  each with its environment and date.
- **Effort:** 2 to 3 hours.

## 6. Close the write window for sessions that ended in another process

- **Scope:** check the session of each open connection before each accepted write, using a short-lived cache
  (for example, five seconds). Keep the periodic access check as the backstop.
- **Rationale:** `docs/security.md` records that a session ended in another process can write for up to 30
  seconds, because writes check membership and not the session.
- **Dependencies:** none, but the session tests in `sync/session-lifecycle.integration.test.ts` must keep
  passing.
- **Acceptance criteria:** an integration test shows a write from a session revoked elsewhere is refused within
  one second, and `docs/security.md` is updated.
- **Effort:** 4 to 6 hours.

## 7. Move the revision authorization into the store API

- **Scope:** `PostgresBoardStore.getRevision` does not check the caller's role. Every route checks membership
  first. Add the membership check inside the store functions, so a future caller cannot skip it.
- **Rationale:** the routes are correct today, but the store API looks public. Authorization belongs where the
  data is read.
- **Dependencies:** none.
- **Acceptance criteria:** a store-level test shows a non-member cannot read a revision, and all existing
  revision tests still pass.
- **Effort:** 2 to 3 hours.

## 8. Share rate limits and connection counts across API processes

- **Scope:** move the login failure counters and the per-user connection budget into PostgreSQL, which adds no
  service. Record the decision in `docs/`. Redis would need its own decision.
- **Rationale:** the limits are kept per process, so each added process multiplies them. The per-address
  sign-in limit is the only defence against credential guessing at scale.
- **Dependencies:** step 6 is recommended first, so the session cache design is settled.
- **Acceptance criteria:** two API processes share one sign-in limit, shown by an integration test, and the
  per-user connection limit holds across processes.
- **Effort:** 8 to 12 hours.

## 9. Warn before leaving with unsaved offline edits

- **Scope:** when the device copy has saves still queued, show the browser's leave-page prompt. Document the
  write window and the prompt in `docs/offline.md`. Consider a visible "Saved on this device" status, so
  users can see when an edit is safe.
- **Rationale:** an edit can be lost if the page closes within about 12 ms of being drawn. Nothing warns the
  user.
- **Dependencies:** none. The offline browser tests should keep passing.
- **Acceptance criteria:** a browser test shows the prompt while saves are queued and not otherwise, and
  `docs/offline.md` describes the behaviour.
- **Effort:** 3 to 5 hours.

## 10. Warn when a viewer downgrade discards unsynced changes

- **Scope:** when a user's role is reduced to viewer while they hold changes the server has not accepted,
  discard those changes from the in-memory document and tell the user what was discarded.
- **Rationale:** the viewer's changes are never stored, so they stay visible until a reload, which is
  misleading.
- **Dependencies:** step 9 for the messages.
- **Acceptance criteria:** a browser test shows the discard and its message, and the discarded changes do not
  reappear after a reload.
- **Effort:** 4 to 6 hours.

## 11. Make the whiteboard fully keyboard-operable and audit it

- **Scope:** keyboard selection, movement, resizing, deletion, undo and export on the canvas. Focus moves into
  and out of the export and sharing panels. Run an automated accessibility scan (adding `@axe-core/playwright`
  needs a justification in its commit) on sign-in, the dashboard, the board page and each panel.
- **Rationale:** keyboard operation of the whiteboard is partial, and the original brief asks for accessible
  focus behaviour.
- **Dependencies:** the browser suite must keep running (step 2 for the download tests).
- **Acceptance criteria:** each listed canvas action works without a pointer in a browser test, the scan reports
  no serious or critical violations on the listed pages, and the focus order is tested for both panels.
- **Effort:** 16 to 24 hours.

## 12. Make the board page usable on a phone

- **Scope:** check the board page at 375 by 667 pixels, including the toolbar, the status line and the members
  list. Place the canvas above the sharing panel on small screens, or collapse the panel. Support touch pan and
  pinch zoom, and add browser tests with touch emulation.
- **Rationale:** the whiteboard is the core feature, and it is below the fold on short screens today.
- **Dependencies:** step 2 for the browser suite.
- **Acceptance criteria:** no horizontal overflow on the board page at 375 pixels, the canvas is visible without
  scrolling on a 667-pixel-tall screen, and touch pan and pinch zoom are covered by a passing browser test.
- **Effort:** 8 to 14 hours.

## 13. Make text bounds and exports faithful

- **Scope:** measure text with the canvas `measureText` API for selection bounds and region export, instead of
  estimating from character count. Add snapshot tests for PNG and SVG output of a representative board,
  including a case with glyphs wider than the estimate.
- **Rationale:** the current estimate can include or exclude text at a region's edge incorrectly, and export
  fidelity is a stated requirement.
- **Dependencies:** step 2, so the export tests can run.
- **Acceptance criteria:** region export includes or excludes a text object at the boundary exactly as its
  rendered bounds do, the snapshot tests pass, and the known limitation in `docs/import-export.md` is removed
  or narrowed.
- **Effort:** 8 to 12 hours.

## 14. Measure in a browser at 1,000 objects, then reduce per-move work

- **Scope:** a browser benchmark with a fixed 1,000-object board. Measure drag frame time, React commit counts
  per pointer move (React Profiler) and Yjs frames per 60-move drag, before and after. Then coalesce pointer
  moves to one editor action per animation frame, and batch the Yjs transactions for each frame.
- **Rationale:** the pure canvas code is measured, but the 1,000-object target has not been shown in a browser.
  A 60-move drag currently sends 60 frames.
- **Dependencies:** step 2, and step 5 for the document benchmark numbers.
- **Acceptance criteria:** before and after numbers for the listed metrics are recorded in `docs/performance.md`,
  a drag produces fewer frames than moves with the same final state, and the existing browser tests still pass.
- **Effort:** 16 to 24 hours.

## 15. Split the web bundle

- **Scope:** lazy-load the export and import code, the PNG path and the offline store, so the main chunk falls
  below Vite's 500 kB advisory limit.
- **Rationale:** the main chunk is 828 kB minified (252 kB gzipped), which delays the first load on slow
  connections.
- **Dependencies:** none.
- **Acceptance criteria:** `pnpm build` reports a main chunk below 500 kB, and the browser tests still pass.
- **Effort:** 4 to 6 hours.

## 16. Measure, then speed up hit testing and document diffing

- **Scope:** measure `diffDocuments`, which runs on every change to the object list, at 1,000 and 5,000
  objects. Add the bounds pre-check that pen strokes already have to rectangles, lines and arrows, and cache the
  scene plan per viewport only if the measurement shows it helps.
- **Rationale:** picking costs about 0.17 ms per click at 5,000 objects and scales linearly. The cost of diffing
  has never been measured.
- **Dependencies:** step 5 for the measurement environment.
- **Acceptance criteria:** an equivalence test shows picks return the same objects before and after, the diff and
  pick costs are recorded at both sizes, and the geometry benchmark does not regress.
- **Effort:** 4 to 8 hours.

## 17. Automate backups and rehearse a restore

- **Scope:** schedule `pg_dump` in the custom format with a retention policy, store the copies off the host in
  encrypted storage, and script a restore drill against a separate stack.
- **Rationale:** the backup and restore steps in the README are manual and have never been run. A backup that has
  not been restored is not known to work.
- **Dependencies:** step 3.
- **Acceptance criteria:** a scheduled job produces a dump and applies retention, and the restore drill's result,
  including an integrity check of the restored data, is recorded.
- **Effort:** 6 to 10 hours.

## 18. Add request IDs, metrics and log shipping

- **Scope:** a request ID on every HTTP request and on each sync connection it opens. Metrics for open
  connections, rooms, rate-limit rejections and readiness failures. Document how logs and metrics are shipped.
- **Rationale:** logs are structured, but nothing ties a failing request to a WebSocket or a database error, and
  the limits that protect the service have no metrics.
- **Dependencies:** step 3.
- **Acceptance criteria:** a request ID appears in the logs for the request and the connection it opened, an
  integration test reads the metrics, and the shipping setup is documented.
- **Effort:** 10 to 16 hours.

## 19. Add supply-chain and secret-scanning gates to CI

- **Scope:** `pnpm audit --prod` as a gate, a secret scan of the repository, an image scan, and a software bill of
  materials attached to each run.
- **Rationale:** the dependencies have not been audited, and no scan has run on the repository or the images.
- **Dependencies:** step 3 for the images.
- **Acceptance criteria:** the gates run in CI and fail on a known-vulnerable test package, and the failure policy
  is written down.
- **Effort:** 6 to 10 hours.

## 20. Align the Node version floor and the benchmark requirement

- **Scope:** the `engines` field says Node 22.9, but the geometry benchmark uses `module.registerHooks`, which needs
  22.15. Align the floor, `.nvmrc`, the CI version and the benchmark's error message.
- **Rationale:** a developer on Node 22.9 gets a failure from a script with no clear cause.
- **Dependencies:** none.
- **Acceptance criteria:** the four values agree, and the benchmark exits with a message that names the required
  version on an older Node.
- **Effort:** 1 to 2 hours.

## 21. Slim the API deployment output

- **Scope:** `pnpm deploy` copies `src/`, the Dockerfile and the config files into the runtime directory. Declare
  the runtime files in `package.json` (`files`), and check the resulting image's contents.
- **Rationale:** the production image carries source and tooling it does not need.
- **Dependencies:** step 3.
- **Acceptance criteria:** the deploy output contains `dist/`, `drizzle/`, `package.json` and the production
  dependencies only, and the smoke test still passes.
- **Effort:** 2 to 3 hours.

## 22. Add email verification and password reset

- **Scope:** single-use, expiring tokens for verification and reset, sent through an email provider. The provider
  choice is the user's decision.
- **Rationale:** there is no recovery path, and registration has no application-level limit beyond the sign-in
  counters.
- **Dependencies:** step 8 for shared limits, and the provider decision.
- **Acceptance criteria:** a token works once and expires, registration returns 429 above the limit, and the flows
  have browser tests.
- **Effort:** 12 to 20 hours, excluding provider setup.

## 23. Keep the documentation in step with the code

- **Scope:** check each document against the code after the steps above. Keep the README's verification section
  dated and tied to a commit. Check that the Markdown tables still match Prettier's layout, and run that check in CI.
- **Rationale:** several documents describe behaviour that changed in later turns.
- **Dependencies:** steps 1 to 22.
- **Acceptance criteria:** every behaviour statement in `docs/` and the README matches a test or a named check, and
  the link and table checks pass.
- **Effort:** 1 to 2 hours.

## Total estimate

The step estimates sum to 129 to 208 hours. The ranges are:

- Steps 1 to 5 (verification gaps): 14 to 25 hours.
- Steps 6 to 10 (correctness and security): 21 to 32 hours.
- Steps 11 to 14 (user-facing completeness and performance): 48 to 74 hours.
- Step 15 (bundle): 4 to 6 hours.
- Step 16 (measurement-led optimization): 4 to 8 hours.
- Steps 17 to 23 (operations, supply chain and documentation): 38 to 63 hours.

Assumptions:

- One engineer who knows this codebase, working on it full time.
- CI runners with Docker, PostgreSQL 16 and a browser that can download files are available. Steps 2 and 3
  depend on them.
- The operator can run a Docker daemon where this sandbox cannot.
- The orchestrator decides step 1 before publication. A history rewrite would add time for coordination, which
  is not included.
- The email provider (step 22) and the store decision (step 8) are made when those steps start.
- No hardware is involved in the original brief.
- Estimates exclude review cycles and calendar time.
