# Start-up hang watch and pre-migrate backup pruning

Size: Core (recovery, and deleting backups). Three tasks, about 120 lines of code together, in two pull requests:
task 1 (desktop, Rust) and tasks 2-3 (daemon).

## Brief

**What changes for the builder.**
- A daemon that hangs while starting is killed and started again, instead of leaving 10db "Connecting" forever.
- A daemon that crashes on every start no longer fills the disk with copies of the database. Only the newest 5
  copies taken before a migration are kept, as the nightly ones keep 7.
- On this Mac, the next start after a migration removes 64 of the 69 pre-migrate copies (about 6 GB).
- A daemon left starting by a shell that quit or crashed stops itself, instead of holding the data folder so every
  later start gives up against it.

**What it buys.** Two ways 10db stays down, or fills the disk, with nothing replacing it or cleaning up.

**What could go wrong, and how we'd know.**
- A slow but healthy start is killed. A start that legitimately runs past 10 minutes (a long migration on a big
  database) is killed once. The next attempt gets 20 minutes, then 40, so it still finishes.
  `logs/sidecar.log` says "the daemon did not finish starting in N min".
- The copies kept are bad ones. A migration is one transaction, so in a crash loop every copy is the same good
  state from before the failing migration: nothing good is lost. The cost is that about five fast restarts push
  out the copies from before earlier migrations; the 7 nightly copies still cover the last week. A start killed
  while copying would leave a half-written file, so a copy is written under one fixed temporary name and renamed
  when complete. The copy just made is never deleted, even if the clock stepped back.
- A daemon that hangs in synchronous code during start-up can't notice its shell leaving, so it still holds the
  data folder after a force-quit. That case stays uncovered; task 3 covers a hang that waits on I/O, the kind seen
  so far (`ps`, `lsof`, the Tailscale CLI).

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

`ChildHealth` gains `StartHung`. `wait_for_exit` returns a struct in place of its tuple:

```rust
/// How a supervised daemon ended, as `run_loop` needs it.
struct ChildEnd {
    code: Option<i32>,
    /// This shell killed it for staying silent on /health while serving.
    killed_as_frozen: bool,
    /// This shell killed it for not finishing its start in time.
    killed_as_start_hung: bool,
    /// It wrote a `daemon.json` naming its pid at some point: it finished starting.
    served: bool,
}
```

Task 2 (`apps/daemon/src/backups/index.ts`, `apps/daemon/src/daemon/start.ts`):

```ts
// DEFAULTS in start.ts
preMigrateBackupsKept: 5,
```

`apps/daemon/src/backups/index.ts`:

```ts
/**
 * The copy taken before migrations: prunes the label to `keep` (so a full disk can clear), copies, then prunes
 * to `keep` again, never deleting the copy just made. Returns the copy and the paths removed.
 */
export async function backupBeforeMigrating(
  db: TendbDatabase,
  dir: string,
  now: Date,
  keep: number,
): Promise<{ readonly file: string; readonly removed: readonly string[] }>;

/** Deletes all but the newest `keep` backups of a label, never `spare`; returns the deleted paths, oldest first. */
export function pruneBackups(dir: string, label: string, keep: number, spare?: string): string[];
```

`backupDatabase` keeps its signature. It writes `10db-<label>.partial` (one fixed name per label, overwritten each
time; the instance lock makes the daemon its only writer) and renames it to the stamped `.sqlite` name once SQLite's
backup resolves. `pruneBackups` already ignores names that don't end in `.sqlite`.

Task 3 (`apps/daemon/src/main.ts`): no new export.

## State table (design, not a test list)

| Child state                                   | Today                    | After                                                           |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Spawn fails                                   | logged, backoff          | unchanged; hang count unchanged                                 |
| No `daemon.json` naming it, under deadline    | waits                    | waits                                                           |
| No `daemon.json` naming it, past deadline     | waits forever            | killed, logged, restarted with backoff; next deadline doubles   |
| Serving, answers /health                      | fine                     | fine; consecutive-hang count resets to 0                        |
| Serving, silent past `frozen_after`           | freeze kill              | unchanged                                                       |
| Exits by itself in start-up                   | restart per exit policy  | unchanged                                                       |
| Shell quitting                                | no judging               | no judging; SIGTERM kills a starting daemon (no handler yet)    |
| Exits 2 (another daemon holds the folder)     | wait for the holder      | unchanged; hang count unchanged                                 |
| Killed as hung, not collected in `KILL_WAIT`  | -                        | reaped on a thread; the next child exits 2 and waits for holder |
| Killed as hung, its `daemon.lock` left        | -                        | the next daemon takes over a lock whose holder is gone          |
| Shell gone while the child starts (I/O wait)  | child lives on, holds lock | child sees stdin end and exits 1 (task 3)                     |
| Shell gone while the child starts (sync hang) | child lives on           | unchanged: not covered                                          |

| Start with pending migrations                 | Today                    | After                                                           |
| --------------------------------------------- | ------------------------ | --------------------------------------------------------------- |
| Copy completes                                | `10db-pre-migrate-*.sqlite` added | pruned to 5, copied, pruned to 5 sparing the new copy  |
| Killed mid-copy                               | half-written `.sqlite`   | `10db-pre-migrate.partial` left, overwritten by the next copy   |
| Copy fails (disk full)                        | start fails, nothing pruned | the first prune already freed space; start fails if it still can't copy |
| Clock stepped back (new stamp sorts oldest)   | -                        | the new copy is spared; an older one goes instead               |

## Tasks

1. `task-1.md`: the supervisor kills a daemon that never finishes starting (Rust, desktop). Its own PR.
2. `task-2.md`: pre-migrate copies are written whole and pruned to 5 (daemon).
3. `task-3.md`: a starting daemon stops when its shell leaves (daemon). Same PR as task 2.

Task 1 shares no file with tasks 2-3, so they run in parallel.
