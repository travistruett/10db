CREATE TABLE `shape_attachment_revisions` (
	`id` text PRIMARY KEY NOT NULL,
	`attachment_id` text NOT NULL,
	`number` integer NOT NULL,
	`body` text NOT NULL,
	`sha256` text NOT NULL,
	`note` text,
	`author` text,
	`sections` text NOT NULL,
	`bundle_number` integer,
	`authored_at` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`attachment_id`) REFERENCES `shape_attachments`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shape_attachment_revisions_number_unique` ON `shape_attachment_revisions` (`attachment_id`,`number`);--> statement-breakpoint
CREATE UNIQUE INDEX `shape_attachment_revisions_bundle_number_unique` ON `shape_attachment_revisions` (`attachment_id`,`bundle_number`) WHERE "shape_attachment_revisions"."bundle_number" IS NOT NULL;--> statement-breakpoint
CREATE TABLE `shape_entries` (
	`id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`key` text NOT NULL,
	`kind` text NOT NULL,
	`title` text NOT NULL,
	`body` text NOT NULL,
	`anchors` text NOT NULL,
	`sources` text NOT NULL,
	`verified` integer NOT NULL,
	`checked_at` text,
	`state` text NOT NULL,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shape_entries_key_unique` ON `shape_entries` (`shape_id`,`key`);--> statement-breakpoint
CREATE TABLE `shape_entry_versions` (
	`id` text PRIMARY KEY NOT NULL,
	`entry_id` text NOT NULL,
	`number` integer NOT NULL,
	`snapshot` text NOT NULL,
	`created_at` text NOT NULL,
	FOREIGN KEY (`entry_id`) REFERENCES `shape_entries`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE UNIQUE INDEX `shape_entry_versions_number_unique` ON `shape_entry_versions` (`entry_id`,`number`);--> statement-breakpoint
CREATE TABLE `task_context` (
	`task_id` text PRIMARY KEY NOT NULL,
	`shape_id` text NOT NULL,
	`revision_id` text NOT NULL,
	`section` text NOT NULL,
	`shared` text NOT NULL,
	`cites` text NOT NULL,
	`packed_text` text,
	`packed_at` text,
	`packed_workstream_id` text,
	`created_at` text NOT NULL,
	`updated_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`shape_id`) REFERENCES `shapes`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`revision_id`) REFERENCES `shape_attachment_revisions`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`packed_workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE TABLE `task_context_checks` (
	`id` text PRIMARY KEY NOT NULL,
	`task_id` text NOT NULL,
	`workstream_id` text NOT NULL,
	`entry_key` text NOT NULL,
	`entry_version` integer NOT NULL,
	`anchor_index` integer NOT NULL,
	`result` text NOT NULL,
	`line` integer,
	`checked_commit` text NOT NULL,
	`note` text,
	`created_at` text NOT NULL,
	FOREIGN KEY (`task_id`) REFERENCES `tasks`(`id`) ON UPDATE no action ON DELETE no action,
	FOREIGN KEY (`workstream_id`) REFERENCES `workstreams`(`id`) ON UPDATE no action ON DELETE no action
);
--> statement-breakpoint
CREATE INDEX `task_context_checks_workstream_idx` ON `task_context_checks` (`workstream_id`,`checked_commit`);--> statement-breakpoint
CREATE INDEX `task_context_checks_task_idx` ON `task_context_checks` (`task_id`);--> statement-breakpoint
ALTER TABLE `shape_attachments` ADD `doc_key` text;--> statement-breakpoint
ALTER TABLE `shape_attachments` ADD `title` text;--> statement-breakpoint
CREATE UNIQUE INDEX `shape_attachments_doc_key_unique` ON `shape_attachments` (`shape_id`,`doc_key`) WHERE "shape_attachments"."doc_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `revision_id` text REFERENCES shape_attachment_revisions(id);--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `section` text;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `reviewer_name` text;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `severity_text` text;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `outcome_text` text;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `how_detail` text;--> statement-breakpoint
ALTER TABLE `shape_findings` ADD `bundle_key` text;--> statement-breakpoint
CREATE UNIQUE INDEX `shape_findings_bundle_key_unique` ON `shape_findings` (`shape_id`,`bundle_key`) WHERE "shape_findings"."bundle_key" IS NOT NULL;--> statement-breakpoint
ALTER TABLE `shapes` ADD `bundle_id` text;--> statement-breakpoint
ALTER TABLE `shapes` ADD `bundle_origin` text;--> statement-breakpoint
ALTER TABLE `shapes` ADD `imported_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `shapes_bundle_unique` ON `shapes` (`project_id`,`bundle_id`) WHERE "shapes"."bundle_id" IS NOT NULL;