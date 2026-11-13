CREATE TABLE `chats` (
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
	`last_activity_at` text NOT NULL,
	`archived_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `chats_project_idx` ON `chats` (`project_id`);--> statement-breakpoint
CREATE TABLE `conversation_files` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`item_id` text,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`sha256` text,
	`stored_path` text NOT NULL,
	`inline_sent` integer DEFAULT false NOT NULL,
	`told_at` text,
	`unreadable_told_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`item_id`) REFERENCES `conversation_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `conversation_files_conversation_idx` ON `conversation_files` (`conversation_id`,`created_at`,`id`);--> statement-breakpoint
CREATE TABLE `conversation_items` (
	`id` text PRIMARY KEY NOT NULL,
	`conversation_id` text NOT NULL,
	`seq` integer NOT NULL,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`turn_id` text,
	`partial` integer DEFAULT false NOT NULL,
	`pushed_at` text,
	`push_uuids` text DEFAULT '[]' NOT NULL,
	`delivered_at` text,
	`handed_back_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`conversation_id`) REFERENCES `conversations`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `pass_turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversation_items_seq_unique` ON `conversation_items` (`conversation_id`,`seq`);--> statement-breakpoint
CREATE TABLE `conversations` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`owner_kind` text NOT NULL,
	`owner_id` text NOT NULL,
	`profile` text NOT NULL,
	`account_id` text NOT NULL,
	`model` text,
	`provider_session_id` text,
	`state` text,
	`context_pct` real,
	`next_seq` integer DEFAULT 1 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `conversations_owner_unique` ON `conversations` (`owner_kind`,`owner_id`);--> statement-breakpoint
CREATE INDEX `conversations_project_idx` ON `conversations` (`project_id`);--> statement-breakpoint
ALTER TABLE `sessions` ADD `conversation_id` text REFERENCES conversations(id);--> statement-breakpoint
CREATE INDEX `sessions_conversation_idx` ON `sessions` (`conversation_id`);