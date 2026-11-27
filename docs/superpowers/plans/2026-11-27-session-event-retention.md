# Session event retention

Size: Core (deletes the builder's rows). One task, about 60 lines of code, one pull request.

## Brief

**What changes for the builder.** Every night at 3:00, after the nightly copy is written and old copies are cleared,
the daemon deletes the `session.context` and `session.activity` rows of sessions whose task has been done or
cancelled for more than 14 days (measured from when the task was last touched) and that are themselves older than
14 days. It deletes 2,000 rows per transaction and lets other work run between transactions.
No other event type is touched, and nothing is deleted for an open task, however old its sessions are.

**What it buys.** On the builder's database (346,508 events over 30 days), these two types are 85% of the event
bytes. They are kept from now on only for live work and the last two weeks of finished work.

**What could go wrong, and how we'd know.**
- A task finished more than two weeks ago shows an empty turn log in the Workbench (`turnLog`). That's expected.
- If the query matched the wrong sessions, an open task would lose its log and its page's live activity. The test
  guards against this.
- A long first run could hold up writes. Each batch is small, and the log records the total deleted and how long it
  took.

- Open tasks are never pruned: a failed or abandoned task left open keeps its rows, so "stops growing" holds for
  finished work. A backup that keeps failing also stops the prune, since it runs after the backup.

**Calls the builder might disagree with.**
1. "Done" includes cancelled tasks. "More than 14 days" is measured from the task's `updated_at`, the same reading
   `listFinishedTurnScreens` uses (`task-screens.ts:278`), and the session's `ended_at` must also be older than 14
   days (or null).
2. **No VACUUM.** SQLite's backup API copies every page, free ones included, so neither the database file nor the
   nightly copies shrink. They stop growing, because new rows reuse the freed pages. To shrink them, a later change
   could write the nightly copy with `VACUUM INTO`, which produces a compacted copy.
3. The deletes emit no events, following the precedent of `deleteJudgeCallsBefore` (`judge-calls.ts:285`).

**Needed from the builder:** nothing. The builder approved the rule in chat (only these two types, 14 days, nightly
after the backup).

## Global Constraints

- `.claude/rules/code-style.md`, `.claude/rules/testing.md` and `packages/db/AGENTS.md`.
- `events` stops being immutable: `packages/db/AGENTS.md` (which lists it as an append-only record table, immutable
  once written) and `docs/architecture/db-storage.md` say so, and a decision file
  `docs/architecture/decisions/2026-11-27-finished-sessions-lose-their-context-and-activity-events-after-14-days.md`
  records the rule and why.
- No migration. The join order is pinned with `CROSS JOIN`: `tasks` (small and filtered), then `workstreams` by
  `workstreams_task_idx`, then `sessions` by `sessions_workstream_idx`, then `events` by `events_entity_idx`
  (entity_type, entity_id, type). Without `sqlite_stat1` the planner could otherwise scan `events` first inside the
  write lock. Check EXPLAIN QUERY PLAN shows `SEARCH events USING INDEX events_entity_idx`. Each batch re-probes
  sessions already pruned, about two index seeks per finished session, which is fine at this size.
- Defence in depth: the delete also requires `e.at < :cutoff`, so no event younger than 14 days is ever deleted,
  whatever the task and session rows say. This also keeps `max(seq)` (`/events/head`) from dropping below a cursor.
- One `state.write` per batch, with a `setImmediate` yield between batches. The stop signal is checked immediately
  before every write, the first included. It is aborted at the top of `shutdown()`, so no batch starts during a
  stop.
- A batch's lock time ships measured (a temp copy of a database of about 350,000 events), or the PR says it is
  unverified.
- If the backup or the old-copy cleanup throws, nothing is deleted that night. A failed delete is logged as its own
  warning, not as "nightly backup failed".

## Provider parity

None applies. `runner.ts` (around 4355 and 4511) writes both types for every provider's lane session, and the rule
doesn't depend on the provider.

## Interfaces

```ts
// packages/db/src/store/events.ts
/**
 * Deletes up to `limit` session.context and session.activity rows of sessions whose task was done or cancelled
 * before `cutoff` (ISO) and that ended before it or never ended; answers how many.
 */
export function deleteSessionEventsEndedBefore(ctx: WriteContext, cutoff: string, limit: number): number;

// apps/daemon/src/daemon/start.ts
const SESSION_EVENTS_RETENTION_MS = 14 * 24 * 60 * 60 * 1000;
const SESSION_EVENTS_PRUNE_BATCH = 2_000;
```

Shape: `DELETE FROM events WHERE seq IN (SELECT e.seq FROM sessions s JOIN workstreams w ON w.id = s.workstream_id
JOIN tasks t ON t.id = w.task_id JOIN events e ON e.entity_type = 'session' AND e.entity_id = s.id AND e.type IN (…)
WHERE t.status IN ('done','cancelled') AND t.updated_at < :cutoff AND (s.ended_at IS NULL OR s.ended_at < :cutoff)
AND e.at < :cutoff LIMIT :limit)`, with the joins written as `CROSS JOIN` from `tasks` (see Global Constraints).

## State table (design, not a test list)

| Case | Result |
| --- | --- |
| Task done or cancelled before the cutoff, session ended before it | its two types deleted |
| The same session's other types (`session.started`, `session.ended`, …) | kept |
| Task open (waiting, paused, in review, reopened), any session age | kept |
| Task finished within the last 14 days | kept |
| Session ended after the cutoff, task finished before it | kept |
| Session never ended, task finished before the cutoff | deleted |
| Session of a conversation only (no workstream) | not matched; the runner writes neither type for it |
| More rows than one batch | loop until a batch returns fewer than the batch size |
| Daemon stops between batches | stop; resume the next night |
| Backup throws | nothing deleted |
| `turnLog` / `listTurnActivity` on a pruned turn | `[]` |
| `latestTurnActivity` | `undefined`; `activityOf` gives null, `turnFilesSoFar` gives `[]` |
| `listTaskToolCalls` | fewer calls. A done, pruned, reopened task put in a pass can now get a before picture where it was refused; benign, since its earlier PR closed unmerged and Codex runs are still caught by `codexStarts` |
| Task reopened after its rows were pruned | its earlier runs show empty logs while it is open |
| WebSocket replay `listEventsAfter` | skips the gaps; `seq` is AUTOINCREMENT and never reused |

## Tasks

1. `task-1.md`: prune session events nightly.
