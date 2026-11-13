CREATE TABLE `person_contacts` (
	`id` text PRIMARY KEY NOT NULL,
	`person_id` text NOT NULL,
	`team_id` text NOT NULL,
	`user_id` text NOT NULL,
	`dm_channel_id` text,
	`send_mode` text NOT NULL,
	`daily_limit` integer,
	`dm_cursor` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `person_contacts_person_id_unique` ON `person_contacts` (`person_id`);--> statement-breakpoint
CREATE TABLE `stakeholder_send_people` (
	`send_id` text NOT NULL,
	`user_id` text NOT NULL,
	`person_id` text,
	`name` text NOT NULL,
	`recipient` integer NOT NULL,
	`position` integer NOT NULL,
	PRIMARY KEY(`send_id`, `user_id`),
	FOREIGN KEY (`send_id`) REFERENCES `stakeholder_sends`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`person_id`) REFERENCES `people`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `stakeholder_sends` (
	`id` text PRIMARY KEY NOT NULL,
	`inbox_item_id` text NOT NULL,
	`state` text NOT NULL,
	`text` text NOT NULL,
	`hits` text NOT NULL,
	`reviewed` integer DEFAULT false NOT NULL,
	`held_by` text,
	`text_sha256` text,
	`channel_id` text,
	`thread_ts` text,
	`message_ts` text,
	`permalink` text,
	`new_thread` integer DEFAULT false NOT NULL,
	`started_at` text,
	`sent_at` text,
	`last_read_ts` text,
	`wait_started_at` text,
	`reminded_at` text,
	`returned_at` text,
	`returned_reason` text,
	`settled_through_ts` text,
	`asked_which_way_at` text,
	`asked_which_way_ts` text,
	`approval_seen_at` text,
	`approval_by` text,
	`lone_reply_pending_since` text,
	`proposal` text,
	`moved_from` text,
	`reply` text,
	`reply_via` text,
	`read_as` text,
	`answered_by` text,
	`answered_at` text,
	`closed_reason` text,
	`error` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`inbox_item_id`) REFERENCES `inbox_items`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `stakeholder_sends_state_idx` ON `stakeholder_sends` (`state`);--> statement-breakpoint
CREATE INDEX `stakeholder_sends_card_idx` ON `stakeholder_sends` (`inbox_item_id`);--> statement-breakpoint
CREATE UNIQUE INDEX `stakeholder_sends_live_card` ON `stakeholder_sends` (`inbox_item_id`) WHERE "stakeholder_sends"."state" IN ('draft', 'sending', 'sent');--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `assignees` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `rule_assignees` text DEFAULT '[]' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `routed_by` text DEFAULT 'rule' NOT NULL;--> statement-breakpoint
ALTER TABLE `inbox_items` ADD `route_suggestion` text;--> statement-breakpoint
ALTER TABLE `routing_rules` ADD `goal_id` text REFERENCES goals(id);--> statement-breakpoint
ALTER TABLE `routing_rules` ADD `task_id` text REFERENCES tasks(id);--> statement-breakpoint
ALTER TABLE `routing_rules` ADD `topic` text;