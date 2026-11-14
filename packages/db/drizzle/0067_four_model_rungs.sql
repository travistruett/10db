-- Authored once, never regenerated. The three model tiers became four rungs: `fast` is `efficient`, and
-- `strongest` is `capable` (its dearest models become Frontier when the catalogue is next read; a stored
-- setting keeps meaning the cheapest model of what it named). Balanced is unchanged. Values are mapped by
-- JSON path, never by text replace over whole documents.
--
-- Every place a tier name is stored, decided:
--   model_profiles.tier           mapped; the next catalogue read ranks the models again.
--   role_settings.setting         mapped where `$.kind` is `tier`.
--   patterns.setting              mapped, the same.
--   tasks.model_setting           mapped, the same.
--   workstreams.steps[]           each step's `setting.tier`, and a step's `model` that is a tier name
--                                 (planned when the account offered nothing to run it on).
--   workstreams.model             mapped where it is a tier name, like the step it names.
--   accounts.settings             `tierOverrides.fast` moves to `.efficient`; `.strongest` is copied to both
--                                 `.capable` and `.frontier`, so each lands on the model it chose before.
--   shapes.model, personas.model_pin, sessions.model, judge_calls.model
--                                 kept: they hold a model, never a tier name.
UPDATE `model_profiles` SET `tier` = CASE `tier` WHEN 'fast' THEN 'efficient' ELSE 'capable' END
WHERE `tier` IN ('fast', 'strongest');
--> statement-breakpoint
UPDATE `role_settings` SET `setting` = json_set(`setting`, '$.tier',
  CASE json_extract(`setting`, '$.tier') WHEN 'fast' THEN 'efficient' ELSE 'capable' END)
WHERE json_valid(`setting`) AND json_extract(`setting`, '$.kind') = 'tier'
  AND json_extract(`setting`, '$.tier') IN ('fast', 'strongest');
--> statement-breakpoint
UPDATE `patterns` SET `setting` = json_set(`setting`, '$.tier',
  CASE json_extract(`setting`, '$.tier') WHEN 'fast' THEN 'efficient' ELSE 'capable' END)
WHERE json_valid(`setting`) AND json_extract(`setting`, '$.kind') = 'tier'
  AND json_extract(`setting`, '$.tier') IN ('fast', 'strongest');
--> statement-breakpoint
UPDATE `tasks` SET `model_setting` = json_set(`model_setting`, '$.tier',
  CASE json_extract(`model_setting`, '$.tier') WHEN 'fast' THEN 'efficient' ELSE 'capable' END)
WHERE `model_setting` IS NOT NULL AND json_valid(`model_setting`)
  AND json_extract(`model_setting`, '$.kind') = 'tier'
  AND json_extract(`model_setting`, '$.tier') IN ('fast', 'strongest');
--> statement-breakpoint
UPDATE `workstreams` SET `steps` = (
  SELECT json_group_array(json(
    CASE WHEN json_extract(m.`step`, '$.model') IN ('fast', 'strongest')
      THEN json_set(m.`step`, '$.model',
        CASE json_extract(m.`step`, '$.model') WHEN 'fast' THEN 'efficient' ELSE 'capable' END)
      ELSE m.`step`
    END) ORDER BY m.`pos`)
  FROM (
    SELECT s.`key` AS `pos`,
      CASE WHEN json_extract(s.`value`, '$.setting.kind') = 'tier'
          AND json_extract(s.`value`, '$.setting.tier') IN ('fast', 'strongest')
        THEN json_set(s.`value`, '$.setting.tier',
          CASE json_extract(s.`value`, '$.setting.tier') WHEN 'fast' THEN 'efficient' ELSE 'capable' END)
        ELSE s.`value`
      END AS `step`
    FROM json_each(`workstreams`.`steps`) s
  ) m
)
WHERE json_valid(`steps`) AND EXISTS (
  SELECT 1 FROM json_each(`workstreams`.`steps`) s
  WHERE json_extract(s.`value`, '$.model') IN ('fast', 'strongest')
    OR (json_extract(s.`value`, '$.setting.kind') = 'tier'
      AND json_extract(s.`value`, '$.setting.tier') IN ('fast', 'strongest'))
);
--> statement-breakpoint
UPDATE `workstreams` SET `model` = CASE `model` WHEN 'fast' THEN 'efficient' ELSE 'capable' END
WHERE `model` IN ('fast', 'strongest');
--> statement-breakpoint
UPDATE `accounts` SET `settings` = json_remove(
  json_set(`settings`, '$.tierOverrides.efficient', json_extract(`settings`, '$.tierOverrides.fast')),
  '$.tierOverrides.fast')
WHERE json_valid(`settings`) AND json_extract(`settings`, '$.tierOverrides.fast') IS NOT NULL;
--> statement-breakpoint
UPDATE `accounts` SET `settings` = json_remove(
  json_set(`settings`,
    '$.tierOverrides.capable', json_extract(`settings`, '$.tierOverrides.strongest'),
    '$.tierOverrides.frontier', json_extract(`settings`, '$.tierOverrides.strongest')),
  '$.tierOverrides.strongest')
WHERE json_valid(`settings`) AND json_extract(`settings`, '$.tierOverrides.strongest') IS NOT NULL;
