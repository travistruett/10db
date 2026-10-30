-- Passing the gate no longer raises a review card (decisions/2026-10-30-done-means-merged.md). Its only
-- answer, accept, just closed it, so the open ones stored before that change are withdrawn.
UPDATE `inbox_items` SET `state` = 'CANCELLED', `updated_at` = strftime('%Y-%m-%dT%H:%M:%fZ', 'now') WHERE `kind` = 'review' AND `state` = 'OPEN';
