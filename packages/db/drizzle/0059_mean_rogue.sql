CREATE TABLE `pass_preview_marks` (
	`id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`task_id` text NOT NULL,
	`route` text NOT NULL,
	`turn_id` text NOT NULL,
	`overlay` text,
	`broken_at` text NOT NULL,
	`turns` integer DEFAULT 1 NOT NULL,
	`mended_at` text,
	`card_id` text,
	`notice_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `pass_turns`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`card_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`notice_id`) REFERENCES `task_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pass_preview_marks_one_open` ON `pass_preview_marks` (`pass_id`,`task_id`) WHERE mended_at IS NULL;--> statement-breakpoint
CREATE TABLE `task_page_reports` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`turn_id` text,
	`route` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `pass_turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_page_reports_task_idx` ON `task_page_reports` (`task_id`,`workstream_id`);--> statement-breakpoint
ALTER TABLE `passes` ADD `preview` text;