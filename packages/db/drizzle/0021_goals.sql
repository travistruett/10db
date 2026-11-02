CREATE TABLE `goal_criteria` (
	`id` text PRIMARY KEY NOT NULL,
	`goal_id` text NOT NULL,
	`position` integer NOT NULL,
	`text` text NOT NULL,
	`check` text NOT NULL,
	`task_id` text,
	`command` text,
	`command_approved` integer DEFAULT false NOT NULL,
	`person_id` text,
	`state` text DEFAULT 'unproven' NOT NULL,
	`proof` text DEFAULT '[]' NOT NULL,
	`proven_at` text,
	`proven_by` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `goal_criteria_position_idx` ON `goal_criteria` (`goal_id`,`position`);--> statement-breakpoint
CREATE TABLE `goal_views` (
	`goal_id` text NOT NULL,
	`person_id` text NOT NULL,
	`opened_at` text NOT NULL,
	PRIMARY KEY(`goal_id`, `person_id`),
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `goals` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`objective` text NOT NULL,
	`cares_most` text,
	`description` text DEFAULT '' NOT NULL,
	`owner_id` text NOT NULL,
	`state` text DEFAULT 'draft' NOT NULL,
	`budget` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`owner_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `goals_project_idx` ON `goals` (`project_id`);--> statement-breakpoint
ALTER TABLE `tasks` ADD `goal_id` text REFERENCES goals(id);--> statement-breakpoint
CREATE INDEX `tasks_goal_idx` ON `tasks` (`goal_id`);