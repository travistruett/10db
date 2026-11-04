ALTER TABLE `decisions` ADD `withdrawn_source_id` text REFERENCES sources(id);--> statement-breakpoint
ALTER TABLE `principles` ADD `confirmed_source_id` text REFERENCES sources(id);--> statement-breakpoint
ALTER TABLE `principles` ADD `retired_source_id` text REFERENCES sources(id);--> statement-breakpoint
ALTER TABLE `principles` ADD `withdrawn_source_id` text REFERENCES sources(id);