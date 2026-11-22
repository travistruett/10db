CREATE TABLE `linear_posts` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`project_id` text NOT NULL,
	`event` text NOT NULL,
	`dedupe_key` text NOT NULL,
	`attempt` integer NOT NULL,
	`detail` text NOT NULL,
	`state` text NOT NULL,
	`tries` integer DEFAULT 0 NOT NULL,
	`due_at` text,
	`last_error` text,
	`withheld_pattern` text,
	`session_id` text,
	`comment_ids` text NOT NULL,
	`status_set` text,
	`attachment_url` text,
	`dismissed_at` text,
	`created_at` text NOT NULL,
	`recorded_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`session_id`) REFERENCES `sessions`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `linear_posts_dedupe_unique` ON `linear_posts` (`task_id`,`dedupe_key`);--> statement-breakpoint
CREATE INDEX `linear_posts_state_due_idx` ON `linear_posts` (`state`,`due_at`);