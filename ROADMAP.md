# Roadmap

This is the handoff after the final review. It starts from what has been executed, not from what was
written. Read the status section before the steps: most of the code has been written and reviewed, but
almost none of it has been run against installed dependencies.

## Status vocabulary

- **Verified**: executed in the authoring environment, with the result recorded.
- **Checked**: a static check ran (syntax, parse, link or configuration validation). It shows the file
  is well formed, not that it behaves correctly.
- **Implemented, unverified**: written and reviewed by reading, but never executed.
- **Partial**: some acceptance criteria are met, others are not, or the scope is narrower than the
  original requirement.

## What is verified

- The geometry benchmark (`pnpm --filter @inkroom/web bench:geometry`) runs without installed
  dependencies on Node v26.13.0 (Apple M4, 10 cores, 16 GB). Its equivalence checks passed on every run,
  including the final one. The timings are in `docs/performance.md`, and a run in the final turn matched
  them within noise.
- Syntax parses for all 152 tracked TypeScript and JavaScript files. This does not cover TSX, which Node
  cannot parse.
- YAML parses for the 4 tracked YAML files, including the CI workflow and both compose files.
- JSON parses for the 4 `package.json` files.
- `docker-compose` 5.7.0 validates both compose files offline. The production file refuses to start
  without its required secrets, and the resolved service environment is correct.
- All 24 relative links in the Markdown files resolve.
- All 14 Markdown tables match Prettier's aligned layout. They were realigned in the final turn.

## What is not verified

- `pnpm install`, `pnpm typecheck`, `pnpm lint`, `pnpm format:check`, `pnpm build`, the Vitest suites
  (39 unit and component files), the API integration tests (11 files), the Playwright specs (7 files),
  the Docker image builds, and `nginx -t`.
- The reasons, as recorded during the work: the package registry was unreachable (HTTP status `000`);
  no PostgreSQL server was available; no TypeScript compiler, ESLint or Prettier is installed on the
  machine; no nginx binary exists; and the Docker daemon may not be operated from this sandbox.
- Prettier was not run on any file. Only the Markdown tables were checked against its layout. Expect
  `format:check` to report more files on the first CI run.

## Status by area

- **Repository foundation** (monorepo, strict TypeScript, ESLint and Prettier configuration, CI
  workflow): implemented, unverified. The workflow's YAML parses.
- **Authentication** (Argon2id, hashed server-side sessions, cookie attributes, login rate limits,
  Origin checks): implemented, unverified. The integration tests have not run.
- **Boards, dashboard and pagination**: implemented, unverified.
- **Sharing, roles and live access changes**: implemented, unverified. The bypass tests (sending protocol
  messages as a viewer, and similar) are written, not run.
- **Canvas editor** (pan and zoom, shapes, text, transforms, clipboard, layer order, undo and redo):
  implemented, unverified. The pure geometry code is verified through the benchmark. Keyboard operation
  of the canvas is partial.
- **Real-time sync** (Yjs rooms, limits, heartbeats, persistence, compaction, revisions and restore):
  implemented, unverified. A handshake loop was found by reading the code and fixed. It was not
  reproduced by running anything.
- **Offline editing** (IndexedDB copy, offline sign-in, service worker): implemented, unverified. The
  browser tests for disconnection, reload, concurrent edits and reconnection are written, not run.
- **Import and export** (PNG, SVG, versioned JSON, regions, import as a new board): implemented,
  unverified. Text bounds for selection and region export are estimated from character count.
- **Performance**: partial. The pure canvas code is measured and equivalence-checked. Browser frame times,
  React commit counts, Yjs batching and network frame counts were not measured or changed. The document
  benchmark has not been run.
- **Presence**: implemented, unverified.
- **Deployment** (Dockerfiles, production compose, nginx, migration job, readiness, structured logs,
  environment validation): partial. The compose files are validated offline. The images have not been
  built, nginx has not been parsed, `pnpm deploy` has not run, and the migration job and readiness check
  have not executed.
- **Security review** (`docs/security.md`): implemented by reading the code. Four defects were fixed and
  the residual risks are listed. No penetration test or dependency audit has been run.
