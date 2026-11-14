PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_routing_rules` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`category` text,
	`area` text,
	`goal_id` text,
	`task_id` text,
	`topic` text,
	`person_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`goal_id`) REFERENCES `goals`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action,
	CONSTRAINT "routing_rules_scope" CHECK(("__new_routing_rules"."category" IS NULL) <> ("__new_routing_rules"."topic" IS NULL)
        AND ("__new_routing_rules"."goal_id" IS NULL OR "__new_routing_rules"."task_id" IS NULL)
        AND ("__new_routing_rules"."topic" IS NULL OR ("__new_routing_rules"."goal_id" IS NULL AND "__new_routing_rules"."task_id" IS NULL AND "__new_routing_rules"."area" IS NULL))
        AND ("__new_routing_rules"."task_id" IS NULL OR "__new_routing_rules"."area" IS NULL))
);
--> statement-breakpoint
INSERT INTO `__new_routing_rules`("id", "project_id", "category", "area", "goal_id", "task_id", "topic", "person_id", "created_at", "updated_at") SELECT "id", "project_id", "category", "area", "goal_id", "task_id", "topic", "person_id", "created_at", "updated_at" FROM `routing_rules`;--> statement-breakpoint
DROP TABLE `routing_rules`;--> statement-breakpoint
ALTER TABLE `__new_routing_rules` RENAME TO `routing_rules`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `routing_rules_project_idx` ON `routing_rules` (`project_id`);