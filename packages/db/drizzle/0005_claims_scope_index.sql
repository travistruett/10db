DROP INDEX `claims_active_unique`;--> statement-breakpoint
CREATE UNIQUE INDEX `claims_active_unique` ON `claims` (`scope`,`kind`,`name`) WHERE released_at IS NULL;