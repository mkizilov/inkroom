# Database

InkRoom stores data in PostgreSQL 16 through Drizzle ORM. The schema is defined in
`apps/api/src/db/schema.ts`, and the migrations that create it are in `apps/api/drizzle/`.

## Entities

| Table                  | Purpose                                                                    |
| ---------------------- | -------------------------------------------------------------------------- |
| `users`                | Accounts. Emails are stored lower-case and are unique.                     |
| `sessions`             | Login sessions. Only a hash of the token is stored.                        |
| `boards`               | Whiteboards. Each board has one owning user.                               |
| `board_memberships`    | Who can access a board, and with which role (`owner`, `editor`, `viewer`). |
| `yjs_document_updates` | Append-only log of persisted Yjs document updates, ordered by `seq`.       |
| `board_snapshots`      | Compacted Yjs document state up to a given update sequence number.         |

All tables use UUID primary keys (`gen_random_uuid()`), and every table has `created_at` and
`updated_at` as `timestamptz`. A trigger, `set_updated_at()`, sets `updated_at` on every UPDATE,
so application code does not need to maintain it.

## Relationships

```
users 1──* sessions
users 1──* boards              (boards.owner_id)
boards 1──* board_memberships  ──* users
boards 1──* yjs_document_updates ──? users   (author_id, nullable)
boards 1──* board_snapshots
```

## Roles and ownership rules

- `owner`: exactly one per board, enforced by a partial unique index on
  `board_memberships (board_id) WHERE role = 'owner'`.
- `editor` and `viewer`: any number per board.
- `boards.owner_id` names the owning user, and that user also has an `owner` membership row.
  `createBoard` writes both in one transaction. Nothing in SQL enforces that they agree, so
  always create boards through `createBoard`.
- The repository functions `setMemberRole` and `removeMember` never touch the owner row.
  Ownership transfer is not implemented yet.

## Deletion policies

| Parent deleted             | Child effect                                                                             |
| -------------------------- | ---------------------------------------------------------------------------------------- |
| `users`                    | `sessions` and `board_memberships` are deleted (cascade).                                |
| `users` (owner of a board) | Blocked (`RESTRICT`). Delete or transfer the board first.                                |
| `users` (update author)    | `yjs_document_updates.author_id` is set to `NULL`.                                       |
| `boards`                   | `board_memberships`, `yjs_document_updates` and `board_snapshots` are deleted (cascade). |

## Constraints

- `users.email` is unique and must be lower-case and non-blank. `display_name` is 1–100 characters
  after trimming.
- `sessions.token_hash` is unique, and `expires_at` must be after `created_at`.
- `boards.title` is 1–200 characters after trimming.
- `board_memberships (board_id, user_id)` is unique.
- `yjs_document_updates.payload` is 1 byte to 1 MiB. `seq` is a unique identity column.
- `board_snapshots (board_id, up_to_seq)` is unique, `up_to_seq` is positive, and `state` is at
  most 16 MiB.

## Indexes

- `sessions (user_id)`, `boards (owner_id)`, `board_memberships (user_id)`
- `yjs_document_updates (board_id, seq)`: the catch-up read path
- Unique indexes implied by the constraints above

## Migrations

Migrations are versioned SQL files in `apps/api/drizzle/`, listed in
`apps/api/drizzle/meta/_journal.json`. The first migration is `0000_initial_schema`.

Local workflow (from the repository root):

```sh
cp .env.example .env     # first time only
pnpm db:up               # start PostgreSQL and wait until it is healthy
pnpm db:migrate          # apply pending migrations
pnpm db:seed             # optional: demo users, board and update (safe to re-run)
pnpm db:down             # stop the database
```

To change the schema:

1. Edit `apps/api/src/db/schema.ts`.
2. Run `pnpm db:generate` to produce a new migration in `apps/api/drizzle/`.
3. Review the generated SQL. Add triggers, partial indexes or other SQL-only objects by hand
   to the migration, and keep the Drizzle schema consistent with the SQL.
4. Run `pnpm db:migrate` and `pnpm --filter @inkroom/api test`.
5. Commit the schema change, the migration and the updated journal together.

Do not edit or reorder migrations that have been applied to a shared database. Add a new one.

## Tests

Integration tests in `apps/api/src/db/*.integration.test.ts` need `TEST_DATABASE_URL`. Each test
file creates its own `inkroom_test_*` schema, applies the migrations to it, and drops it at the
end, so the tests do not touch application data. They are skipped when `TEST_DATABASE_URL` is not
set. CI sets it and runs them against a PostgreSQL service container.

## Known gaps

- `apps/api/drizzle/meta/` has no snapshot for `0000_initial_schema`, because the initial
  migration was written by hand. Before relying on `pnpm db:generate`, run it once on a machine
  with dependencies installed. It should report no changes. If it proposes a migration, the
  schema and the SQL have drifted, and that must be fixed before merging.
- Yjs update compaction (folding updates into snapshots and deleting the folded updates) is not
  implemented. Snapshots reference an update sequence number but have no foreign key to it, so
  pruning will need an explicit rule.
- Session expiry cleanup and ownership transfer are not implemented.
