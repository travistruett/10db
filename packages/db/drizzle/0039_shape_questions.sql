CREATE TABLE `shape_questions` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`key` text NOT NULL,
	`text` text NOT NULL,
	`for_who` text NOT NULL,
	`source_message_ids` text DEFAULT '[]' NOT NULL,
	`goal_id` text,
	`task_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `shape_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `shape_questions_shape_idx` ON `shape_questions` (`shape_id`,`key`);--> statement-breakpoint
ALTER TABLE `shape_links` ADD `principle_id` text REFERENCES principles(id);--> statement-breakpoint
ALTER TABLE `shape_links` ADD `question_id` text REFERENCES shape_questions(id);