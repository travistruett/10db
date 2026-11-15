ALTER TABLE `projects` ADD `left_out_pages` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `made_by_pass_id` text REFERENCES passes(id);