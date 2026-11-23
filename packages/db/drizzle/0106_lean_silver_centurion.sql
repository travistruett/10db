DROP INDEX `person_contacts_person_id_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `person_contacts_person_team` ON `person_contacts` (`person_id`,`team_id`);--> statement-breakpoint
ALTER TABLE `stakeholder_sends` ADD `team_id` text;