PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_playbook_rows` (
	`rigor` text NOT NULL,
	`project_id` text,
	`steps` text,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_playbook_rows`("rigor", "project_id", "steps", "updated_at") SELECT "rigor", "project_id", "steps", "updated_at" FROM `playbook_rows`;--> statement-breakpoint
DROP TABLE `playbook_rows`;--> statement-breakpoint
ALTER TABLE `__new_playbook_rows` RENAME TO `playbook_rows`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_rows_project_idx` ON `playbook_rows` (`rigor`,`project_id`) WHERE "playbook_rows"."project_id" is not null;--> statement-breakpoint
CREATE UNIQUE INDEX `playbook_rows_global_idx` ON `playbook_rows` (`rigor`) WHERE "playbook_rows"."project_id" is null;