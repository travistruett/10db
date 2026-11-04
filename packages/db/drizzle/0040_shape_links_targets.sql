PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shape_links` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`proposal_id` text NOT NULL,
	`key` text NOT NULL,
	`goal_id` text,
	`task_id` text,
	`decision_id` text,
	`principle_id` text,
	`question_id` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`proposal_id`) REFERENCES `shape_proposals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`decision_id`) REFERENCES `decisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`principle_id`) REFERENCES `principles`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`question_id`) REFERENCES `shape_questions`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "shape_links_one_target" CHECK(("__new_shape_links"."goal_id" IS NOT NULL) + ("__new_shape_links"."task_id" IS NOT NULL) + ("__new_shape_links"."decision_id" IS NOT NULL) + ("__new_shape_links"."principle_id" IS NOT NULL) + ("__new_shape_links"."question_id" IS NOT NULL) = 1)
);
--> statement-breakpoint
INSERT INTO `__new_shape_links`("id", "shape_id", "proposal_id", "key", "goal_id", "task_id", "decision_id", "principle_id", "question_id", "created_at") SELECT "id", "shape_id", "proposal_id", "key", "goal_id", "task_id", "decision_id", "principle_id", "question_id", "created_at" FROM `shape_links`;--> statement-breakpoint
DROP TABLE `shape_links`;--> statement-breakpoint
ALTER TABLE `__new_shape_links` RENAME TO `shape_links`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `shape_links_shape_key_idx` ON `shape_links` (`shape_id`,`key`);--> statement-breakpoint
CREATE INDEX `shape_links_task_idx` ON `shape_links` (`task_id`);