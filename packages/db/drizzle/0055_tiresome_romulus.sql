CREATE TABLE `pass_take_outs` (
	`task_id` text NOT NULL,
	`pass_id` text NOT NULL,
	`step` integer NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`kept_sha` text,
	`kept_base_sha` text,
	`left` text DEFAULT '[]' NOT NULL,
	`drops` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`task_id`, `pass_id`),
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pass_turns` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`session_id` text,
	`seq` integer NOT NULL,
	`message_id` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`ending` text,
	`settled_at` text,
	`kept_sha` text,
	`kept_base_sha` text,
	`shared_seq` integer,
	`check` text DEFAULT 'none' NOT NULL,
	`ready_at` text,
	`opened_at` text,
	`answered_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `task_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pass_turns_task_seq` ON `pass_turns` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `pass_turns_workstream_idx` ON `pass_turns` (`workstream_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pass_turns_one_open` ON `pass_turns` (`task_id`) WHERE ended_at IS NULL;--> statement-breakpoint
ALTER TABLE `passes` ADD `abandon_step` integer;--> statement-breakpoint
ALTER TABLE `projects` ADD `app_url` text;--> statement-breakpoint
ALTER TABLE `task_messages` ADD `turn_id` text REFERENCES pass_turns(id);--> statement-breakpoint
ALTER TABLE `tasks` ADD `kept_work_sha` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kept_base_sha` text;