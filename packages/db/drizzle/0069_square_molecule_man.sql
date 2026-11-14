CREATE TABLE `openrouter_measures` (
	`id` text NOT NULL,
	`kind` text NOT NULL,
	`key` text NOT NULL,
	`intelligence` real,
	`coding` real,
	`agentic` real,
	`accuracy` real,
	`cost_per_task_usd` real,
	`tokens_per_second` real,
	`latency_ms` real,
	`measured_at` text NOT NULL,
	PRIMARY KEY(`id`, `kind`, `key`)
);
