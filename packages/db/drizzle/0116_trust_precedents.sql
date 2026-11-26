CREATE TABLE `trust_precedents` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`program_key` text NOT NULL,
	`scope` text NOT NULL,
	`kind` text NOT NULL,
	`examples` text DEFAULT '[]' NOT NULL,
	`runs_hash` text,
	`state` text NOT NULL,
	`uses` integer DEFAULT 0 NOT NULL,
	`last_used_at` text,
	`conflicts` integer DEFAULT 0 NOT NULL,
	`source_inbox_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	`ended_at` text,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trust_precedents_state" CHECK("trust_precedents"."state" IN ('active', 'paused', 'declined', 'revoked')),
	CONSTRAINT "trust_precedents_scope" CHECK("trust_precedents"."scope" IN ('copy', 'project'))
);
--> statement-breakpoint
CREATE UNIQUE INDEX `trust_precedents_one_per_key` ON `trust_precedents` (`project_id`,`program_key`,`scope`);--> statement-breakpoint
ALTER TABLE `judge_calls` ADD `precedent_id` text;--> statement-breakpoint
ALTER TABLE `judge_calls` ADD `program_key` text;--> statement-breakpoint
CREATE INDEX `judge_calls_precedent_idx` ON `judge_calls` (`precedent_id`,`created_at`) WHERE precedent_id IS NOT NULL;--> statement-breakpoint
ALTER TABLE `skipped_actions` ADD `program_key` text;