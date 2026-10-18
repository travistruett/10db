CREATE TABLE `aa_models` (
	`slug` text PRIMARY KEY NOT NULL,
	`data` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE TABLE `flows` (
	`id` text PRIMARY KEY NOT NULL,
	`name` text NOT NULL,
	`steps` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `flows_name_unique` ON `flows` (`name`);--> statement-breakpoint
CREATE TABLE `model_profiles` (
	`id` text PRIMARY KEY NOT NULL,
	`provider` text NOT NULL,
	`model` text NOT NULL,
	`effort` text NOT NULL,
	`aa_slug` text,
	`intelligence` real,
	`coding` real,
	`agentic` real,
	`cost_per_task_usd` real,
	`output_tokens_per_second` real,
	`source` text NOT NULL,
	`index_version` text,
	`measured_at` text,
	`enabled` integer DEFAULT true NOT NULL,
	`steps_run` integer DEFAULT 0 NOT NULL,
	`first_pass_steps` integer DEFAULT 0 NOT NULL,
	`escalations` integer DEFAULT 0 NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `model_profiles_key_idx` ON `model_profiles` (`provider`,`model`,`effort`);--> statement-breakpoint
CREATE TABLE `people` (
	`id` text PRIMARY KEY NOT NULL,
	`handle` text NOT NULL,
	`name` text NOT NULL,
	`is_builder` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `people_handle_unique` ON `people` (`handle`);--> statement-breakpoint
CREATE TABLE `personas` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`name` text NOT NULL,
	`role` text NOT NULL,
	`tools` text NOT NULL,
	`instructions` text NOT NULL,
	`skills` text DEFAULT '[]' NOT NULL,
	`minimum_score` real,
	`model_pin` text,
	`archived` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `personas_key_unique` ON `personas` (`key`);--> statement-breakpoint
CREATE TABLE `routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text NOT NULL,
	`area` text,
	`person_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `routing_rules_project_idx` ON `routing_rules` (`project_id`);--> statement-breakpoint
CREATE TABLE `team_bindings` (
	`project_id` text NOT NULL,
	`role` text NOT NULL,
	`persona_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `role`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `team_members` (
	`project_id` text NOT NULL,
	`person_id` text NOT NULL,
	PRIMARY KEY(`project_id`, `person_id`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
