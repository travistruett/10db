CREATE TABLE `mcp_server_approvals` (
	`project_id` text NOT NULL,
	`server_name` text NOT NULL,
	`config_hash` text NOT NULL,
	`verdict` text NOT NULL,
	`variables` text NOT NULL,
	`source_inbox_id` text,
	`updated_at` text NOT NULL,
	PRIMARY KEY(`project_id`, `server_name`, `config_hash`),
	FOREIGN KEY (`project_id`) REFERENCES `projects`(`id`) ON UPDATE no action ON DELETE no action
);
