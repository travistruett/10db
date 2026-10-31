-- Placement moves onto the task (task placement spec, P1 and §4). Each task gets where Start would run
-- it today: a separate copy in a worktree-mode project, the project's own checkout everywhere else.
-- A finished task's value is never shown, so where it ran is not recovered.
UPDATE `tasks` SET `workspace_mode` = 'worktree'
  WHERE `project_id` IN (SELECT `id` FROM `projects` WHERE `workspace_mode` = 'worktree');--> statement-breakpoint
UPDATE `tasks` SET `workspace_mode` = 'shared'
  WHERE `project_id` NOT IN (SELECT `id` FROM `projects` WHERE `workspace_mode` = 'worktree');
