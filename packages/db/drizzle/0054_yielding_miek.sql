CREATE TABLE `pass_dirt` (
	`pass_id` text NOT NULL,
	`path` text NOT NULL,
	`blob` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`pass_id`, `path`),
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `passes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`name` text NOT NULL,
	`state` text NOT NULL,
	`batch_id` text,
	`page_cap` integer DEFAULT 4 NOT NULL,
	`return_branch` text NOT NULL,
	`start_sha` text NOT NULL,
	`opened_at` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `passes_project_idx` ON `passes` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `passes_one_open` ON `passes` (`project_id`) WHERE state IN ('OPEN', 'CLOSING', 'ABANDONING');--> statement-breakpoint
ALTER TABLE `batches` ADD `pass_id` text REFERENCES passes(id);--> statement-breakpoint
CREATE UNIQUE INDEX `batches_pass_idx` ON `batches` (`pass_id`) WHERE pass_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `pass_id` text REFERENCES passes(id);