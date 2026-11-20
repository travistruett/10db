-- A plan that fed the Board becomes an archived session: a chat over the conversation it owned, titled as
-- the plan was. A plan that fed nothing is deleted below. A plan fed the Board when a task's context or a
-- landing group names it, or one of its links made a goal or a task.
INSERT INTO `chats` (`id`, `project_id`, `conversation_id`, `title`, `title_source`, `mode`, `task_id`, `pass_id`,
  `tab_position`, `created_at`, `updated_at`, `last_activity_at`, `archived_at`)
SELECT 'cht' || substr(s.id, instr(s.id, '_')), s.`project_id`, c.`id`, s.`title`, 'builder', 'explore', NULL, NULL,
  NULL, s.`created_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now'), s.`updated_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `shapes` s JOIN `conversations` c ON c.`owner_kind` = 'shape' AND c.`owner_id` = s.`id`
WHERE s.`id` IN (SELECT `shape_id` FROM `task_context`)
  OR s.`id` IN (SELECT `shape_id` FROM `landing_groups` WHERE `shape_id` IS NOT NULL)
  OR s.`id` IN (SELECT `shape_id` FROM `shape_links` WHERE `goal_id` IS NOT NULL OR `task_id` IS NOT NULL);
--> statement-breakpoint
-- The chat names its plan.
UPDATE `shapes` SET `chat_id` = 'cht' || substr(`id`, instr(`id`, '_'))
WHERE 'cht' || substr(`id`, instr(`id`, '_')) IN (SELECT `id` FROM `chats`);
--> statement-breakpoint
-- The conversation becomes the chat's, with the plan's effort.
UPDATE `conversations`
SET `owner_kind` = 'chat', `owner_id` = 'cht' || substr(`owner_id`, instr(`owner_id`, '_')),
  `effort` = coalesce(`effort`, (SELECT `effort` FROM `shapes` WHERE `id` = `conversations`.`owner_id`))
WHERE `owner_kind` = 'shape' AND `owner_id` IN (SELECT `id` FROM `shapes` WHERE `chat_id` IS NOT NULL);
--> statement-breakpoint
-- A kept conversation's press that never reached a turn stops being a turn starter, so reopening the
-- session starts nothing; the row stays in the transcript.
UPDATE `conversation_items` SET `body` = json_remove(`body`, '$.prompt', '$.rehearsing')
WHERE `kind` = 'shape_event' AND `pushed_at` IS NULL AND `delivered_at` IS NULL
  AND `conversation_id` IN (SELECT `conversation_id` FROM `chats`
    WHERE `id` IN (SELECT `chat_id` FROM `shapes` WHERE `chat_id` IS NOT NULL));
--> statement-breakpoint
-- Every other plan goes, its children first.
DELETE FROM `shape_entry_versions` WHERE `entry_id` IN (SELECT `id` FROM `shape_entries` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`)));
--> statement-breakpoint
DELETE FROM `shape_entries` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_shadow_answers` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_findings` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_rehearsals` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_attachment_revisions` WHERE `attachment_id` IN (SELECT `id` FROM `shape_attachments` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`)));
--> statement-breakpoint
DELETE FROM `shape_attachments` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_links` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_questions` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
DELETE FROM `shape_proposals` WHERE `shape_id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
--> statement-breakpoint
-- A session of a deleted plan keeps its row and cost but names no conversation. One left open by a crash or
-- an update ends here, since a session with neither a workstream nor a conversation must have ended.
UPDATE `sessions`
SET `conversation_id` = NULL, `ended_at` = coalesce(`ended_at`, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')),
  `exit_reason` = coalesce(`exit_reason`, 'daemon_restart')
WHERE `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `owner_kind` = 'shape');
--> statement-breakpoint
DELETE FROM `conversation_files` WHERE `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `owner_kind` = 'shape');
--> statement-breakpoint
DELETE FROM `conversation_items` WHERE `conversation_id` IN (SELECT `id` FROM `conversations` WHERE `owner_kind` = 'shape');
--> statement-breakpoint
DELETE FROM `conversations` WHERE `owner_kind` = 'shape';
--> statement-breakpoint
DELETE FROM `shapes` WHERE `id` IN (SELECT id FROM `shapes` WHERE `chat_id` IS NULL OR `chat_id` NOT IN (SELECT `id` FROM `chats`));
