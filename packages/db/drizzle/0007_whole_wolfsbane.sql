PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`kind` text NOT NULL,
	`command` text,
	`exit_code` integer,
	`summary` text NOT NULL,
	`log_path` text,
	`commit_shas` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_evidence`("id", "workstream_id", "kind", "command", "exit_code", "summary", "log_path", "commit_shas", "created_at") SELECT "id", "workstream_id", "kind", "command", "exit_code", "summary", "log_path", "commit_shas", "created_at" FROM `evidence`;--> statement-breakpoint
DROP TABLE `evidence`;--> statement-breakpoint
ALTER TABLE `__new_evidence` RENAME TO `evidence`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`gate_command` text,
	`areas` text NOT NULL,
	`hazards` text NOT NULL,
	`max_lanes` integer NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`moved_from_account_id` text,
	`move_back_at` text,
	`fallback_account_id` text,
	`usage_handoff_at` real DEFAULT 0.95 NOT NULL,
	`sandbox_loopback` integer DEFAULT false NOT NULL,
	`handoff_pct` integer NOT NULL,
	`nudge_pct` integer NOT NULL,
	`human_wait_minutes` integer NOT NULL,
	`flow_id` text,
	`budget_ceiling` real,
	`delivery` text DEFAULT 'local' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`pr_title_prefix` text,
	`allowed_commands` text DEFAULT '[]' NOT NULL,
	`workspace_mode` text DEFAULT 'shared' NOT NULL,
	`worktree_seed` text DEFAULT '["node_modules"]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moved_from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fallback_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "repo_path", "gate_command", "areas", "hazards", "max_lanes", "provider", "account_id", "moved_from_account_id", "move_back_at", "fallback_account_id", "usage_handoff_at", "sandbox_loopback", "handoff_pct", "nudge_pct", "human_wait_minutes", "flow_id", "budget_ceiling", "delivery", "base_branch", "pr_title_prefix", "allowed_commands", "workspace_mode", "worktree_seed", "created_at", "updated_at") SELECT "id", "name", "repo_path", "gate_command", "areas", "hazards", "max_lanes", "provider", "account_id", "moved_from_account_id", "move_back_at", "fallback_account_id", "usage_handoff_at", "sandbox_loopback", "handoff_pct", "nudge_pct", "human_wait_minutes", "flow_id", "budget_ceiling", "delivery", "base_branch", "pr_title_prefix", "allowed_commands", "workspace_mode", "worktree_seed", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_unique` ON `projects` (`repo_path`);