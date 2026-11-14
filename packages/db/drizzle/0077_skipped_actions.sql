CREATE TABLE `skip_approvals` (
	`task_id` text NOT NULL,
	`skipped_action_id` text NOT NULL,
	PRIMARY KEY(`task_id`, `skipped_action_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`skipped_action_id`) REFERENCES `skipped_actions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `skipped_actions` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`session_id` text,
	`tool_name` text NOT NULL,
	`tool_use_id` text,
	`call_key` text,
	`summary` text NOT NULL,
	`summary_cut` integer DEFAULT false NOT NULL,
	`kind` text NOT NULL,
	`limit_name` text,
	`reason` text NOT NULL,
	`source` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `skipped_actions_one_per_call` ON `skipped_actions` (`workstream_id`,`tool_use_id`) WHERE tool_use_id IS NOT NULL;--> statement-breakpoint
CREATE INDEX `skipped_actions_workstream_idx` ON `skipped_actions` (`workstream_id`);