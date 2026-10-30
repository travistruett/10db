# An implement step is checked by the project's changed-packages command; the ship gate stays the full gate

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-28-optional-gate.md` (a project may now have two check commands)

## Decision

A project has an optional `changedCheckCommand` beside its `gateCommand` (`projects.changed_check_command`,
Settings › General, "Check after each step").

- The runner's verify step, which follows every step that changes files, runs `changedCheckCommand` when the
  project has one, else `gateCommand`. Its gate evidence records the command that ran. Nothing else about
  the step changes: the same gate slot, sandbox, timeout, base update and send-back on a failure.
- The shipper's gate, before the push, always runs `gateCommand`, the full gate. A project with no
  `changedCheckCommand` behaves as it did.
- A project with no `gateCommand` is checked by the builder whatever `changedCheckCommand` says: the
  changed-packages command narrows a gate, it never replaces having one.
- An edit step may run `changedCheckCommand` without a permission card, as it may the gate command. A
  read-only step may run neither.
- The Board names the command that checks a step ("Checking: make check-changed"); the batch sheet says
  which runs after each step and which before the push.

For this repository the command is `make check-changed` (`scripts/check-changed.mjs`). The builder sets it in
Settings; the database holds it, so no file in the repository does. It diffs against the branch's base
(upstream, else `origin/main`, else `main`), places each changed file in a workspace package, and runs, for the
changed packages, format, lint and drift, and for them and everything that depends on them, typecheck and the
tests. Format, lint and typecheck run together and the tests alone, because the UI tests' wait timeouts flake
when lint shares the machine. It runs the full gate (`scripts/gate.sh`) instead when it cannot place a file:
no base to diff against, or a changed file outside every package that is not documentation or a script (the
lockfile, a root config, CI, the Makefile, the gate script). A change to `apps/desktop/src-tauri` adds the Rust
checks. Changes to docs or scripts add `tests/repo`, whose tests read them.

## Why

The full `make gate` takes about seven minutes of CPU, and only one gate runs at a time on the machine, so
running it after every implement step re-checked packages the task never touched and capped throughput at
about four tasks an hour. A desktop-only change now takes about a minute and a half. The ship gate still runs
everything before the push, so nothing reaches origin unchecked.

Turned down: guessing the changed packages inside the daemon. The daemon doesn't know a project's layout; a
per-project command does, and a project without one is unchanged. Turned down: parsing `make gate`'s steps to
narrow them: the narrowing is the repository's rule, so it lives in the repository.

This is a stopgap until GitHub CI decides whether a task ships.
