CREATE TABLE `eval_sweeps` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`suite_key` text NOT NULL,
	`kind` text NOT NULL,
	`state` text NOT NULL,
	`reason` text,
	`reason_text` text,
	`cap_usd` real NOT NULL,
	`models_json` text NOT NULL,
	`preview_hash` text NOT NULL,
	`steps_json` text NOT NULL,
	`winner` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "eval_sweeps_state" CHECK("eval_sweeps"."state" IN ('running', 'found', 'done', 'stopped'))
);
--> statement-breakpoint
CREATE INDEX `eval_sweeps_project_idx` ON `eval_sweeps` (`project_id`,`suite_key`,`started_at`);--> statement-breakpoint
ALTER TABLE `eval_live_runs` ADD `models_json` text;--> statement-breakpoint
ALTER TABLE `eval_live_runs` ADD `sweep_id` text;