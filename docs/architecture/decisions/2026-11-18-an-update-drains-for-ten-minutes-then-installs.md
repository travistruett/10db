# An update drains for ten minutes, then installs over the steps still running

- **Date:** 2026-11-18
- **Amends:** `decisions/2026-11-01-recovery-keeps-an-interrupted-task-first-in-line.md`

## Decision

Once the factory has drained for a staged build for `DRAIN_LIMIT_MS` (10 minutes,
`apps/daemon/src/self-update/self-update.ts`), the update installs even with lane steps still running. The install
quits 10db as before; startup recovery puts each cut-off lane back first in line, and its next step starts from its
worktree as it stands, commits and uncommitted edits included. Before the limit nothing changes: the update waits for
an idle moment, then drains, and installs as soon as nothing runs.

## Why

On 2026-11-18 a staged build drained from 13:04 to 14:58 behind one test-cut lane in a single long step. The drain
holds new lanes, gates and ships, so a finished lane could not run its gate and three tasks waited, while the app
stayed four builds behind main. The builder chose a 10-minute cap over 30 minutes and over an uncapped wait that only
held new lane starts: updates land fast, and a long lane redoes at most the step it was in.