- **Accessibility and responsive layouts**: partial. The app shell has a skip link, a visible focus ring,
  reduced-motion support, and layouts for narrow screens. The sign-in and dashboard pages are covered by
  browser specs, which have not run. The canvas, board page and dialogs have not been audited.
- **Documentation**: implemented. The README, `docs/security.md`, `docs/offline.md`,
  `docs/import-export.md`, `docs/performance.md` and the other subsystem notes exist and their links
  resolve. They describe the intended behavior, which the tests have not yet confirmed.

## Requirements whose acceptance evidence is incomplete

These requirements from the original prompts are implemented in part, and the evidence for their
acceptance criteria is missing or partial. They are not described as complete anywhere else in this file.

- Sharing: enforcement is implemented on the server and the bypass tests exist, but none has run.
- Offline: the browser tests for disconnects, reloads, concurrent edits and reconnects exist but have
  not run. The viewer-downgrade case keeps in-memory changes until reload.
- Import and export: "preserve transformations" applies to position, size, end points and stacking
  order, because the object model has no rotation or flip. Text rendering uses the viewer's font.
- Performance: the target of responsive navigation and editing with at least 1,000 typical objects has
  not been demonstrated in a browser. Yjs batching and network frequency were investigated, not changed.
- Deployment: "accessible keyboard and focus behavior" and "responsive layouts" are partial. "Polished
  error states" is partial: the board error state has a retry control, and no systematic review of error
  states has been made.
- CI: the integration and browser jobs are defined, not run. They fail until the lockfile is committed.

## Prioritization

- Priority 0 (blocks everything else): steps 1 to 4.
- Priority 1 (correctness and security gaps): steps 5 to 8.
- Priority 2 (acceptance criteria that are missing): steps 9 to 11.
- Priority 3 (performance and offline quality): steps 12 to 14.
- Priority 4 (operations and supply chain): steps 15 to 18.
- Priority 5 (maintenance): step 19.

## 1. Commit the lockfile and make the CI workflow green

- **Scope:** on a networked machine, run `pnpm install` with pnpm 9.15.4 to produce `pnpm-lock.yaml`,
  commit it, then fix every failure in typecheck, lint, Prettier, the unit tests and the build until
  `pnpm check` and `pnpm build` pass locally and in the `verify` job.
- **Rationale:** the CI jobs, both Docker builds and `pnpm install --frozen-lockfile` all require the
  lockfile. Nothing else can be verified until it exists. Typecheck and Prettier have never run, so the
  number of fixes is unknown.
- **Dependencies:** none. Access to the npm registry is required.
- **Acceptance criteria:** `pnpm install --frozen-lockfile` succeeds on a clean checkout; `pnpm lint`,
  `pnpm format:check`, `pnpm typecheck`, `pnpm test` and `pnpm build` all pass; the `verify` job is green.
- **Effort:** 4 to 8 hours. This is the largest unknown. Add up to 50% if typecheck and Prettier report
  many failures.

## 2. Run the API integration tests against PostgreSQL 16

- **Scope:** run `pnpm --filter @inkroom/api exec vitest run integration` with `REQUIRE_TEST_DATABASE=true`
  and `TEST_DATABASE_URL` pointing at PostgreSQL 16. Fix failures in the 11 integration files, which cover
  auth, boards, members, revisions, imports, sync, session lifecycle, readiness and the schema.
- **Rationale:** these tests cover the authorization, persistence and sync rules that most other work
  depends on. None has run.
- **Dependencies:** step 1; a PostgreSQL 16 server.
- **Acceptance criteria:** all integration tests pass, and the run fails when the database is absent.
- **Effort:** 3 to 6 hours.

## 3. Run and stabilize the Playwright suite

- **Scope:** run the 7 browser specs against the real API and web app with PostgreSQL. Cover sign-in,
  boards, two-browser realtime sync, presence, offline editing, import and export, accessibility and
  phone-width layouts. Fix failures and remove any timing dependence.
- **Rationale:** the browser specs are the only evidence that the canvas, sync and offline behavior works
  end to end. They have never run.
