CREATE TABLE `pass_hold_paths` (
	`claim_id` text NOT NULL,
	`path` text NOT NULL,
	`blob` text,
	`created_at` text NOT NULL,
	PRIMARY KEY(`claim_id`, `path`),
	FOREIGN KEY (`claim_id`) REFERENCES `pass_holds`(`claim_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pass_holds` (
	`claim_id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`task_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`area` text NOT NULL,
	`seq` integer NOT NULL,
	`record_sha` text NOT NULL,
	`granted_at` text NOT NULL,
	`closed_at` text,
	`empty` integer DEFAULT false NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`claim_id`) REFERENCES `claims`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `pass_holds_pass_seq` ON `pass_holds` (`pass_id`,`seq`);--> statement-breakpoint
CREATE TABLE `pass_shared_changes` (
	`pass_id` text NOT NULL,
	`seq` integer NOT NULL,
	`task_id` text NOT NULL,
	`sha` text NOT NULL,
	`paths` text NOT NULL,
	`blobs` text NOT NULL,
	`dirty_kept` integer DEFAULT false NOT NULL,
	`landed_sha` text,
	`dropped_by` integer,
	`drop_of` integer,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`pass_id`, `seq`),
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `pass_sign_offs` (
	`task_id` text PRIMARY KEY NOT NULL,
	`pass_id` text NOT NULL,
	`waits_for` text NOT NULL,
	`asked_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`pass_id`) REFERENCES `passes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`waits_for`) REFERENCES `pass_holds`(`claim_id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
ALTER TABLE `batches` ADD `pr_draft` integer;--> statement-breakpoint
ALTER TABLE `passes` ADD `shared_landed` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `passes` ADD `close_step` integer;--> statement-breakpoint
ALTER TABLE `passes` ADD `close_plan` text;--> statement-breakpoint
ALTER TABLE `passes` ADD `stacked_on` text REFERENCES passes(id);--> statement-breakpoint
ALTER TABLE `passes` ADD `closed_at` text;--> statement-breakpoint
ALTER TABLE `passes` ADD `settled_at` text;--> statement-breakpoint
ALTER TABLE `passes` ADD `reviewed_sha` text;--> statement-breakpoint
ALTER TABLE `passes` ADD `notices` text DEFAULT '[]' NOT NULL;