import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  pgEnum,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

// The SQL in drizzle/ is the source of truth for applied schema; keep this file in sync with it.
// Triggers, the updated_at function and the partial unique index are defined only in SQL.

const bytea = customType<{ data: Buffer; driverData: Buffer }>({
  dataType: () => 'bytea',
});

const primaryId = () => uuid('id').primaryKey().defaultRandom();

const timestamps = {
  createdAt: timestamp('created_at', { withTimezone: true }).defaultNow().notNull(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).defaultNow().notNull(),
};

export const boardRoleEnum = pgEnum('board_role', ['owner', 'editor', 'viewer']);
export type BoardRole = (typeof boardRoleEnum.enumValues)[number];
export type MemberRole = Exclude<BoardRole, 'owner'>;

export const users = pgTable(
  'users',
  {
    id: primaryId(),
    email: text('email').notNull(),
    displayName: text('display_name').notNull(),
    passwordHash: text('password_hash').notNull(),
    ...timestamps,
  },
  (t) => [
    unique('users_email_unique').on(t.email),
    check('users_email_lowercase', sql.raw('email = lower(email)')),
    check('users_email_not_blank', sql.raw('length(btrim(email)) > 0')),
    check('users_password_hash_not_blank', sql.raw('length(password_hash) > 0')),
    check(
      'users_display_name_length',
      sql.raw('char_length(btrim(display_name)) between 1 and 100'),
    ),
  ],
);

export const sessions = pgTable(
  'sessions',
  {
    id: primaryId(),
    userId: uuid('user_id').notNull(),
    tokenHash: text('token_hash').notNull(),
    expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
    revokedAt: timestamp('revoked_at', { withTimezone: true }),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'sessions_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    unique('sessions_token_hash_unique').on(t.tokenHash),
    index('sessions_user_id_idx').on(t.userId),
    check('sessions_token_hash_not_blank', sql.raw('length(token_hash) > 0')),
    check('sessions_expires_after_creation', sql.raw('expires_at > created_at')),
  ],
);

export const boards = pgTable(
  'boards',
  {
    id: primaryId(),
    ownerId: uuid('owner_id').notNull(),
    title: text('title').notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'boards_owner_id_fkey',
      columns: [t.ownerId],
      foreignColumns: [users.id],
    }).onDelete('restrict'),
    index('boards_owner_id_idx').on(t.ownerId),
    check('boards_title_length', sql.raw('char_length(btrim(title)) between 1 and 200')),
  ],
);

export const boardMemberships = pgTable(
  'board_memberships',
  {
    id: primaryId(),
    boardId: uuid('board_id').notNull(),
    userId: uuid('user_id').notNull(),
    role: boardRoleEnum('role').notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'board_memberships_board_id_fkey',
      columns: [t.boardId],
      foreignColumns: [boards.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'board_memberships_user_id_fkey',
      columns: [t.userId],
      foreignColumns: [users.id],
    }).onDelete('cascade'),
    unique('board_memberships_board_user_unique').on(t.boardId, t.userId),
    index('board_memberships_user_id_idx').on(t.userId),
    uniqueIndex('board_memberships_one_owner_idx')
      .on(t.boardId)
      .where(sql.raw("role = 'owner'")),
  ],
);

export const yjsDocumentUpdates = pgTable(
  'yjs_document_updates',
  {
    id: primaryId(),
    boardId: uuid('board_id').notNull(),
    seq: bigint('seq', { mode: 'number' }).generatedAlwaysAsIdentity().notNull(),
    authorId: uuid('author_id'),
    payload: bytea('payload').notNull(),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'yjs_document_updates_board_id_fkey',
      columns: [t.boardId],
      foreignColumns: [boards.id],
    }).onDelete('cascade'),
    foreignKey({
      name: 'yjs_document_updates_author_id_fkey',
      columns: [t.authorId],
      foreignColumns: [users.id],
    }).onDelete('set null'),
    unique('yjs_document_updates_seq_unique').on(t.seq),
    index('yjs_document_updates_board_seq_idx').on(t.boardId, t.seq),
    check(
      'yjs_document_updates_payload_size',
      sql.raw('octet_length(payload) between 1 and 1048576'),
    ),
  ],
);

export const boardSnapshots = pgTable(
  'board_snapshots',
  {
    id: primaryId(),
    boardId: uuid('board_id').notNull(),
    upToSeq: bigint('up_to_seq', { mode: 'number' }).notNull(),
    state: bytea('state').notNull(),
    revision: integer('revision').notNull(),
    kind: text('kind').notNull().default('compaction'),
    createdBy: uuid('created_by'),
    restoredFrom: integer('restored_from'),
    ...timestamps,
  },
  (t) => [
    foreignKey({
      name: 'board_snapshots_board_id_fkey',
      columns: [t.boardId],
      foreignColumns: [boards.id],
    }).onDelete('cascade'),
    unique('board_snapshots_board_up_to_seq_unique').on(t.boardId, t.upToSeq),
    check('board_snapshots_up_to_seq_positive', sql.raw('up_to_seq > 0')),
    check('board_snapshots_state_size', sql.raw('octet_length(state) between 1 and 16777216')),
    unique('board_snapshots_board_revision_unique').on(t.boardId, t.revision),
    check('board_snapshots_revision_positive', sql.raw('revision > 0')),
    check('board_snapshots_kind_check', sql.raw("kind IN ('compaction', 'restore')")),
    check(
      'board_snapshots_restored_from_check',
      sql.raw('(kind = \'restore\') = (restored_from IS NOT NULL)'),
    ),
    foreignKey({
      name: 'board_snapshots_created_by_fkey',
      columns: [t.createdBy],
      foreignColumns: [users.id],
    }).onDelete('set null'),
  ],
);
