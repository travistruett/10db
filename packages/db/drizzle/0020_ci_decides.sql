ALTER TABLE `batches` ADD `pr_required` text;--> statement-breakpoint
ALTER TABLE `batches` ADD `pr_merge_blocked` text;--> statement-breakpoint
ALTER TABLE `batches` ADD `ci_fix_of` text REFERENCES batches(id);--> statement-breakpoint
ALTER TABLE `batches` ADD `ci_fix_head` text;--> statement-breakpoint
ALTER TABLE `batches` ADD `ci_stopped` text;--> statement-breakpoint
CREATE UNIQUE INDEX `batches_ci_fix_idx` ON `batches` (`ci_fix_of`,`ci_fix_head`) WHERE ci_fix_of IS NOT NULL AND ci_fix_head IS NOT NULL;--> statement-breakpoint
ALTER TABLE `projects` ADD `precheck_command` text;