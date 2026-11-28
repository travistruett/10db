ALTER TABLE `projects` ADD `auto_ceiling_usd` real DEFAULT 10 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_ceiling_share` real DEFAULT 0.1 NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `auto_ceiling_sessions` integer DEFAULT 20 NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `self_started` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `sessions` ADD `limit_share` real;--> statement-breakpoint
ALTER TABLE `workstreams` ADD `self_started` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `workstreams` ADD `auto_rerun` integer DEFAULT false NOT NULL;