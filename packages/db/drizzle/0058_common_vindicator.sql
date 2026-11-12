CREATE TABLE `task_screens` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`turn_id` text,
	`kind` text NOT NULL,
	`route` text NOT NULL,
	`viewport` text NOT NULL,
	`theme` text NOT NULL,
	`sha256` text NOT NULL,
	`size` integer NOT NULL,
	`width` integer NOT NULL,
	`height` integer NOT NULL,
	`stored_path` text NOT NULL,
	`kept_sha` text,
	`created_at` text NOT NULL,
	`pruned_at` text,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`turn_id`) REFERENCES `pass_turns`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_screens_task_idx` ON `task_screens` (`task_id`,`created_at`);--> statement-breakpoint
CREATE INDEX `task_screens_sha_idx` ON `task_screens` (`sha256`);--> statement-breakpoint
ALTER TABLE `projects` ADD `dev_login_command` text;--> statement-breakpoint
ALTER TABLE `projects` ADD `screens` text DEFAULT '{"viewports":[{"width":1440,"height":900}],"themes":["default"]}' NOT NULL;