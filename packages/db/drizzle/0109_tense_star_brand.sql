ALTER TABLE `evidence` ADD `screen_id` text REFERENCES task_screens(id);--> statement-breakpoint
ALTER TABLE `task_screens` ADD `url` text;--> statement-breakpoint
ALTER TABLE `task_screens` ADD `title` text;--> statement-breakpoint
ALTER TABLE `task_screens` ADD `note` text;--> statement-breakpoint
ALTER TABLE `task_screens` ADD `sent_session_id` text;