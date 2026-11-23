-- Each send takes the workspace of its first recipient's contact, matched on person and Slack user so a
-- contact re-pointed at another user since does not claim old sends.
UPDATE stakeholder_sends SET team_id = (
  SELECT pc.team_id FROM stakeholder_send_people sp
  JOIN person_contacts pc ON pc.person_id = sp.person_id AND pc.user_id = sp.user_id
  WHERE sp.send_id = stakeholder_sends.id AND sp.recipient = 1
  ORDER BY sp.position LIMIT 1
) WHERE team_id IS NULL;
--> statement-breakpoint
-- A send with no matching contact takes the workspace signed in now. Every writer before this migration kept
-- at most one entry in `slack.workspaces`, so `$[0]` is that one; this is the only place that reads the first
-- entry.
UPDATE stakeholder_sends SET team_id = (
  SELECT json_extract(value, '$[0].teamId') FROM app_settings WHERE key = 'slack.workspaces'
) WHERE team_id IS NULL;
--> statement-breakpoint
-- A live send that still has no workspace can never be posted or read: hand its card to the builder, as a
-- failed send does. Done before the sends change state, since it selects them by their null team.
UPDATE inbox_items SET assignees = '["me"]', routed_by = 'builder', route_suggestion = NULL,
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE id IN (
  SELECT inbox_item_id FROM stakeholder_sends
  WHERE team_id IS NULL AND state IN ('sending', 'sent')
);
--> statement-breakpoint
-- Fail those sends. A draft is left as a draft (a failed send never comes from one); closed, failed and
-- answered sends keep a null team as history that counts for no workspace.
UPDATE stakeholder_sends SET state = 'failed', error = 'no_workspace',
  updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
WHERE team_id IS NULL AND state IN ('sending', 'sent');
--> statement-breakpoint
-- Every project without a stored choice is bound to the workspace signed in now. OR IGNORE keeps a stored
-- choice, Off included.
INSERT OR IGNORE INTO app_settings (key, value, updated_at)
SELECT 'slack.' || p.id, json_object('teamId', json_extract(s.value, '$[0].teamId')),
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM projects p JOIN app_settings s ON s.key = 'slack.workspaces'
WHERE json_array_length(s.value) > 0;
