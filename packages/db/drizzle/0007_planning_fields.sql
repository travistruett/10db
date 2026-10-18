ALTER TABLE `projects` ADD `flow_id` text REFERENCES flows(id);--> statement-breakpoint
ALTER TABLE `projects` ADD `budget_ceiling` real;--> statement-breakpoint
ALTER TABLE `tasks` ADD `risk_tags` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `flow_id` text REFERENCES flows(id);--> statement-breakpoint
ALTER TABLE `workstreams` ADD `steps` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `workstreams` ADD `step_index` integer DEFAULT 0 NOT NULL;