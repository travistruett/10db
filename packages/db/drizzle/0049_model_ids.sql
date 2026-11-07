-- Authored once, never regenerated. Routing names models by their canonical IDs; this renames the four
-- Claude Code aliases that older rows stored, and drops the two account settings that mapped and listed
-- them. These four names are history, not data anyone updates.
--
-- Every `model` column, decided:
--   model_profiles.model        renamed; a canonical row that reconcile already wrote absorbs the alias row.
--   workstreams.model           renamed: it is the model of the step the workstream is on.
--   workstreams.steps[].model   renamed, with the step's profileId following a merged profile.
--   personas.model_pin.model    renamed: a pin names a model to run on.
--   shapes.model                renamed: the model the conversation will be launched with.
--   sessions.model              kept: the model a session ran on is history.
--   judge_calls.model           kept: the model a past question was asked of is history.
--   account_models.model        kept: an account's list holds canonical IDs and never an alias.
CREATE TEMP TABLE `_model_alias` (`alias` text PRIMARY KEY NOT NULL, `canonical` text NOT NULL);
--> statement-breakpoint
INSERT INTO `_model_alias` (`alias`, `canonical`) VALUES
  ('haiku', 'claude-haiku-5-5'),
  ('sonnet', 'claude-sonnet-5-5'),
  ('opus', 'claude-opus-5-5'),
  ('fable', 'claude-fable-5-1');
--> statement-breakpoint
CREATE TEMP TABLE `_profile_merge` AS
  SELECT a.`id` AS `old_id`, c.`id` AS `new_id`
  FROM `model_profiles` a
  JOIN `_model_alias` m ON a.`model` = m.`alias`
  JOIN `model_profiles` c ON c.`provider` = a.`provider` AND c.`model` = m.`canonical` AND c.`effort` = a.`effort`;
--> statement-breakpoint
UPDATE `model_profiles` AS c SET
  `steps_run` = c.`steps_run` + a.`steps_run`,
  `first_pass_steps` = c.`first_pass_steps` + a.`first_pass_steps`,
  `escalations` = c.`escalations` + a.`escalations`,
  `aa_slug` = COALESCE(c.`aa_slug`, a.`aa_slug`)
FROM `_profile_merge` x JOIN `model_profiles` a ON a.`id` = x.`old_id`
WHERE c.`id` = x.`new_id`;
--> statement-breakpoint
-- Scores come from whichever row has them; when both do, from the newer measurement.
UPDATE `model_profiles` AS c SET
  `intelligence` = a.`intelligence`,
  `coding` = a.`coding`,
  `agentic` = a.`agentic`,
  `cost_per_task_usd` = a.`cost_per_task_usd`,
  `output_tokens_per_second` = a.`output_tokens_per_second`,
  `source` = a.`source`,
  `index_version` = a.`index_version`,
  `measured_at` = a.`measured_at`
FROM `_profile_merge` x JOIN `model_profiles` a ON a.`id` = x.`old_id`
WHERE c.`id` = x.`new_id`
  AND (a.`intelligence` IS NOT NULL OR a.`coding` IS NOT NULL OR a.`agentic` IS NOT NULL OR a.`cost_per_task_usd` IS NOT NULL)
  AND (
    (c.`intelligence` IS NULL AND c.`coding` IS NULL AND c.`agentic` IS NULL AND c.`cost_per_task_usd` IS NULL)
    OR COALESCE(a.`measured_at`, '') > COALESCE(c.`measured_at`, '')
  );
--> statement-breakpoint
UPDATE `workstreams` SET `steps` = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(s.`value`, '$.model') IN (SELECT `alias` FROM `_model_alias`)
      THEN json_set(
        s.`value`,
        '$.model', (SELECT `canonical` FROM `_model_alias` WHERE `alias` = json_extract(s.`value`, '$.model')),
        '$.profileId', COALESCE(
          (SELECT `new_id` FROM `_profile_merge` WHERE `old_id` = json_extract(s.`value`, '$.profileId')),
          json_extract(s.`value`, '$.profileId')
        )
      )
      ELSE s.`value`
    END))
  FROM json_each(`workstreams`.`steps`) s
)
WHERE json_valid(`steps`) AND EXISTS (
  SELECT 1 FROM json_each(`workstreams`.`steps`) s
  WHERE json_extract(s.`value`, '$.model') IN (SELECT `alias` FROM `_model_alias`)
);
--> statement-breakpoint
DELETE FROM `model_profiles` WHERE `id` IN (SELECT `old_id` FROM `_profile_merge`);
--> statement-breakpoint
UPDATE `model_profiles` SET `model` = (SELECT `canonical` FROM `_model_alias` WHERE `alias` = `model_profiles`.`model`)
WHERE `model` IN (SELECT `alias` FROM `_model_alias`);
--> statement-breakpoint
-- Fable was seeded off for routing. Tiers and patterns decide when it runs now, so it is on.
UPDATE `model_profiles` SET `enabled` = 1 WHERE `model` = 'claude-fable-5-1';
--> statement-breakpoint
UPDATE `workstreams` SET `model` = (SELECT `canonical` FROM `_model_alias` WHERE `alias` = `workstreams`.`model`)
WHERE `model` IN (SELECT `alias` FROM `_model_alias`);
--> statement-breakpoint
UPDATE `personas` SET `model_pin` = json_set(
  `model_pin`, '$.model', (SELECT `canonical` FROM `_model_alias` WHERE `alias` = json_extract(`personas`.`model_pin`, '$.model'))
)
WHERE json_valid(`model_pin`) AND json_extract(`model_pin`, '$.model') IN (SELECT `alias` FROM `_model_alias`);
--> statement-breakpoint
UPDATE `shapes` SET `model` = (SELECT `canonical` FROM `_model_alias` WHERE `alias` = `shapes`.`model`)
WHERE `model` IN (SELECT `alias` FROM `_model_alias`);
--> statement-breakpoint
UPDATE `accounts` SET `settings` = json_remove(`settings`, '$.modelMap', '$.aliases')
WHERE json_valid(`settings`);
--> statement-breakpoint
DROP TABLE `_profile_merge`;
--> statement-breakpoint
DROP TABLE `_model_alias`;