- **Dependencies:** steps 1 and 2; a Chromium install via Playwright.
- **Acceptance criteria:** all specs pass three consecutive runs in CI, with no retries needed.
- **Effort:** 4 to 8 hours. The offline and reconnection specs are the most likely to need work.

## 4. Build the production images and smoke-test the stack

- **Scope:** build `apps/api/Dockerfile` and `apps/web/Dockerfile`, then run
  `docker compose -f docker-compose.prod.yml --env-file ... up -d --build --wait`. Check that `/api/ready`
  answers through nginx, sign in, open a board, edit it, and confirm the WebSocket stays open through
  nginx. Tear the stack down afterwards.
- **Rationale:** the images are the deployment artifact, and they have never been built. `pnpm deploy`
  (for the API) and the native `argon2` module in the runtime image are unverified.
- **Dependencies:** steps 1 and 2. A Docker daemon. This sandbox does not allow operating the host daemon,
  so this step must run on a CI runner or a machine the operator controls. The stack must not use host
  credentials.
- **Acceptance criteria:** both images build; the smoke test is scripted and passes in CI; the migration
  job runs before the API and exits zero; the web container becomes healthy.
- **Effort:** 4 to 6 hours.

## 5. Validate nginx and the Content Security Policy in a browser

- **Scope:** run `nginx -t` inside the web image in CI. Load the built app through the stack and check the
  browser console for Content Security Policy violations, including inline styles used by React and
  WebSocket connections under `connect-src 'self'`. Adjust the policy only as far as needed.
- **Rationale:** the CSP is a strict policy written without a browser. A violation would break the canvas
  or realtime sync in production while passing every other check.
- **Dependencies:** step 4.
- **Acceptance criteria:** `nginx -t` passes in CI; the smoke test records no CSP violation; the WebSocket
  connects through nginx.
- **Effort:** 2 to 3 hours.

## 6. Close the write window for revoked and expired sessions

- **Scope:** check the session of an open connection before each accepted write, using a short-lived cache
  of session status (for example, five seconds). Keep the periodic access check as the backstop.
- **Rationale:** `docs/security.md` records that a session ended in another process can write for up to
  30 seconds, because writes check membership and not the session. Sign-out in the same process is
  immediate. The window is small but it is a real gap in a security boundary.
- **Dependencies:** step 2 (the tests for session lifecycle must pass first).
- **Acceptance criteria:** an integration test shows that a write from a session revoked elsewhere is
  refused within one second; the cache is bounded and tested; `docs/security.md` is updated.
- **Effort:** 4 to 6 hours.

## 7. Share rate limits and connection counts across API processes

- **Scope:** move the login failure counters and the per-user connection budget into a shared store. Use
  PostgreSQL first, because it adds no service. Redis would need an architecture decision.
- **Rationale:** the limits are kept in memory per process, so each added process multiplies them. The
  per-address sign-in limit is also the only protection against credential guessing at scale.
- **Dependencies:** steps 2 and 6.
- **Acceptance criteria:** two API processes enforce one shared sign-in limit, shown by an integration
  test; the decision (PostgreSQL or Redis) is recorded in `docs/`; the per-user connection limit holds
  across processes.
- **Effort:** 8 to 12 hours, plus a day for the store decision if Redis is chosen.

## 8. Harden registration and account recovery

- **Scope:** add an application-level per-address limit to registration. Add email verification and
  password reset with single-use, expiring tokens. Choose an email provider first.
- **Rationale:** registration is limited only at nginx, and there is no recovery path. Both are standard
  expectations for a public account system.
- **Dependencies:** step 7 for shared limits; an email provider decision, which the user must make.
- **Acceptance criteria:** registration returns `429` above the limit, tested; a verification or reset
  token works once and expires; the flows have browser tests.
- **Effort:** 12 to 20 hours, excluding provider setup.

## 9. Make the canvas, board page and dialogs keyboard-operable and audited

- **Scope:** provide keyboard selection, movement, resizing, deletion, undo and export on the canvas. Add
  focus management to the export and sharing panels (focus moves in on open and returns on close). Run an
  automated accessibility scan (adding `@axe-core/playwright` requires a justification in the commit) on
  sign-in, the dashboard, the board page and each panel.
