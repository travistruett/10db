DROP TABLE `flows`;--> statement-breakpoint
DROP TABLE `patterns`;--> statement-breakpoint
DROP TABLE `role_settings`;--> statement-breakpoint
DROP TABLE `team_bindings`;--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`gate_command` text,
	`changed_check_command` text,
	`precheck_command` text,
	`areas` text NOT NULL,
	`hazards` text NOT NULL,
	`max_lanes` integer NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`moved_from_account_id` text,
	`move_back_at` text,
	`move_back_automatic` integer DEFAULT false NOT NULL,
	`fallback_account_id` text,
	`usage_handoff_at` real DEFAULT 0.95 NOT NULL,
	`sandbox_loopback` integer DEFAULT false NOT NULL,
	`sandbox_docker` integer DEFAULT false NOT NULL,
	`sandbox_docker_opt_out` integer DEFAULT false NOT NULL,
	`handoff_pct` integer NOT NULL,
	`nudge_pct` integer NOT NULL,
	`human_wait_minutes` integer NOT NULL,
	`default_rigor` text DEFAULT 'standard' NOT NULL,
	`budget_ceiling` real,
	`delivery` text DEFAULT 'local' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`landing` text DEFAULT 'merge' NOT NULL,
	`landing_branch` text,
	`pr_title_prefix` text,
	`pr_pictures` integer DEFAULT false NOT NULL,
	`allowed_commands` text DEFAULT '[]' NOT NULL,
	`workspace_mode` text DEFAULT 'shared' NOT NULL,
	`worktree_seed` text DEFAULT '["node_modules"]' NOT NULL,
	`isolate` text DEFAULT '["migrations","deps"]' NOT NULL,
	`app_url` text,
	`dev_login_command` text,
	`preview_command` text,
	`screens` text DEFAULT '{"viewports":[{"width":1440,"height":900}],"themes":["default"]}' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`moved_from_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`fallback_account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_projects`("id", "name", "repo_path", "gate_command", "changed_check_command", "precheck_command", "areas", "hazards", "max_lanes", "provider", "account_id", "moved_from_account_id", "move_back_at", "move_back_automatic", "fallback_account_id", "usage_handoff_at", "sandbox_loopback", "sandbox_docker", "sandbox_docker_opt_out", "handoff_pct", "nudge_pct", "human_wait_minutes", "default_rigor", "budget_ceiling", "delivery", "base_branch", "landing", "landing_branch", "pr_title_prefix", "pr_pictures", "allowed_commands", "workspace_mode", "worktree_seed", "isolate", "app_url", "dev_login_command", "preview_command", "screens", "created_at", "updated_at") SELECT "id", "name", "repo_path", "gate_command", "changed_check_command", "precheck_command", "areas", "hazards", "max_lanes", "provider", "account_id", "moved_from_account_id", "move_back_at", "move_back_automatic", "fallback_account_id", "usage_handoff_at", "sandbox_loopback", "sandbox_docker", "sandbox_docker_opt_out", "handoff_pct", "nudge_pct", "human_wait_minutes", "default_rigor", "budget_ceiling", "delivery", "base_branch", "landing", "landing_branch", "pr_title_prefix", "pr_pictures", "allowed_commands", "workspace_mode", "worktree_seed", "isolate", "app_url", "dev_login_command", "preview_command", "screens", "created_at", "updated_at" FROM `projects`;--> statement-breakpoint
DROP TABLE `projects`;--> statement-breakpoint
ALTER TABLE `__new_projects` RENAME TO `projects`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_unique` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE TABLE `__new_tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`headline` text DEFAULT '' NOT NULL,
	`why` text DEFAULT '' NOT NULL,
	`description` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`areas` text NOT NULL,
	`rigor` text,
	`rigor_source` text,
	`rigor_reason` text,
	`kinds` text DEFAULT '[]' NOT NULL,
	`kinds_off` text DEFAULT '[]' NOT NULL,
	`sized_for` text,
	`sizing_owed_for` text,
	`sizing_calls` text DEFAULT '{"rigor":null,"kinds":{}}' NOT NULL,
	`effort_pin` text,
	`proposal_id` text,
	`landing` text DEFAULT 'base' NOT NULL,
	`landing_branch` text,
	`status` text NOT NULL,
	`board_order` real NOT NULL,
	`board_column_id` text,
	`workspace_mode` text NOT NULL,
	`placement_reason` text,
	`goal_id` text,
	`landing_group_id` text,
	`model_setting` text,
	`pass_id` text,
	`kept_work_sha` text,
	`kept_base_sha` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`board_column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`landing_group_id`) REFERENCES `landing_groups`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_tasks`("id", "project_id", "title", "headline", "why", "description", "acceptance_criteria", "areas", "rigor", "rigor_source", "rigor_reason", "kinds", "kinds_off", "sized_for", "sizing_owed_for", "sizing_calls", "effort_pin", "proposal_id", "landing", "landing_branch", "status", "board_order", "board_column_id", "workspace_mode", "placement_reason", "goal_id", "landing_group_id", "model_setting", "pass_id", "kept_work_sha", "kept_base_sha", "created_at", "updated_at") SELECT "id", "project_id", "title", "headline", "why", "description", "acceptance_criteria", "areas", "rigor", "rigor_source", "rigor_reason", "kinds", "kinds_off", "sized_for", "sizing_owed_for", "sizing_calls", "effort_pin", "proposal_id", "landing", "landing_branch", "status", "board_order", "board_column_id", "workspace_mode", "placement_reason", "goal_id", "landing_group_id", "model_setting", "pass_id", "kept_work_sha", "kept_base_sha", "created_at", "updated_at" FROM `tasks`;--> statement-breakpoint
DROP TABLE `tasks`;--> statement-breakpoint
ALTER TABLE `__new_tasks` RENAME TO `tasks`;--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE INDEX `tasks_goal_idx` ON `tasks` (`goal_id`);--> statement-breakpoint
CREATE INDEX `tasks_landing_group_idx` ON `tasks` (`landing_group_id`);--> statement-breakpoint
ALTER TABLE `personas` DROP COLUMN `minimum_score`;--> statement-breakpoint
ALTER TABLE `personas` DROP COLUMN `model_pin`;