CREATE TABLE `kinds` (
	`id` text PRIMARY KEY NOT NULL,
	`key` text NOT NULL,
	`label` text NOT NULL,
	`description` text DEFAULT '' NOT NULL,
	`minimum_rigor` text,
	`always_reviewed` integer DEFAULT false NOT NULL,
	`fails_at_limit` integer DEFAULT false NOT NULL,
	`own_copy` integer DEFAULT false NOT NULL,
	`to_inbox` integer DEFAULT false NOT NULL,
	`adds_steps` text DEFAULT '[]' NOT NULL,
	`overrides` text DEFAULT '{}' NOT NULL,
	`position` integer NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL
);
--> statement-breakpoint
CREATE UNIQUE INDEX `kinds_key_unique` ON `kinds` (`key`);--> statement-breakpoint
CREATE TABLE `playbook_cells` (
	`rigor` text NOT NULL,
	`role` text NOT NULL,
	`project_id` text,
	`persona_id` text,
	`model` text,
	`effort` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`persona_id`) REFERENCES `personas`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_cells_project_idx` ON `playbook_cells` (`rigor`,`role`,`project_id`) WHERE "playbook_cells"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_cells_global_idx` ON `playbook_cells` (`rigor`,`role`) WHERE "playbook_cells"."project_id" is null;--> statement-breakpoint
CREATE TABLE `playbook_rows` (
	`rigor` text NOT NULL,
	`project_id` text,
	`steps` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_rows_project_idx` ON `playbook_rows` (`rigor`,`project_id`) WHERE "playbook_rows"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_rows_global_idx` ON `playbook_rows` (`rigor`) WHERE "playbook_rows"."project_id" is null;--> statement-breakpoint
ALTER TABLE `projects` ADD `default_rigor` text DEFAULT 'standard' NOT NULL;--> statement-breakpoint
ALTER TABLE `shapes` ADD `effort` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rigor` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kinds` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `effort_pin` text;