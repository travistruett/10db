PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_sessions` (
	`id` text PRIMARY KEY NOT NULL,
	`workstream_id` text,
	`shape_id` text,
	`account_id` text NOT NULL,
	`sequence` integer NOT NULL,
	`provider` text NOT NULL,
	`provider_session_id` text,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`mode` text NOT NULL,
	`mcp_token_hash` text NOT NULL,
	`pid` integer,
	`pid_start` text,
	`started_at` text NOT NULL,
	`ended_at` text,
	`exit_reason` text,
	`input_tokens` integer NOT NULL,
	`output_tokens` integer NOT NULL,
	`cached_tokens` integer DEFAULT 0 NOT NULL,
	`cost_usd` real,
	`context_pct` real,
	`briefing_baseline_pct` real,
	`briefed` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "sessions_one_owner" CHECK(("__new_sessions"."workstream_id" IS NULL) <> ("__new_sessions"."shape_id" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_sessions`("id", "workstream_id", "shape_id", "account_id", "sequence", "provider", "provider_session_id", "model", "effort", "mode", "mcp_token_hash", "pid", "pid_start", "started_at", "ended_at", "exit_reason", "input_tokens", "output_tokens", "cached_tokens", "cost_usd", "context_pct", "briefing_baseline_pct", "briefed", "created_at", "updated_at") SELECT "id", "workstream_id", "shape_id", "account_id", "sequence", "provider", "provider_session_id", "model", "effort", "mode", "mcp_token_hash", "pid", "pid_start", "started_at", "ended_at", "exit_reason", "input_tokens", "output_tokens", "cached_tokens", "cost_usd", "context_pct", "briefing_baseline_pct", "briefed", "created_at", "updated_at" FROM `sessions`;--> statement-breakpoint
DROP TABLE `sessions`;--> statement-breakpoint
ALTER TABLE `__new_sessions` RENAME TO `sessions`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `sessions_mcp_token_hash_unique` ON `sessions` (`mcp_token_hash`);--> statement-breakpoint
CREATE INDEX `sessions_workstream_idx` ON `sessions` (`workstream_id`);--> statement-breakpoint
CREATE INDEX `sessions_shape_idx` ON `sessions` (`shape_id`);--> statement-breakpoint
CREATE INDEX `sessions_account_started_idx` ON `sessions` (`account_id`,`started_at`);