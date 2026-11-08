ALTER TABLE users ADD COLUMN password_hash text NOT NULL;
--> statement-breakpoint
ALTER TABLE users ADD CONSTRAINT users_password_hash_not_blank CHECK (length(password_hash) > 0);
--> statement-breakpoint
ALTER TABLE sessions ADD COLUMN revoked_at timestamp with time zone;
