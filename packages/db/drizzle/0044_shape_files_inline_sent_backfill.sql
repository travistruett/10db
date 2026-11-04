-- Authored once, never regenerated. Before 0043 nothing recorded which told files went inline, so a
-- conversation that already exists keeps the old, safe count: every told file may have gone inline.
UPDATE `shape_files` SET `inline_sent` = 1 WHERE `told_at` IS NOT NULL;
