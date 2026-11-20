PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shapes` (
	`id` text PRIMARY KEY NOT NULL,
	`project_id` text NOT NULL,
	`title` text NOT NULL,
	`state` text NOT NULL,
	`origin` text NOT NULL,
	`round` integer DEFAULT 0 NOT NULL,
	`bundle_id` text,
	`bundle_origin` text,
	`imported_at` text,
	`chat_id` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`chat_id`) REFERENCES `chats`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_shapes`("id", "project_id", "title", "state", "origin", "round", "bundle_id", "bundle_origin", "imported_at", "chat_id", "created_at", "updated_at") SELECT "id", "project_id", "title", "state", "origin", "round", "bundle_id", "bundle_origin", "imported_at", "chat_id", "created_at", "updated_at" FROM `shapes`;--> statement-breakpoint
DROP TABLE `shapes`;--> statement-breakpoint
ALTER TABLE `__new_shapes` RENAME TO `shapes`;--> statement-breakpoint
PRAGMA foreign_keys=ON;--> statement-breakpoint
CREATE INDEX `shapes_project_idx` ON `shapes` (`project_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shapes_chat_unique` ON `shapes` (`chat_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `shapes_bundle_unique` ON `shapes` (`project_id`,`bundle_id`) WHERE "shapes"."bundle_id" IS NOT NULL;