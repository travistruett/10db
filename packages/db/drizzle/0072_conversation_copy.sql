-- Authored once, never regenerated. Moves Plan's transcripts and the tasks' threads into the conversation tables,
-- keeping every row's id, so the JSON lists and the references that name a message stay valid. Order is `seq`,
-- numbered in the old id order; a conversation's id is `cnv_` and its owner's UUID.
INSERT INTO `conversations` (`id`, `project_id`, `owner_kind`, `owner_id`, `profile`, `account_id`, `model`,
  `provider_session_id`, `state`, `context_pct`, `next_seq`, `created_at`, `updated_at`)
SELECT 'cnv_' || substr(s.`id`, instr(s.`id`, '_') + 1), s.`project_id`, 'shape', s.`id`, 'explore',
  COALESCE((SELECT x.`account_id` FROM `sessions` x WHERE x.`shape_id` = s.`id`
            ORDER BY x.`started_at` DESC, x.`id` DESC LIMIT 1), p.`account_id`),
  s.`model`, s.`sdk_session_id`, 'idle_cold', NULL,
  (SELECT COUNT(*) FROM `shape_messages` m WHERE m.`shape_id` = s.`id`) + 1, s.`created_at`, s.`updated_at`
FROM `shapes` s JOIN `projects` p ON p.`id` = s.`project_id`;
--> statement-breakpoint
INSERT INTO `conversation_items` (`id`, `conversation_id`, `seq`, `author`, `kind`, `body`, `turn_id`, `partial`,
  `pushed_at`, `push_uuids`, `delivered_at`, `handed_back_at`, `created_at`, `updated_at`)
SELECT m.`id`, 'cnv_' || substr(m.`shape_id`, instr(m.`shape_id`, '_') + 1),
  ROW_NUMBER() OVER (PARTITION BY m.`shape_id` ORDER BY m.`id`),
  CASE m.`author` WHEN 'claude' THEN 'agent' WHEN 'note' THEN 'system' ELSE m.`author` END,
  CASE m.`kind` WHEN 'text' THEN CASE m.`author` WHEN 'builder' THEN 'message' ELSE 'agent_message' END
    WHEN 'tool' THEN 'tool_call' WHEN 'notice' THEN 'notice' WHEN 'digest' THEN 'digest' ELSE 'shape_event' END,
  CASE WHEN m.`kind` IN ('text', 'notice', 'digest') THEN json_object('text', m.`body`)
    WHEN m.`kind` = 'tool' THEN json_object('kind', 'other', 'id', m.`id`, 'harnessTool', '10db.plan',
      'status', 'done', 'title', m.`body`, 'startedAt', m.`created_at`, 'durationMs', NULL, 'parentId', NULL,
      'refusal', NULL, 'deniedBy', NULL, 'limit', NULL, 'soft', NULL,
      'name', '10db.plan', 'inputPreview', substr(m.`body`, 1, 100))
    ELSE json_object('kind', m.`kind`, 'text', m.`body`) END,
  NULL, 0, NULL, '[]',
  CASE WHEN m.`author` = 'builder' AND m.`kind` = 'text' THEN m.`created_at` END,
  NULL, m.`created_at`, m.`created_at`
FROM `shape_messages` m;
--> statement-breakpoint
INSERT INTO `conversation_files` (`id`, `conversation_id`, `item_id`, `name`, `media_type`, `size`, `sha256`,
  `stored_path`, `inline_sent`, `told_at`, `unreadable_told_at`, `created_at`)
SELECT f.`id`, 'cnv_' || substr(f.`shape_id`, instr(f.`shape_id`, '_') + 1), NULL, f.`name`, f.`media_type`,
  f.`size`, NULL, f.`stored_path`, f.`inline_sent`, f.`told_at`, f.`unreadable_told_at`, f.`created_at`
FROM `shape_files` f;
--> statement-breakpoint
INSERT INTO `conversations` (`id`, `project_id`, `owner_kind`, `owner_id`, `profile`, `account_id`, `model`,
  `provider_session_id`, `state`, `context_pct`, `next_seq`, `created_at`, `updated_at`)
SELECT 'cnv_' || substr(t.`id`, instr(t.`id`, '_') + 1), t.`project_id`, 'task', t.`id`, 'lane',
  COALESCE((SELECT x.`account_id` FROM `sessions` x JOIN `workstreams` w ON w.`id` = x.`workstream_id`
            WHERE w.`task_id` = t.`id` ORDER BY x.`started_at` DESC, x.`id` DESC LIMIT 1), p.`account_id`),
  NULL, NULL, NULL, NULL,
  (SELECT COUNT(*) FROM `task_messages` m WHERE m.`task_id` = t.`id`) + 1,
  (SELECT MIN(m.`created_at`) FROM `task_messages` m WHERE m.`task_id` = t.`id`),
  (SELECT MAX(m.`created_at`) FROM `task_messages` m WHERE m.`task_id` = t.`id`)
FROM `tasks` t JOIN `projects` p ON p.`id` = t.`project_id`
WHERE EXISTS (SELECT 1 FROM `task_messages` m WHERE m.`task_id` = t.`id`);
--> statement-breakpoint
INSERT INTO `conversation_items` (`id`, `conversation_id`, `seq`, `author`, `kind`, `body`, `turn_id`, `partial`,
  `pushed_at`, `push_uuids`, `delivered_at`, `handed_back_at`, `created_at`, `updated_at`)
SELECT m.`id`, 'cnv_' || substr(m.`task_id`, instr(m.`task_id`, '_') + 1),
  ROW_NUMBER() OVER (PARTITION BY m.`task_id` ORDER BY m.`id`), m.`author`,
  CASE m.`kind` WHEN 'reply' THEN 'agent_message' ELSE m.`kind` END, json_object('text', m.`body`), m.`turn_id`,
  0, m.`pushed_at`, m.`push_uuids`, m.`delivered_at`, NULL, m.`created_at`, m.`created_at`
FROM `task_messages` m;
--> statement-breakpoint
INSERT INTO `conversation_files` (`id`, `conversation_id`, `item_id`, `name`, `media_type`, `size`, `sha256`,
  `stored_path`, `inline_sent`, `told_at`, `unreadable_told_at`, `created_at`)
SELECT f.`id`, 'cnv_' || substr(f.`task_id`, instr(f.`task_id`, '_') + 1), f.`message_id`, f.`name`, f.`media_type`,
  f.`size`, f.`sha256`, f.`stored_path`, f.`inline_sent`, NULL, NULL, f.`created_at`
FROM `task_files` f;
--> statement-breakpoint
UPDATE `sessions` SET `conversation_id` = 'cnv_' || substr(`shape_id`, instr(`shape_id`, '_') + 1)
WHERE `shape_id` IS NOT NULL;
--> statement-breakpoint
UPDATE `sessions` SET `conversation_id` = (SELECT c.`id` FROM `conversations` c JOIN `workstreams` w
  ON c.`owner_kind` = 'task' AND c.`owner_id` = w.`task_id` WHERE w.`id` = `sessions`.`workstream_id`)
WHERE `workstream_id` IS NOT NULL;
