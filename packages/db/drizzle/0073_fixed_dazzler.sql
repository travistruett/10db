ALTER TABLE `kinds` ADD `implied_by` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `kinds` ADD `skills` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `playbook_rows` ADD `ships` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rigor_source` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `rigor_reason` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `kinds_off` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sized_for` text;--> statement-breakpoint
ALTER TABLE `tasks` ADD `sizing_calls` text DEFAULT '{"rigor":null,"kinds":{}}' NOT NULL;