PRAGMA foreign_keys=OFF;--> statement-breakpoint
CREATE TABLE `__new_shape_shadow_answers` (
	`shape_id` text NOT NULL,
	`message_id` text NOT NULL,
	`decision` text NOT NULL,
	`answer` text NOT NULL,
	`confidence` real NOT NULL,
	`judge_call_id` text NOT NULL,
	`created_at` text NOT NULL,
	PRIMARY KEY(`message_id`, `decision`),
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`message_id`) REFERENCES `conversation_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
INSERT INTO `__new_shape_shadow_answers`("shape_id", "message_id", "decision", "answer", "confidence", "judge_call_id", "created_at") SELECT "shape_id", "message_id", "decision", "answer", "confidence", "judge_call_id", "created_at" FROM `shape_shadow_answers`;--> statement-breakpoint
DROP TABLE `shape_shadow_answers`;--> statement-breakpoint
ALTER TABLE `__new_shape_shadow_answers` RENAME TO `shape_shadow_answers`;--> statement-breakpoint
PRAGMA foreign_keys=ON;