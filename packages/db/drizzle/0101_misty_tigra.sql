CREATE TABLE `design_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`shape_id` text,
	`task_id` text,
	`attachment_id` text NOT NULL,
	`purpose` text NOT NULL,
	`mockup_sha256` text,
	`shots` text NOT NULL,
	`design_md_path` text,
	`verdict` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`attachment_id`) REFERENCES `shape_attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `design_checks_task_idx` ON `design_checks` (`task_id`,`created_at`);