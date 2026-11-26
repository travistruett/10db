CREATE TABLE `eval_live_runs` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`suite_key` text NOT NULL,
	`command` text NOT NULL,
	`stop_command` text,
	`preview_hash` text NOT NULL,
	`docker` integer NOT NULL,
	`hosts_json` text NOT NULL,
	`env_files_json` text NOT NULL,
	`state` text NOT NULL,
	`started_at` text NOT NULL,
	`ended_at` text,
	`exit_code` integer,
	`tail` text DEFAULT '' NOT NULL,
	`cost_shown_usd` real,
	`stop_ran` integer DEFAULT false NOT NULL,
	`log_path` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "eval_live_runs_state" CHECK("eval_live_runs"."state" IN ('running', 'passed', 'failed', 'stopped', 'timed_out', 'interrupted'))
);
--> statement-breakpoint
CREATE INDEX `eval_live_runs_project_idx` ON `eval_live_runs` (`project_id`,`suite_key`,`started_at`);