# Board management

Boards are the containers that a whiteboard session will later open. This stage covers creating,
listing, reading, renaming and deleting boards, plus a dashboard that does this from the browser.
Opening a board shows its title and role with an empty workspace.

All endpoints require a session cookie (see [authentication.md](authentication.md)). Errors use
the shared shape `{ "error": { "code", "message", "details"? } }`.

## Endpoints

| Method | Path                   | Minimum role       | Success                          | Error codes                                                     |
| ------ | ---------------------- | ------------------ | -------------------------------- | --------------------------------------------------------------- |
| POST   | `/api/boards`          | any signed-in user | `201` `{ board }` (role `owner`) | `validation_failed` 400                                         |
| GET    | `/api/boards`          | any member         | `200` `{ items, nextCursor }`    | `validation_failed` 400 (`limit`, `cursor`)                     |
| GET    | `/api/boards/:boardId` | viewer             | `200` `{ board }`                | `validation_failed` 400, `board_not_found` 404                  |
| PATCH  | `/api/boards/:boardId` | editor             | `200` `{ board }`                | `validation_failed` 400, `board_not_found` 404, `forbidden` 403 |
| DELETE | `/api/boards/:boardId` | owner              | `204`                            | `validation_failed` 400, `board_not_found` 404, `forbidden` 403 |

A board object is:

```json
{
  "id": "0b7c…",
  "title": "Sprint planning",
  "ownerId": "5e1a…",
  "role": "editor",
  "createdAt": "2026-01-02T09:30:00.000Z",
  "updatedAt": "2026-01-03T10:45:00.000Z"
}
```

`role` is the caller's role on that board, not the owner's.

## Roles and authorization

| Action          | owner               | editor | viewer | non-member |
| --------------- | ------------------- | ------ | ------ | ---------- |
| Create a board  | yes (becomes owner) | yes    | yes    | yes        |
| List boards     | own                 | own    | own    | n/a        |
| Read metadata   | yes                 | yes    | yes    | 404        |
| Rename          | yes                 | yes    | 403    | 404        |
| Delete          | yes                 | 403    | 403    | 404        |
| Manage members  | yes                 | 403    | 403    | 404        |
| Leave the board | no (409)            | yes    | yes    | n/a        |

- Only the owner can delete a board. The owner's membership row cannot be removed or demoted by
  the repository functions (see [database.md](database.md)).
- Non-members get `404 board_not_found`, the same as a board that does not exist. Board ids
  therefore cannot be probed for existence.
- Members who lack the role for an action get `403 forbidden`.
- Creating a board writes the board and its `owner` membership in one transaction.

Other people get access through the sharing endpoints below.

## Sharing

Owners give registered users access to a board. Each endpoint needs a session cookie and passes the
same origin check as the other writes.

| Method | Path                                   | Minimum role                          | Success            | Error codes                                                                              |
| ------ | -------------------------------------- | ------------------------------------- | ------------------ | ---------------------------------------------------------------------------------------- |
| GET    | `/api/boards/:boardId/members`         | viewer                                | `200` `{ items }`  | `board_not_found` 404                                                                    |
| POST   | `/api/boards/:boardId/members`         | owner                                 | `201` `{ member }` | `validation_failed` 400, `user_not_found` 404, `already_member` 409, `forbidden` 403     |
| PATCH  | `/api/boards/:boardId/members/:userId` | owner                                 | `200` `{ member }` | `validation_failed` 400, `member_not_found` 404, `owner_role_fixed` 409, `forbidden` 403 |
| DELETE | `/api/boards/:boardId/members/:userId` | owner, or the member themself (leave) | `204`              | `member_not_found` 404, `owner_cannot_leave` 409, `forbidden` 403                        |

- An invitation names an account by email, which is case-insensitive. An address with no account
  gets `404 user_not_found`; there are no invitations for people who have not signed up.
- Only `editor` and `viewer` can be granted. Ownership is fixed at creation: an invitation or role
  change cannot grant it, and the owner cannot be demoted, removed or leave.
- Email addresses are returned only to the owner. Other members see names and roles.
- A non-member gets `404 board_not_found` on every endpoint, the same as a missing board.
- Role changes and removals reach the people already connected to the board at once. See
  [sync.md](sync.md#changes-to-access-during-a-session).

## Listing and pagination

`GET /api/boards` returns the caller's boards, newest-modified first, with ties broken by id.

- `limit`: 1 to 100, default 20. Other values return `400`.
- `cursor`: opaque. Pass the `nextCursor` from the previous page, and take `nextCursor: null` as
  the end of the list. A malformed cursor returns `400`.

Pagination is keyset-based on `(updated_at, id)`. Boards that change between requests can move
between pages, but a board is never skipped or returned twice because of an offset shift. The sort
key is truncated to milliseconds to match the cursor, so boards with equal timestamps are ordered
by id.

## Validation

- Titles are trimmed, and must be 1 to 200 characters after trimming. Blank titles fail with the
  message `Enter a board name.` on the `title` field.
- Board ids must be UUIDs. Anything else returns `400` with field `boardId`.
- Unknown query parameters are ignored.

The title rules live in `packages/shared/src/boards.ts`, so the dashboard rejects the same input
before sending it.

## Dashboard (web)

- **Loading:** “Loading boards…” while the first page loads.
- **Error:** “Could not load your boards.” with the reason and a Try again button.
- **Empty:** a prompt to create the first board.
- **List:** each row shows the name, the caller's role, created and modified dates (as `<time>`
  elements with ISO `dateTime` values), and actions limited to what the role allows. Rename is an
  inline form. Delete asks for confirmation in the row before it sends the request.
- **Failures:** errors from an action appear in the row that started it, using the same messages
  as the API codes. Failed page loads show “Load more” as an error without losing the boards
  already shown.
- **Create:** the new board appears at the top of the list once the server accepts it.

## Tests

- `packages/shared/src/boards.test.ts`: title normalization and rules, page size and cursor
  validation, id validation.
- `apps/api/src/boards/pagination.test.ts`: cursor round trip and rejection of malformed cursors.
- `apps/api/src/boards/boards.integration.test.ts` (needs `TEST_DATABASE_URL`): creation and
  listing scoped to membership, pagination (including identical timestamps and the default page
  size), validation, metadata for each role, non-member 404s, rename and delete permissions,
  already-deleted boards, origin checks on delete, and unauthenticated access.
- `apps/api/src/boards/members.integration.test.ts` (needs `TEST_DATABASE_URL`): invitations and their
  errors, the owner-only rules, bypass attempts through each route (viewers and editors changing or
  deleting the board, cross-site invitations), who sees emails, role changes and removals taking
  effect on the next request, and leaving.
- `apps/web/src/sharing/SharingPanel.test.tsx`: owner and viewer controls, malformed addresses refused
  before any request, role changes sent to the server, and server refusals shown to the user.
- `apps/web/src/App.test.tsx`: dashboard states (loading, empty, error with retry), role-based
  actions and dates, create validation, inline rename and cancel, confirmed delete and its errors,
  load more, and opening a board.

## Limitations

- Opening a board does not load any content yet; the workspace is a placeholder.
- No board archive, duplication or restore. Delete is permanent and cascades to memberships,
  updates and snapshots.
