CREATE TABLE `skip_follow_ups` (
	`task_id` text PRIMARY KEY NOT NULL,
	`source_workstream_id` text NOT NULL,
	`source_batch_id` text,
	`started_at` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_batch_id`) REFERENCES `batches`(`id`) ON UPDATE no action ON DELETE no action
);
