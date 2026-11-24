CREATE TABLE `local_copies` (
	`batch_id` text PRIMARY KEY NOT NULL,
	`copy_id` text NOT NULL,
	`step` text NOT NULL,
	`base_tip` text,
	`candidate` text,
	`attempt` integer DEFAULT 0 NOT NULL,
	`wait` text,
	`wait_detail` text DEFAULT '[]' NOT NULL,
	`retry_at` text,
	`teardown_command` text NOT NULL,
	`teardown_sha` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE cascade
);
--> statement-breakpoint
ALTER TABLE `projects` ADD `local_copies` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `copy_teardown_command` text;