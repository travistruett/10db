CREATE TABLE `skip_listings` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text NOT NULL,
	`through_skip_id` text,
	`inbox_item_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`through_skip_id`) REFERENCES `skipped_actions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `skip_listings_workstream_idx` ON `skip_listings` (`workstream_id`);