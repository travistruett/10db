ALTER TABLE `chats` ADD `work_place` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `worktree_path` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `branch` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `base_head` text;--> statement-breakpoint
ALTER TABLE `chats` ADD `work_asked_at` text;--> statement-breakpoint
CREATE UNIQUE INDEX `chats_worktree_path_unique` ON `chats` (`worktree_path`) WHERE worktree_path IS NOT NULL;