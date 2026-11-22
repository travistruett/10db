ALTER TABLE `tasks` ADD `external_kind` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_issue_id` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `external_url` text;--> statement-breakpoint
CREATE UNIQUE INDEX `tasks_external_idx` ON `tasks` (`project_id`,`external_kind`,`external_id`) WHERE "tasks"."status" <> 'cancelled';