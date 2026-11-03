CREATE TABLE `shape_shadow_answers` (
	`shape_id` text NOT NULL,
	`message_id` text NOT NULL,
	`decision` text NOT NULL,
	`answer` text NOT NULL,
	`confidence` real NOT NULL,
	`judge_call_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `decision`),
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `shape_messages`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_lane_times` (
	`workstream_id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`lane_minutes` real NOT NULL,
	`sessions_only` integer NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_lane_times_task_idx` ON `task_lane_times` (`task_id`);