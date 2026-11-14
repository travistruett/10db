CREATE TABLE `trust_grants` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`limit_name` text,
	`target` text NOT NULL,
	`source_inbox_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE cascade,
	CONSTRAINT "trust_grants_limit_name" CHECK("trust_grants"."limit_name" IS NULL OR "trust_grants"."limit_name" IN ('destroys_data', 'sends_data_out', 'reads_secrets', 'writes_live'))
);
--> statement-breakpoint
CREATE INDEX `trust_grants_project_idx` ON `trust_grants` (`project_id`);