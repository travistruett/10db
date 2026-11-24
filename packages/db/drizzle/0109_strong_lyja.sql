ALTER TABLE `stakeholder_sends` ADD `handled_through_ts` text;--> statement-breakpoint
ALTER TABLE `stakeholder_sends` ADD `auto_answers` integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE `stakeholder_sends` ADD `asked` text;