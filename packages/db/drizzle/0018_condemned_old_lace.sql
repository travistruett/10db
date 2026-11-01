CREATE TABLE `judge_calls` (
	`id` text PRIMARY KEY NOT NULL,
	`decision` text NOT NULL,
	`model` text NOT NULL,
	`state` text NOT NULL,
	`question` text NOT NULL,
	`answer` text,
	`confidence` real,
	`outcome` text NOT NULL,
	`latency_ms` integer,
	`cost_usd` real,
	`workstream_id` text,
	`task_id` text,
	`created_at` text NOT NULL
);
--> statement-breakpoint
CREATE INDEX `judge_calls_created_idx` ON `judge_calls` (`created_at`);