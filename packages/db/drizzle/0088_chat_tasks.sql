CREATE TABLE `chat_tasks` (
	`chat_id` text NOT NULL,
	`task_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`chat_id`, `task_id`),
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chat_tasks_task_idx` ON `chat_tasks` (`task_id`);--> statement-breakpoint
PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_chats` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`conversation_id` text NOT NULL,
	`title` text,
	`title_source` text,
	`mode` text NOT NULL,
	`task_id` text,
	`pass_id` text,
	`tab_position` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`last_activity_at` text,
	`archived_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_chats`("id", "project_id", "conversation_id", "title", "title_source", "mode", "task_id", "pass_id", "tab_position", "created_at", "updated_at", "last_activity_at", "archived_at") SELECT "id", "project_id", "conversation_id", "title", "title_source", "mode", "task_id", "pass_id", "tab_position", "created_at", "updated_at", "last_activity_at", "archived_at" FROM `chats`;--> statement-breakpoint
DROP TABLE `chats`;--> statement-breakpoint
ALTER TABLE `__new_chats` RENAME TO `chats`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `chats_project_idx` ON `chats` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `chats_conversation_unique` ON `chats` (`conversation_id`);--> statement-breakpoint
ALTER TABLE `conversations` ADD `commands` text;