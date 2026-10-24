CREATE TABLE `aa_models` (
	`slug` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `accounts` (
	`id` text PRIMARY KEY NOT NULL,
	`kind` text NOT NULL,
	`label` text NOT NULL,
	`payer` text NOT NULL,
	`expected_identity` text,
	`config_dir` text,
	`secret_ref` text,
	`secret_fingerprint` text,
	`settings` text NOT NULL,
	`lane_cap` integer NOT NULL,
	`monthly_cap_usd` real,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `accounts_label_idx` ON `accounts` (`label`);--> statement-breakpoint
CREATE TABLE `app_settings` (
	`key` text PRIMARY KEY NOT NULL,
	`value` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `batches` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`branch` text,
	`base_branch` text NOT NULL,
	`base_sha` text,
	`repo` text,
	`pr_url` text,
	`gate_exit_code` integer,
	`gate_log_path` text,
	`gate_pid` integer,
	`gate_pid_start` text,
	`failure` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `batches_project_idx` ON `batches` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `batches_one_unfinished` ON `batches` (`project_id`) WHERE state IN ('CUTTING', 'OPEN', 'SHIPPING', 'FAILED');--> statement-breakpoint
CREATE TABLE `board_columns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `board_columns_name_idx` ON `board_columns` (`project_id`,`name`);--> statement-breakpoint
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
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flows_name_unique` ON `flows` (`name`);--> statement-breakpoint
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
CREATE TABLE `mcp_server_approvals` (
	`project_id` text NOT NULL,
	`server_name` text NOT NULL,
	`config_hash` text NOT NULL,
	`verdict` text NOT NULL,
	`variables` text NOT NULL,
	`source_inbox_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `server_name`, `config_hash`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `model_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`aa_slug` text,
	`intelligence` real,
	`coding` real,
	`agentic` real,
	`cost_per_task_usd` real,
	`output_tokens_per_second` real,
	`source` text NOT NULL,
	`index_version` text,
	`measured_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	`steps_run` integer DEFAULT 0 NOT NULL,
	`first_pass_steps` integer DEFAULT 0 NOT NULL,
	`escalations` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_profiles_key_idx` ON `model_profiles` (`provider`,`model`,`effort`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`is_builder` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_handle_unique` ON `people` (`handle`);--> statement-breakpoint
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
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`tools` text NOT NULL,
	`instructions` text NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`minimum_score` real,
	`model_pin` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personas_key_unique` ON `personas` (`key`);--> statement-breakpoint
CREATE TABLE `projects` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`repo_path` text NOT NULL,
	`gate_command` text NOT NULL,
	`areas` text NOT NULL,
	`hazards` text NOT NULL,
	`max_lanes` integer NOT NULL,
	`provider` text NOT NULL,
	`account_id` text NOT NULL,
	`billing_mode` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`handoff_pct` integer NOT NULL,
	`nudge_pct` integer NOT NULL,
	`human_wait_minutes` integer NOT NULL,
	`flow_id` text,
	`budget_ceiling` real,
	`delivery` text DEFAULT 'local' NOT NULL,
	`base_branch` text DEFAULT 'main' NOT NULL,
	`pr_title_prefix` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action
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
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`area` text,
	`person_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `routing_rules_project_idx` ON `routing_rules` (`project_id`);--> statement-breakpoint
CREATE TABLE `sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`account_id` text NOT NULL,
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
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`context_pct` real,
	`briefing_baseline_pct` real,
	`briefed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_mcp_token_hash_unique` ON `sessions` (`mcp_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_workstream_idx` ON `sessions` (`workstream_id`);--> statement-breakpoint
CREATE INDEX `sessions_account_started_idx` ON `sessions` (`account_id`,`started_at`);--> statement-breakpoint
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
	`risk_tags` text DEFAULT '[]' NOT NULL,
	`flow_id` text,
	`status` text NOT NULL,
	`board_order` real NOT NULL,
	`board_column_id` text,
	`workspace_mode` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`flow_id`) REFERENCES `flows`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`board_column_id`) REFERENCES `board_columns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `tasks_project_idx` ON `tasks` (`project_id`);--> statement-breakpoint
CREATE TABLE `team_bindings` (
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`persona_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `role`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`project_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `person_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
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
	`batch_id` text,
	`state` text NOT NULL,
	`next_action` text NOT NULL,
	`attempt` integer NOT NULL,
	`recovery_attempts` integer NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`steps` text DEFAULT '[]' NOT NULL,
	`step_index` integer DEFAULT 0 NOT NULL,
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
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `workstreams_state_idx` ON `workstreams` (`state`);--> statement-breakpoint
CREATE INDEX `workstreams_task_idx` ON `workstreams` (`task_id`);--> statement-breakpoint
CREATE INDEX `workstreams_batch_idx` ON `workstreams` (`batch_id`);