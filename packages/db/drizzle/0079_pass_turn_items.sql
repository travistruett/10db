PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_pass_preview_marks` (
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
	FOREIGN KEY (`notice_id`) REFERENCES `conversation_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pass_preview_marks`("id", "pass_id", "task_id", "route", "turn_id", "overlay", "broken_at", "turns", "mended_at", "card_id", "notice_id", "created_at", "updated_at") SELECT "id", "pass_id", "task_id", "route", "turn_id", "overlay", "broken_at", "turns", "mended_at", "card_id", "notice_id", "created_at", "updated_at" FROM `pass_preview_marks`;--> statement-breakpoint
DROP TABLE `pass_preview_marks`;--> statement-breakpoint
ALTER TABLE `__new_pass_preview_marks` RENAME TO `pass_preview_marks`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `pass_preview_marks_one_open` ON `pass_preview_marks` (`pass_id`,`task_id`) WHERE mended_at IS NULL;--> statement-breakpoint
CREATE TABLE `__new_pass_turns` (
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
	FOREIGN KEY (`message_id`) REFERENCES `conversation_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_pass_turns`("id", "task_id", "workstream_id", "session_id", "seq", "message_id", "started_at", "ended_at", "ending", "settled_at", "kept_sha", "kept_base_sha", "shared_seq", "check", "ready_at", "opened_at", "answered_at", "created_at", "updated_at") SELECT "id", "task_id", "workstream_id", "session_id", "seq", "message_id", "started_at", "ended_at", "ending", "settled_at", "kept_sha", "kept_base_sha", "shared_seq", "check", "ready_at", "opened_at", "answered_at", "created_at", "updated_at" FROM `pass_turns`;--> statement-breakpoint
DROP TABLE `pass_turns`;--> statement-breakpoint
ALTER TABLE `__new_pass_turns` RENAME TO `pass_turns`;--> statement-breakpoint
CREATE UNIQUE INDEX `pass_turns_task_seq` ON `pass_turns` (`task_id`,`seq`);--> statement-breakpoint
CREATE INDEX `pass_turns_workstream_idx` ON `pass_turns` (`workstream_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `pass_turns_one_open` ON `pass_turns` (`task_id`) WHERE ended_at IS NULL;