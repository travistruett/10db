CREATE TABLE `task_start_dirt` (
	`task_id` text PRIMARY KEY NOT NULL,
	`entries` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
