CREATE TABLE `principles` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`scope` text NOT NULL,
	`area` text,
	`statement` text NOT NULL,
	`rationale` text,
	`kind` text NOT NULL,
	`topic_key` text NOT NULL,
	`status` text NOT NULL,
	`supersedes_id` text,
	`source_id` text NOT NULL,
	`source_quote` text,
	`speaker` text,
	`confirmed_by` text,
	`confirmed_at` text,
	`retired_at` text,
	`retired_by` text,
	`retired_reason` text,
	`withdrawn_at` text,
	`withdrawn_by` text,
	`withdrawn_reason` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`source_id`) REFERENCES `sources`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `principles_topic_idx` ON `principles` (`topic_key`,`scope`,`project_id`,`area`);--> statement-breakpoint
CREATE INDEX `principles_supersedes_idx` ON `principles` (`supersedes_id`);--> statement-breakpoint
CREATE INDEX `decisions_supersedes_idx` ON `decisions` (`supersedes_id`);