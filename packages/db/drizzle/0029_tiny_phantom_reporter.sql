CREATE TABLE `shape_files` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`name` text NOT NULL,
	`media_type` text NOT NULL,
	`size` integer NOT NULL,
	`stored_path` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_files_shape_idx` ON `shape_files` (`shape_id`,`id`);--> statement-breakpoint
ALTER TABLE `shape_proposals` ADD `created_round` integer DEFAULT 0 NOT NULL;