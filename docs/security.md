# Security review

This page records the security boundaries of InkRoom, what was reviewed, what was changed, and what
remains. The review was done by reading the code. It is not a penetration test, and no dependency
audit has been run.

## Trust boundaries

- **Browser to the edge.** A TLS-terminating reverse proxy, which the operator runs in front of the
  stack, is the only public entry point. Its address is not in the stack.
- **Edge to the web container.** nginx serves the built app and forwards `/api`. It sets security
  headers, limits sign-in, registration and sign-out attempts, and passes WebSocket upgrades through.
- **Web container to the API.** An internal Docker network (`172.28.0.0/24`). The API port is not
  published.
- **API to PostgreSQL.** The same internal network. The database port is not published.

## Authentication

- Passwords are hashed with Argon2id at the OWASP minimum parameters. For unknown emails, a
  placeholder hash is verified too, so response times do not reveal which accounts exist.
- Sessions use 256-bit random tokens. Only the SHA-256 hash of a token is stored. A session lasts
  seven days and is revoked on sign-out.
- The session cookie is `HttpOnly` and `SameSite=Lax`. In production it is `Secure`, and named with the
  `__Host-` prefix, which requires `Path=/` and no `Domain`. Production refuses `COOKIE_SECURE=false`.
- Sign-in is rate-limited by email (5 failures per 15 minutes) and by client address (20 failures per
  15 minutes). nginx also limits non-GET requests under `/api/auth/` to 20 per minute per address.
- Registration is limited only by nginx. Registration responses reveal whether an email is taken,
  which is the usual trade-off for a sign-up form.

## Authorization

- Board, member, revision and sync routes check the caller's membership and role on every request. A
  non-member gets the same answer as for a board that does not exist.
- Membership and role changes are enforced in the database as well. Each stored update re-reads the
  writer's role inside the transaction that holds the board lock.
- Only owners manage membership. Ownership cannot be granted, moved or removed through the API.

## Request boundary

- Every state-changing API request must carry an `Origin` header that exactly matches `WEB_ORIGIN`.
  The WebSocket upgrade applies the same rule.
- Request bodies are validated with schemas. Import files are limited to 8 MB at nginx and in the API.
- Unexpected errors return a generic 500 response. Stack traces are logged, not sent to clients.
- nginx sends `X-Content-Type-Options`, `X-Frame-Options: DENY`, a strict `Referrer-Policy`, a
  `Permissions-Policy`, and a `Content-Security-Policy` that allows only same-origin scripts and styles
  (plus inline styles, which React needs).

## WebSocket lifecycle

- A socket is authenticated and origin-checked during the upgrade. Frames must be binary and are size
  limited. Each connection is pinged and dropped when it stops answering. Per-user and per-board
  connection counts are limited, and a stalled socket is dropped.
- A socket's session is re-checked: a sign-out closes that session's sockets at once, and the
  periodic 30-second check closes sockets whose session was revoked or has expired.

## Logging

- Logs are JSON lines, with a level set by `LOG_LEVEL`.
- The `cookie` and `authorization` request headers are censored in request logs.
- Request and response bodies are not logged. Passwords and session tokens never reach the logs.

## Findings fixed in this review

- **Open sockets outlived their sessions.** A socket was authorized once, at upgrade. Signing out, or a
  session expiring, did not close it. Sign-out now closes the session's sockets at once, and the
  periodic check closes the rest.
- **One client could lock out everyone.** Behind nginx, every request reached the API from nginx's
  address, so the per-address sign-in limit applied to the whole deployment. The API now trusts
  `X-Forwarded-For` only from the addresses in `TRUST_PROXY`, which the production stack pins to its
  internal subnet.
- **Production accepted development defaults.** `WEB_ORIGIN` fell back to the development origin, and
  `COOKIE_SECURE=false` was allowed in production. Production now requires an explicit `https://`
  origin and refuses insecure cookies.
- **The production bundle could not run.** The shared package is consumed as TypeScript source, and
  the server bundle left it external. The build now inlines workspace packages.
- **A configuration test had never passed.** Its expectation did not match the configuration the code
  returns. The expectation was corrected, and the production rules are now tested.
- **Readiness did not check the schema.** `/api/ready` now also requires every shipped migration to be
  applied, so traffic is not sent to an API whose database is behind.

## Residual risks

- Rate limits and connection counts are kept in memory, per process. Running several API processes
  multiplies the limits, and a shared store would be needed to enforce them globally.
- A session that ends in another process can still write for up to the 30-second access-check
  interval, because writes check membership but not the session. Sign-out in the same process is
  immediate.
- nginx limits registration only per address. Behind a shared proxy, that address may need its real
  client address restored (see the deployment notes in the README).
- Sign-in and registration are the only protections against credential guessing beyond the limits
  above. There is no email verification, password reset or multi-factor authentication.
- Data at rest is not encrypted by the application. Use an encrypted volume or disk.
- Backups contain every board and every password hash. Store and restrict them like the database.
- Demo accounts with a known password exist only in development. `pnpm db:seed` refuses to run when
  `NODE_ENV=production`.
- The offline copy keeps the signed-in user's id, email and display name in the browser's local
  storage, so that a board opens without a connection. Signing out removes it. On a shared device,
  sign out before leaving it.
- Dependencies have not been audited in this environment. Run `pnpm audit` on a networked machine
  before a release.
