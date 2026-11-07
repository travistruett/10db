CREATE TABLE `account_models` (
	`account_id` text NOT NULL,
	`model` text NOT NULL,
	`family` text,
	`launch_id` text NOT NULL,
	`efforts` text NOT NULL,
	`unusable` integer DEFAULT false NOT NULL,
	`input_price` real,
	`output_price` real,
	`last_seen_at` text NOT NULL,
	PRIMARY KEY(`account_id`, `model`),
	FOREIGN KEY (`account_id`) REFERENCES `accounts`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `patterns` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text,
	`name` text NOT NULL,
	`match` text NOT NULL,
	`setting` text NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `patterns_scope_idx` ON `patterns` (`project_id`,`position`);--> statement-breakpoint
CREATE TABLE `role_settings` (
	`role` text NOT NULL,
	`project_id` text,
	`setting` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `role_settings_project_idx` ON `role_settings` (`role`,`project_id`) WHERE "role_settings"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `role_settings_global_idx` ON `role_settings` (`role`) WHERE "role_settings"."project_id" is null;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `maker` text;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `family` text;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `tier` text;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `status` text;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `input_price` real;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `output_price` real;--> statement-breakpoint
ALTER TABLE `model_profiles` ADD `release_date` text;