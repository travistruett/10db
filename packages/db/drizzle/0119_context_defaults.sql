-- Projects still on the old untuned context thresholds (40 / 50) take the new defaults (30 / 40); a pair the builder changed is kept.
UPDATE projects SET handoff_pct = 30, nudge_pct = 40, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE handoff_pct = 40 AND nudge_pct = 50;
