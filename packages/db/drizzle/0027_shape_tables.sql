CREATE TABLE `shape_links` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`key` text NOT NULL,
	`goal_id` text,
	`task_id` text,
	`decision_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `shape_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shape_links_one_target" CHECK(("shape_links"."goal_id" IS NOT NULL) + ("shape_links"."task_id" IS NOT NULL) + ("shape_links"."decision_id" IS NOT NULL) = 1)
);
--> statement-breakpoint
CREATE INDEX `shape_links_shape_key_idx` ON `shape_links` (`shape_id`,`key`);--> statement-breakpoint
CREATE INDEX `shape_links_task_idx` ON `shape_links` (`task_id`);--> statement-breakpoint
CREATE TABLE `shape_messages` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`author` text NOT NULL,
	`kind` text NOT NULL,
	`body` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_messages_shape_idx` ON `shape_messages` (`shape_id`,`id`);--> statement-breakpoint
CREATE TABLE `shape_proposals` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`round` integer NOT NULL,
	`pinned` text DEFAULT '[]' NOT NULL,
	`body` text NOT NULL,
	`task_hashes` text DEFAULT '{}' NOT NULL,
	`source_message_ids` text DEFAULT '[]' NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shape_proposals_key_unique` ON `shape_proposals` (`shape_id`,`key`);--> statement-breakpoint
CREATE TABLE `shapes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`origin` text NOT NULL,
	`sdk_session_id` text,
	`propose_unlocked` integer DEFAULT false NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shapes_project_idx` ON `shapes` (`project_id`);--> statement-breakpoint
ALTER TABLE `decisions` ADD `withdrawn_at` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `withdrawn_by` text;--> statement-breakpoint
ALTER TABLE `decisions` ADD `withdrawn_reason` text;--> statement-breakpoint
ALTER TABLE `sessions` ADD `shape_id` text REFERENCES shapes(id);--> statement-breakpoint
CREATE INDEX `sessions_shape_idx` ON `sessions` (`shape_id`);