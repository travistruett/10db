ALTER TABLE `batches` ADD `auto_merge` integer DEFAULT false NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `landing` text DEFAULT 'merge' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `landing` text DEFAULT 'base' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `landing_branch` text;