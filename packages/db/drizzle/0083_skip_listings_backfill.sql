-- Trust line §5: every run that ended before runs were listed counts as checked, with no item, so
-- the first start after the upgrade raises no Skipped while you were away item for an old run. The
-- listing reuses its run's UUID, which is unique per run and already a UUIDv7.
INSERT INTO `skip_listings` (`id`, `workstream_id`, `through_skip_id`, `inbox_item_id`, `created_at`)
SELECT 'skl_' || substr(w.`id`, 4), w.`id`, NULL, NULL, strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `workstreams` w
WHERE w.`state` IN ('DONE', 'FAILED');
