CREATE TABLE `shape_attachments` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`body` text NOT NULL,
	`goal_id` text,
	`task_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_attachments_shape_idx` ON `shape_attachments` (`shape_id`,`key`);--> statement-breakpoint
CREATE UNIQUE INDEX `shape_attachments_one_spec` ON `shape_attachments` (`shape_id`,`key`,`kind`) WHERE "shape_attachments"."kind" IN ('spec', 'eval');--> statement-breakpoint
CREATE TABLE `shape_findings` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`effort_key` text NOT NULL,
	`task_key` text,
	`reviewer` text NOT NULL,
	`kind` text NOT NULL,
	`severity` text,
	`text` text NOT NULL,
	`state` text NOT NULL,
	`how` text,
	`round` integer NOT NULL,
	`task_hash` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_findings_shape_idx` ON `shape_findings` (`shape_id`,`id`);--> statement-breakpoint
CREATE TABLE `shape_rehearsals` (
	`shape_id` text NOT NULL,
	`task_key` text NOT NULL,
	`hash` text NOT NULL,
	`round` integer NOT NULL,
	`questions` integer NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`shape_id`, `task_key`, `hash`),
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
