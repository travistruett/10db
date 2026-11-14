# A pass gates what its pull request holds, in a scratch worktree, never per turn

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-10-29-gate-with-base.md`, `decisions/2026-10-28-gate-slots.md`

## Decision

A pass's gate runs on the pushed, immutable tip of its branch, never on Your folder while pages are open.
Where the project allows copies (`delivery: pull_request`) Open Pull Request gates the pushed commit in a
scratch worktree of it (`delivery/scratch-gate.ts`: branch `10db/gate-<6 hex>`, never seeded from the
folder, installed, run by the shipping gate's runner in the shared gate slots with its pid on the batch row,
removed in `finally`, leftovers removed at start-up), and the close gates the tip there again before any
page is taken out. A project with no copies gates in the folder at the close, after the take-outs, and its
early draft says the gate has not run. A failed gate on an open pass is a header notice and a line in the
pull request's body; the batch does not move. A failed gate at the close reopens the pass
(`decisions/2026-11-09-close-pass-shows-its-lists-and-stops-agents-only-on-confirm.md`).

## Why

Workbench spec §2, §8.3, call 7: a gate in the folder reads the open pages' half-done files, which is the
first fact §2 names as wrong with today's flow. A scratch worktree of the pushed commit reads exactly what
the pull request holds. Sharing the gate slots keeps the one-runner rule. Turned down: a gate per turn (it
shares the slot with every lane and tests moving work) and a slot of the pass's own (it broke the one-runner
rule, call 8).
