ALTER TABLE board_snapshots ADD COLUMN revision integer;
--> statement-breakpoint
UPDATE board_snapshots AS s
SET revision = r.rn
FROM (
  SELECT id, row_number() OVER (PARTITION BY board_id ORDER BY up_to_seq) AS rn
  FROM board_snapshots
) AS r
WHERE s.id = r.id;
--> statement-breakpoint
ALTER TABLE board_snapshots ALTER COLUMN revision SET NOT NULL;
--> statement-breakpoint
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_revision_positive CHECK (revision > 0);
--> statement-breakpoint
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_board_revision_unique UNIQUE (board_id, revision);
--> statement-breakpoint
ALTER TABLE board_snapshots ADD COLUMN kind text NOT NULL DEFAULT 'compaction';
--> statement-breakpoint
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_kind_check CHECK (kind IN ('compaction', 'restore'));
--> statement-breakpoint
ALTER TABLE board_snapshots ADD COLUMN created_by uuid;
--> statement-breakpoint
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_created_by_fkey FOREIGN KEY (created_by) REFERENCES users(id) ON DELETE set null;
--> statement-breakpoint
ALTER TABLE board_snapshots ADD COLUMN restored_from integer;
--> statement-breakpoint
ALTER TABLE board_snapshots ADD CONSTRAINT board_snapshots_restored_from_check CHECK ((kind = 'restore') = (restored_from IS NOT NULL));
