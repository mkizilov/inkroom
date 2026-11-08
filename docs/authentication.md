# Authentication

InkRoom uses email and password accounts with server-side sessions. OAuth and social sign-in are
not supported.

## Endpoints

All responses are JSON. Errors use one shape:

```json
{ "error": { "code": "invalid_credentials", "message": "Email or password is incorrect." } }
```

Validation errors add `details: [{ "field": "password", "message": "..." }]`.

| Method | Path                 | Auth   | Success                           | Error codes                                                            |
| ------ | -------------------- | ------ | --------------------------------- | ---------------------------------------------------------------------- |
| POST   | `/api/auth/register` | none   | `201` `{ user }` + session cookie | `validation_failed` 400, `email_taken` 409                             |
| POST   | `/api/auth/login`    | none   | `200` `{ user }` + session cookie | `validation_failed` 400, `invalid_credentials` 401, `rate_limited` 429 |
| POST   | `/api/auth/logout`   | cookie | `204`, cookie cleared             | `csrf_origin_rejected` 403                                             |
| GET    | `/api/auth/me`       | cookie | `200` `{ user }`                  | `unauthenticated` 401, `session_expired` 401, `session_revoked` 401    |

Any unknown route returns `404` with code `not_found`. Malformed JSON returns `400` with code
`invalid_request`. Unexpected failures return `500` with code `internal_error` and log the cause on
the server only.

`user` is `{ id, email, displayName }`. Emails are stored and compared in lower case.

## Passwords

- Hashed with Argon2id (`argon2` package): 19 MiB memory, 2 iterations, 1 lane.
- Length 12 to 128 characters at registration. Login accepts any length from 1 to 128 so that
  existing accounts are never locked out by a later policy change.
- Unknown emails run a full Argon2 verification against a placeholder hash, so response time does
  not reveal whether an account exists. Wrong-password and unknown-email responses are identical.

## Sessions

- The session token is 32 random bytes, base64url-encoded. The database stores only its SHA-256
  hash (`sessions.token_hash`).
- Sessions last seven days from creation (`SESSION_TTL_MS`). Expired and revoked rows are kept, and
  the middleware distinguishes them with `session_expired` and `session_revoked`.
- Logout sets `sessions.revoked_at`. A revoked token can never authenticate again.
- Registration and login both create a new session. There is no session refresh.
- Automatic deletion of expired sessions is not implemented.

## Cookies

| Attribute  | Value                                                               | Why                                               |
| ---------- | ------------------------------------------------------------------- | ------------------------------------------------- |
| Name       | `inkroom_session`, or `__Host-inkroom_session` when secure          | `__Host-` forces Secure, `Path=/` and no `Domain` |
| `HttpOnly` | always                                                              | page scripts cannot read the token                |
| `Secure`   | production by default; `COOKIE_SECURE` overrides outside production | cookie is sent only over HTTPS                    |
| `SameSite` | `Lax`                                                               | cross-site POST requests do not carry the cookie  |
| `Path`     | `/`                                                                 |                                                   |
| `Max-Age`  | 604800 (seven days)                                                 |                                                   |

Local development runs over plain HTTP, so `Secure` is off there. Browsers reject `Secure`
cookies over HTTP, so the `__Host-` prefix is used only when cookies are secure.

## CSRF and origin checks

Every non-GET request under `/api/` must send an `Origin` header equal to `WEB_ORIGIN`. Requests
without the header, or with another origin, get `403 csrf_origin_rejected`. Browsers send `Origin`
on cross-site requests and on same-origin `fetch` POSTs, so this protects cookie-authenticated
writes. `SameSite=Lax` is the second layer.

Non-browser clients must send `Origin` set to `WEB_ORIGIN` to call mutating endpoints.

## Rate limiting

Failed logins are counted in two fixed windows of 15 minutes:

- per normalized email: 5 failures, then `429 rate_limited` with `Retry-After` for that email;
- per client IP address: 20 failures.

A successful login clears the email counter. A blocked request is rejected before the password is
checked, so it costs no Argon2 time.

Limits are in memory. They reset on restart, are not shared between API instances, and use the
socket address (`trustProxy` is not enabled). Behind a reverse proxy, the IP limit applies to the
proxy address until trusted proxy handling is added.

## Middleware

`requireUser` (in `apps/api/src/auth/routes.ts`) runs as a `preHandler`. It reads the cookie,
validates the token format, resolves the session, and sets `request.currentUser`. New protected
routes should use the same pattern.

## Web client

- `AuthProvider` calls `GET /api/auth/me` on load to determine the session state.
- `RequireAuth` redirects anonymous visitors to `/login` and returns them to their original page
  after sign-in. Only same-site paths are accepted as return targets.
- Forms validate with the same zod schemas as the API, show field-level errors, disable inputs and
  show a progress label while a request is in flight, and map error codes to plain-language
  messages.

## Development

- Demo accounts from `pnpm db:seed` use the password `demo-password-123`. The seed refuses to run
  when `NODE_ENV=production`.
- The migration `0001_authentication` adds a NOT NULL `password_hash` column. It fails on a
  database that already has users, because existing rows have no password. Reset local data
  first with `docker compose down -v && pnpm db:up && pnpm db:migrate && pnpm db:seed`.

## Tests

- Unit: password hashing, cookie formatting and parsing, rate limiter windows, shared schemas.
- Integration (`apps/api/src/auth/auth.integration.test.ts`, needs `TEST_DATABASE_URL`): register,
  login, invalid credentials, rate limiting, unauthenticated and malformed cookies, expired and
  revoked sessions, logout, origin rejection, validation, duplicate email, and unknown routes.
- Web (`apps/web/src/App.test.tsx`): redirects, field validation, invalid credentials, loading
  state, and registration validation, with `fetch` mocked per request.

## Limitations

- No email verification, password reset, account lockout beyond the rate limit, or multi-factor
  authentication.
- No CSRF token. The Origin check and SameSite cookies rely on modern browsers sending `Origin`.
- Rate limit state is per process.
- Registration reveals whether an email is registered (`email_taken`). This is a deliberate
  usability trade-off; a verification-based flow would remove it.
