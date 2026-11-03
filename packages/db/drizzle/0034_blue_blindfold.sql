CREATE TABLE `landing_groups` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`shape_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `landing_groups_project_idx` ON `landing_groups` (`project_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `landing_group_id` text REFERENCES landing_groups(id);--> statement-breakpoint
CREATE INDEX `tasks_landing_group_idx` ON `tasks` (`landing_group_id`);