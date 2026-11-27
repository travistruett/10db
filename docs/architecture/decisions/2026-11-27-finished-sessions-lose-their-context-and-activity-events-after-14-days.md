# Finished sessions lose their context and activity events after 14 days

- **Date:** 2026-11-27

## Decision

Every night at 3:00, after the nightly copy is written and old copies are cleared, the daemon deletes the
`session.context` and `session.activity` rows of sessions whose task is `done` or `cancelled` with `updated_at`
more than 14 days ago, whose `ended_at` is more than 14 days ago or null, and which are themselves older than 14
days (`events.at`). It deletes 2,000 rows per write and yields between writes. No other event type is touched,
nothing is deleted for an open task, and the deletes emit no events (as `deleteJudgeCallsBefore`). If the copy or
the old-copy cleanup throws, nothing is deleted that night. A stop ends the run between batches; the next night
resumes.

## Why

On the builder's database (346,508 events over 30 days) these two types are 85% of the event bytes, and the
database and its seven nightly copies grew with them. The readers were checked: `turnLog` and `listTurnActivity`
answer `[]` for a pruned turn, `latestTurnActivity` answers `undefined`, and `listTaskToolCalls` lists fewer
calls. A task reopened after pruning shows empty logs for its earlier runs while it is open. WebSocket replay
skips the gaps, since `seq` is AUTOINCREMENT and never reused. The `e.at` condition keeps every young event, so
`max(seq)` never drops below a client's cursor.

Turned down:

- **Every event type at 30 days.** It deletes the decisions' and tasks' audit trail, which other readers (human
  touch, lane times, rigor figures) use, for little more space.
- **VACUUM.** It needs a long exclusive lock on the only writer, and SQLite's backup API copies free pages anyway,
  so the file and the copies stop growing but do not shrink. A later change could write the nightly copy with
  `VACUUM INTO`.
