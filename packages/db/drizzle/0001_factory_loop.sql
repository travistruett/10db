CREATE TABLE `claims` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`kind` text NOT NULL,
	`name` text NOT NULL,
	`exclusive` integer NOT NULL,
	`lease_expires_at` text NOT NULL,
	`released_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `claims_active_unique` ON `claims` (`project_id`,`kind`,`name`) WHERE released_at IS NULL;--> statement-breakpoint
CREATE INDEX `claims_workstream_idx` ON `claims` (`workstream_id`);--> statement-breakpoint
CREATE TABLE `decisions` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`question` text NOT NULL,
	`choice` text NOT NULL,
	`rationale` text NOT NULL,
	`decided_by` text NOT NULL,
	`scope` text NOT NULL,
	`area` text,
	`supersedes_id` text,
	`source_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `deviations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workstream_id` text,
	`cause` text NOT NULL,
	`severity` text NOT NULL,
	`signed_reason` text NOT NULL,
	`resolution` text,
	`source_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `events` (
	`seq` integer PRIMARY KEY AUTOINCREMENT NOT NULL,
	`type` text NOT NULL,
	`entity_type` text NOT NULL,
	`entity_id` text NOT NULL,
	`data` text NOT NULL,
	`at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `evidence` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`kind` text NOT NULL,
	`command` text NOT NULL,
	`exit_code` integer NOT NULL,
	`summary` text NOT NULL,
	`log_path` text,
	`commit_shas` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `handoffs` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`session_id` text NOT NULL,
	`content` text NOT NULL,
	`git_head` text NOT NULL,
	`git_changed_files` text NOT NULL,
	`git_commits` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `inbox_items` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`options` text NOT NULL,
	`recommendation` text,
	`category` text NOT NULL,
	`urgency` text NOT NULL,
	`assignee` text NOT NULL,
	`detail` text,
	`answer` text,
	`fold_key` text,
	`targets` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `inbox_state_idx` ON `inbox_items` (`state`);--> statement-breakpoint
CREATE INDEX `inbox_fold_idx` ON `inbox_items` (`project_id`,`fold_key`);--> statement-breakpoint
CREATE TABLE `permission_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`workstream_id` text,
	`tool_name` text NOT NULL,
	`pattern` text,
	`source_inbox_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`gate_command` text NOT NULL,
	`areas` text NOT NULL,
	`hazards` text NOT NULL,
	`max_lanes` integer NOT NULL,
	`provider` text NOT NULL,
	`billing_mode` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`handoff_pct` integer NOT NULL,
	`nudge_pct` integer NOT NULL,
	`human_wait_minutes` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `projects_repo_path_unique` ON `projects` (`repo_path`);--> statement-breakpoint
CREATE TABLE `proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`status` text NOT NULL,
	`rationale` text,
	`source_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`mode` text NOT NULL,
	`mcp_token_hash` text NOT NULL,
	`pid` integer,
	`pid_start` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`exit_reason` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cost_usd` real NOT NULL,
	`context_pct` real,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_mcp_token_hash_unique` ON `sessions` (`mcp_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_workstream_idx` ON `sessions` (`workstream_id`);--> statement-breakpoint
CREATE TABLE `sources` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`ref` text NOT NULL,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `task_deps` (
	`task_id` text NOT NULL,
	`depends_on_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `depends_on_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`depends_on_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `tasks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`description` text NOT NULL,
	`acceptance_criteria` text NOT NULL,
	`areas` text NOT NULL,
	`status` text NOT NULL,
	`board_order` real NOT NULL,
	`workspace_mode` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `tool_ops` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`session_id` text NOT NULL,
	`op_id` text NOT NULL,
	`tool` text NOT NULL,
	`result` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `tool_ops_unique` ON `tool_ops` (`workstream_id`,`op_id`);--> statement-breakpoint
CREATE TABLE `workstreams` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`state` text NOT NULL,
	`next_action` text NOT NULL,
	`attempt` integer NOT NULL,
	`recovery_attempts` integer NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`base_head` text,
	`lease_owner` text,
	`lease_expires_at` text,
	`fence` integer NOT NULL,
	`gate_pid` integer,
	`gate_pid_start` text,
	`current_session_id` text,
	`context_pct` real,
	`paused_until` text,
	`failure_reason` text,
	`last_activity_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workstreams_state_idx` ON `workstreams` (`state`);--> statement-breakpoint
CREATE INDEX `workstreams_task_idx` ON `workstreams` (`task_id`);