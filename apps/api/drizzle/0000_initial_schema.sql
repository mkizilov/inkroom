CREATE TYPE board_role AS ENUM ('owner', 'editor', 'viewer');
--> statement-breakpoint
CREATE TABLE users (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	email text NOT NULL,
	display_name text NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT users_email_unique UNIQUE (email),
	CONSTRAINT users_email_lowercase CHECK (email = lower(email)),
	CONSTRAINT users_email_not_blank CHECK (length(btrim(email)) > 0),
	CONSTRAINT users_display_name_length CHECK (char_length(btrim(display_name)) between 1 and 100)
);
--> statement-breakpoint
CREATE TABLE sessions (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	user_id uuid NOT NULL,
	token_hash text NOT NULL,
	expires_at timestamp with time zone NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT sessions_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE cascade,
	CONSTRAINT sessions_token_hash_unique UNIQUE (token_hash),
	CONSTRAINT sessions_token_hash_not_blank CHECK (length(token_hash) > 0),
	CONSTRAINT sessions_expires_after_creation CHECK (expires_at > created_at)
);
--> statement-breakpoint
CREATE INDEX sessions_user_id_idx ON sessions (user_id);
--> statement-breakpoint
CREATE TABLE boards (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	owner_id uuid NOT NULL,
	title text NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT boards_owner_id_fkey FOREIGN KEY (owner_id) REFERENCES users(id) ON DELETE restrict,
	CONSTRAINT boards_title_length CHECK (char_length(btrim(title)) between 1 and 200)
);
--> statement-breakpoint
CREATE INDEX boards_owner_id_idx ON boards (owner_id);
--> statement-breakpoint
CREATE TABLE board_memberships (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	board_id uuid NOT NULL,
	user_id uuid NOT NULL,
	role board_role NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT board_memberships_board_id_fkey FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE cascade,
	CONSTRAINT board_memberships_user_id_fkey FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE cascade,
	CONSTRAINT board_memberships_board_user_unique UNIQUE (board_id, user_id)
);
--> statement-breakpoint
CREATE INDEX board_memberships_user_id_idx ON board_memberships (user_id);
--> statement-breakpoint
CREATE UNIQUE INDEX board_memberships_one_owner_idx ON board_memberships (board_id) WHERE role = 'owner';
--> statement-breakpoint
CREATE TABLE yjs_document_updates (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	board_id uuid NOT NULL,
	seq bigint GENERATED ALWAYS AS IDENTITY NOT NULL,
	author_id uuid,
	payload bytea NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT yjs_document_updates_board_id_fkey FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE cascade,
	CONSTRAINT yjs_document_updates_author_id_fkey FOREIGN KEY (author_id) REFERENCES users(id) ON DELETE set null,
	CONSTRAINT yjs_document_updates_seq_unique UNIQUE (seq),
	CONSTRAINT yjs_document_updates_payload_size CHECK (octet_length(payload) between 1 and 1048576)
);
--> statement-breakpoint
CREATE INDEX yjs_document_updates_board_seq_idx ON yjs_document_updates (board_id, seq);
--> statement-breakpoint
CREATE TABLE board_snapshots (
	id uuid DEFAULT gen_random_uuid() PRIMARY KEY NOT NULL,
	board_id uuid NOT NULL,
	up_to_seq bigint NOT NULL,
	state bytea NOT NULL,
	created_at timestamp with time zone DEFAULT now() NOT NULL,
	updated_at timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT board_snapshots_board_id_fkey FOREIGN KEY (board_id) REFERENCES boards(id) ON DELETE cascade,
	CONSTRAINT board_snapshots_board_up_to_seq_unique UNIQUE (board_id, up_to_seq),
	CONSTRAINT board_snapshots_up_to_seq_positive CHECK (up_to_seq > 0),
	CONSTRAINT board_snapshots_state_size CHECK (octet_length(state) between 1 and 16777216)
);
--> statement-breakpoint
CREATE FUNCTION set_updated_at() RETURNS trigger AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;
--> statement-breakpoint
CREATE TRIGGER users_set_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER sessions_set_updated_at BEFORE UPDATE ON sessions FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER boards_set_updated_at BEFORE UPDATE ON boards FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER board_memberships_set_updated_at BEFORE UPDATE ON board_memberships FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER yjs_document_updates_set_updated_at BEFORE UPDATE ON yjs_document_updates FOR EACH ROW EXECUTE FUNCTION set_updated_at();
--> statement-breakpoint
CREATE TRIGGER board_snapshots_set_updated_at BEFORE UPDATE ON board_snapshots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
