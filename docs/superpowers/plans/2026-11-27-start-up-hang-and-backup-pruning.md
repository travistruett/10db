# Start-up hang watch and pre-migrate backup pruning

Size: Core (recovery, and deleting backups). Two tasks, about 80 lines of code together; each is its own pull
request.

## Brief

**What changes for the builder.**
- A daemon that hangs while starting is killed and started again, instead of leaving 10db "Connecting" forever.
- A daemon that crashes on every start no longer fills the disk with copies of the database. Only the newest 5
  copies taken before a migration are kept, as the nightly ones keep 7.
- On this Mac, the next start after a migration removes 64 of the 69 pre-migrate copies (about 6 GB).

**What it buys.** Two ways 10db stays down, or fills the disk, with nothing replacing it or cleaning up.

**What could go wrong, and how we'd know.**
- A slow but healthy start is killed. A start that legitimately runs past 10 minutes (a long migration on a big
  database) is killed once. The next attempt gets 20 minutes, then 40, so it still finishes.
  `logs/sidecar.log` says "the daemon did not finish starting in N min".
- The copies kept are bad ones. A crash loop now takes the same copy of the same database at each start, so the 5
  kept are copies of the state before the failing migration. A start killed while copying would leave a
  half-written file among the 5 kept, so a copy is written under a temporary name and renamed when complete.

**Calls the builder might disagree with.**
- 5 pre-migrate copies, not "one per migration set". It's the rule the nightly copies already use; the builder
  approved it in chat.
- 10 minutes, doubling up to 80. A start today takes seconds; the deadline is there for a hang, not for speed.

**Needed from the builder:** nothing.

## Global Constraints

- `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- Desktop (Rust): `cargo fmt`, `cargo clippy` with the crate's lints, `cargo test` in `apps/desktop/src-tauri`.
- Daemon: typecheck, lint and `vitest related` on the files changed.
- No migration, no contract change, no new dependency.
- Provider parity: neither task touches an account or a provider; both behave the same on every one.
- Comments say what and why, timelessly.

## Interfaces

Task 1 (`apps/desktop/src-tauri/src/supervisor.rs`):

```rust
/// How long a daemon may take to write a `daemon.json` that names it before it counts as hung.
pub const START_DEADLINE: Duration = Duration::from_mins(10);
/// The longest start deadline, however many hung starts came before.
pub const START_DEADLINE_MAX: Duration = Duration::from_mins(80);

/// The start deadline after `hung` consecutive hung starts: doubling from `START_DEADLINE`, capped.
pub fn start_deadline(hung: u32) -> Duration;
```

`ChildHealth` gains `StartHung`. `wait_for_exit` returns a third flag (or a small enum replacing the two bools)
saying the child was killed as hung in start-up.

Task 2 (`apps/daemon/src/backups/index.ts`, `apps/daemon/src/daemon/start.ts`):

```ts
// DEFAULTS in start.ts
preMigrateBackupsKept: 5,
```

`backupDatabase` keeps its signature; it writes `<file>.partial` and renames it to `<file>` once SQLite's backup
resolves. `pruneBackups` keeps its signature and already ignores names that don't end in `.sqlite`.

## State table (design, not a test list)

| Child state                                   | Today                    | After                                                           |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| No `daemon.json` naming it, under deadline    | waits                    | waits                                                           |
| No `daemon.json` naming it, past deadline     | waits forever            | killed, logged, restarted with backoff; next deadline doubles   |
| Serving, answers /health                      | fine                     | fine; consecutive-hang count resets to 0                        |
| Serving, silent past `frozen_after`           | freeze kill              | unchanged                                                       |
| Exits by itself in start-up                   | restart per exit policy  | unchanged                                                       |
| Shell quitting                                | no judging               | no judging                                                      |

| Start with pending migrations                 | Today                    | After                                                           |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Copy completes                                | `10db-pre-migrate-*.sqlite` added | added, then all but the newest 5 pre-migrate copies removed |
| Killed mid-copy                               | half-written `.sqlite`   | a `.partial` left; never counted, never restored from           |
| Copy fails (disk full)                        | start fails              | unchanged (start fails, no prune)                               |

## Tasks

1. `task-1.md`: the supervisor kills a daemon that never finishes starting (Rust, desktop).
2. `task-2.md`: pre-migrate copies are written whole and pruned to 5 (daemon).

The two touch no file in common and run in parallel.
