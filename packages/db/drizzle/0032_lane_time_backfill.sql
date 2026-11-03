-- Shape spec §8: lane time for every workstream that finished before the gate recorded its spans,
-- from its sessions alone and marked sessions-only. A workstream with a session that never ended,
-- or with none, gets no row: it is left out of bases, medians and the measure.
INSERT INTO `task_lane_times` (`workstream_id`, `task_id`, `lane_minutes`, `sessions_only`, `created_at`)
SELECT w.`id`, w.`task_id`,
  SUM(MAX(0, (julianday(s.`ended_at`) - julianday(s.`started_at`)) * 1440)),
  1,
  strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
FROM `workstreams` w
JOIN `sessions` s ON s.`workstream_id` = w.`id`
WHERE w.`state` = 'DONE'
GROUP BY w.`id`
HAVING COUNT(s.`ended_at`) = COUNT(*);
