ALTER TABLE `projects` ADD `isolate` text DEFAULT '["migrations","deps"]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `placement_reason` text;