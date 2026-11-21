CREATE TABLE `shape_accepts` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`undone_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_accepts_shape_idx` ON `shape_accepts` (`shape_id`);--> statement-breakpoint
ALTER TABLE `landing_groups` ADD `accept_id` text REFERENCES shape_accepts(id);--> statement-breakpoint
ALTER TABLE `shape_proposals` ADD `accept_id` text REFERENCES shape_accepts(id);