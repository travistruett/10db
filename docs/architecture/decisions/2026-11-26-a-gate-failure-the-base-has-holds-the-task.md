# A gate failure the base already has holds the task, not a fix loop

- **Date:** 2026-11-26

## Decision

- A task's gate failure whose keys are all on a red verdict of its base, with no test file the task changed,
  holds the task on one Inbox card per project and base branch. The hold counts no fix attempt, and the task
  gates again when the base moves (`docs/superpowers/specs/2026-11-26-base-red-gate-waits-for-the-base-design.md`).
- 10db never runs a gate only to learn the base's state. A base's verdict comes from gates 10db already runs: a
  gate on a commit of the base, a landing gate that passed, or two unrelated tasks failing the same way on one
  base.
- Gate output that names no step is one key, `exit:<code>`.

## Why

On Ampsio, on 2026-11-24, the base was red at 705b5807f (130 tests and 35 mypy errors on a clean tree), and a
task that touched only `.env` was sent to fix them, outside its claim. CI already sorts a red base from a pull
request's own failure (`decisions/2026-11-24-a-red-base-is-one-fix-not-a-fix-per-pull-request.md`); the gate on
the Mac had no such rule. Gating the base tip was turned down: a shared folder can't check out the base, and a
project whose gate runs in containers synced from the main checkout can't gate a detached worktree. A baseline
gate per base move was turned down for its cost, about 18 minutes per move on Ampsio. Opaque output as one key
accepts that a task's own failure can hide behind a red base until the base is green, which the regate on a base
move bounds.