- **Rationale:** keyboard operation of the whiteboard is currently partial, and the requirement for
  accessible focus behavior is not met for the canvas.
- **Dependencies:** step 3 (the browser suite must run first).
- **Acceptance criteria:** every canvas action listed in scope can be done without a pointer, tested in
  Playwright; the scan reports no serious or critical violations on the listed pages; the focus order is
  tested for the two panels.
- **Effort:** 16 to 28 hours.

## 10. Make the board page usable on phones

- **Scope:** check the board page at 375 by 667 pixels, including the toolbar, the status and the members
  list. Support touch pan and pinch zoom in the canvas. Add browser tests with touch emulation.
- **Rationale:** the responsive layouts cover only the shell, the sign-in page and the dashboard. The
  whiteboard is the core feature, and it has not been checked at phone width.
- **Dependencies:** step 3.
- **Acceptance criteria:** no horizontal overflow on the board page at 375 pixels; touch pan and pinch zoom
  are covered by a passing browser test; the toolbar remains operable.
- **Effort:** 8 to 14 hours.

## 11. Measure performance in a browser and reduce per-move work

- **Scope:** create a browser benchmark with a fixed 1,000-object board. Measure drag frame time, React
  commit counts per pointer move (React Profiler) and Yjs frames per 60-move drag, before and after. Then
  coalesce pointer moves to one editor action per animation frame, and batch the Yjs transactions for each
  frame.
- **Rationale:** the pure canvas code is measured, but the target of responsive editing at 1,000 objects
  has not been demonstrated in a browser. The current code sends one Yjs update and one network frame per
  pointer move, so a 60-move drag produces 60 frames (the document benchmark prints this count, and it has
  not run).
- **Dependencies:** step 3 (the browser suite gives the regression coverage) and step 2 (for the document
  benchmark).
- **Acceptance criteria:** raw before and after numbers for the listed metrics are recorded in
  `docs/performance.md`; a drag produces fewer frames than moves, with the final state unchanged in the
  browser tests; no user-visible behavior changes in the existing specs.
- **Effort:** 16 to 24 hours.

## 12. Make hit testing and per-move diffing cheaper

- **Scope:** add the bounds pre-check that pens already have to rectangles, lines and arrows, and measure the
  cost of `diffDocuments`, which runs on every change to the object list. Cache the scene plan per viewport
  if the measurement shows it is worth it.
- **Rationale:** picking costs about 0.17 milliseconds per click at 5,000 objects and scales linearly. The
  cost of `diffDocuments` has never been measured.
- **Dependencies:** step 11 (measure before changing).
- **Acceptance criteria:** an equivalence test shows that picks return the same objects before and after;
  the pick and diff costs are measured at 1,000 and 5,000 objects and recorded; no regression in the
  geometry benchmark.
- **Effort:** 4 to 8 hours.

## 13. Harden offline data handling

- **Scope:** discard unsynced in-memory changes when a viewer's role is downgraded, and say so to the user.
  Warn before sign-out when the device has unsynced changes. Decide whether to encrypt the local copy, and
  document the trade-off (a key stored in the same browser profile protects little). Run the offline browser
  specs until they are stable.
- **Rationale:** the viewer-downgrade case keeps changes that will never sync, and sign-out deletes unsynced
  changes without warning.
- **Dependencies:** step 3.
- **Acceptance criteria:** a browser test shows the discard and the message for a downgrade; a browser test
  shows the sign-out warning; the encryption decision is recorded; the offline specs pass three runs in a
  row.
- **Effort:** 10 to 16 hours.

## 14. Make text and image export faithful

- **Scope:** measure text with the canvas `measureText` API for selection bounds and region export, instead
  of estimating from character count. Add snapshot tests for PNG and SVG output of a representative board,
  including a case where glyphs are wider than the estimate.
- **Rationale:** a text object at the edge of a region can be included or left out incorrectly, and the
  current estimate can undercut wide glyphs. Export is a stated requirement, so its fidelity matters.
- **Dependencies:** step 3.
- **Acceptance criteria:** region export includes or excludes a text object at the boundary exactly as the
  rendered bounds do; snapshot tests pass; the known limitation in `docs/import-export.md` is removed or
  narrowed.
