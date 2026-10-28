DROP INDEX `batches_one_unfinished`;--> statement-breakpoint
ALTER TABLE `batches` ADD `worktree_path` text;--> statement-breakpoint
CREATE UNIQUE INDEX `batches_one_unfinished` ON `batches` (`project_id`) WHERE state IN ('CUTTING', 'OPEN', 'SHIPPING', 'FAILED') AND worktree_path IS NULL;--> statement-breakpoint
ALTER TABLE `claims` ADD `scope` text DEFAULT '' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `workspace_mode` text DEFAULT 'shared' NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `worktree_seed` text DEFAULT '["node_modules"]' NOT NULL;