- **Effort:** 8 to 12 hours.

## 15. Automate backups and rehearse restores

- **Scope:** schedule `pg_dump` in the custom format with a retention policy, store the copies off the host
  in encrypted storage, and script a restore drill that runs against a separate stack.
- **Rationale:** the backup and restore steps in the README are manual and have never been run. A backup
  that has not been restored is not known to work.
- **Dependencies:** step 4.
- **Acceptance criteria:** a scheduled job produces a dump and applies retention; the restore drill runs on
  a separate stack and the restored data passes an integrity check; the drill's result is recorded.
- **Effort:** 6 to 10 hours.

## 16. Add operational observability

- **Scope:** add a request ID to every request and to the sync frames that a request opens. Expose metrics
  for open connections, rooms, rate-limit rejections and readiness failures. Document how logs and metrics
  are shipped.
- **Rationale:** the logs are structured, but nothing ties a failing request to a WebSocket or a database
  error, and there are no metrics for the limits that protect the service.
- **Dependencies:** step 4.
- **Acceptance criteria:** a request ID appears in the logs for the request and the sync connection it
  opened; the metrics endpoint reports the listed values in an integration test; the shipping setup is
  documented.
- **Effort:** 10 to 16 hours.

## 17. Add supply-chain and secret-scanning gates to CI

- **Scope:** run `pnpm audit --prod` as a gate, scan the built images, scan the repository for committed
  secrets, and publish a software bill of materials as a build artifact.
- **Rationale:** the dependencies have not been audited, and the images have not been scanned. A committed
  secret would be found only by chance.
- **Dependencies:** step 1 (the lockfile is what the audit reads).
- **Acceptance criteria:** the gates run in CI and fail on a known-vulnerable test package; the bill of
  materials is attached to each run; the failure policy is written down.
- **Effort:** 6 to 10 hours.

## 18. Align the Node floor and the benchmark requirement

- **Scope:** the `engines` field says Node 22.9, but the geometry benchmark needs `module.registerHooks`,
  which arrived in Node 22.15. Align the floor, `.nvmrc` and the CI version, and make the benchmark's error
  message name the required version.
- **Rationale:** a developer on Node 22.9 gets a failure from a script with no clear cause.
- **Dependencies:** step 1.
- **Acceptance criteria:** the engines field, `.nvmrc`, the CI version and the benchmark's requirement agree;
  the benchmark fails with a message that names the version on an older Node.
- **Effort:** 1 to 2 hours.

## 19. Reconcile the documentation with the code

- **Scope:** check each document against the code after steps 1 to 18. The known drift is in
  `docs/authentication.md` (the cookie table now names the production rule), `docs/database.md` (readiness
  checks the schema), and `README.md` (the status section, which should point here).
- **Rationale:** several documents were written before the behavior they describe was finished.
- **Dependencies:** steps 1 to 18.
- **Acceptance criteria:** every statement about behavior in `docs/` and the README matches a test or a
  named check; the link check passes; the Markdown tables match Prettier's layout.
- **Effort:** 1 to 2 hours.

## Total estimate

The effort ranges add up to about 127 to 211 hours. Within that total:

- Steps 1 to 4 (priority 0): 15 to 28 hours.
- Steps 5 to 8 (priority 1): 26 to 41 hours.
- Steps 9 to 11 (priority 2): 40 to 66 hours.
- Steps 12 to 14 (priority 3): 22 to 36 hours.
- Steps 15 to 18 (priority 4): 23 to 38 hours.
- Step 19 (priority 5): 1 to 2 hours.

Assumptions:

- One engineer who knows the codebase, working on it full time.
- CI runners with Docker and a PostgreSQL service are available, and the operator can run a Docker daemon
  where the sandbox cannot.
- The email provider decision (step 8) and the store decision (step 7) are made when their steps start.
- No hardware is involved. The original requirements contain no hardware or certification work.
- Step 1 is the largest unknown. Its range assumes a moderate number of typecheck and formatting failures,
  and the contingency noted in that step covers more.
- The estimates exclude review cycles, calendar time, and architecture changes beyond the decisions named
  above.
