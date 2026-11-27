# Task 1: the supervisor kills a daemon that never finishes starting

Read the index's brief and Global Constraints first. Size: Core (recovery).

**Files:** `apps/desktop/src-tauri/src/supervisor.rs`; `apps/desktop/src-tauri/AGENTS.md` (or the nearest module
note) gets one line on the start deadline.

**Implements** (from the index's Interfaces, exactly):

```rust
pub const START_DEADLINE: Duration = Duration::from_mins(10);
pub const START_DEADLINE_MAX: Duration = Duration::from_mins(80);
pub fn start_deadline(hung: u32) -> Duration;
```

**State-table rows:** the first table, all rows.

**Notes**

- `HealthWatch::check` returns `Fine` while `read_runtime_info` finds no `daemon.json` naming this pid. Give
  `HealthWatch` the spawn instant and the deadline; past it, with the process still running (`process_gone`
  false), return `StartHung`. A `daemon.json` naming the pid once is enough. From then on the existing freeze
  watch applies, never the start deadline.
- `wait_for_exit` handles `StartHung` like `Frozen`: report to the sidecar log
  (`the daemon did not finish starting in {N} min; killing it to start another`) and
  `release_child(shared, log_dir, true, KILL_WAIT)`. Write no freeze-kill marker: that marker tells the next
  daemon a serving daemon froze, which is not what happened.
- `run_loop` keeps a consecutive-hang count. A start-hang kill adds 1. A child that served (wrote `daemon.json`
  naming it) resets it to 0. The next spawn's deadline is `start_deadline(count)`.
- A start-hang kill must not reset the restart backoff, although the child ran past `HEALTHY_UPTIME`. Today
  `started.elapsed() >= HEALTHY_UPTIME` resets it; skip that reset after a start-hang kill.
- The deadline starts at spawn, not after the pre-migrate copy or the migration. A slow copy plus migration is
  exactly the case the doubling is for.
- Killing mid-migration is safe: SQLite rolls back the open transaction on the next open. Killing mid-copy is
  task 2's `.partial`.

**Tests:** one pure test for `start_deadline` (0 → 10 min, 1 → 20, 3 → 80, a large count stays at 80 and never
overflows), beside the existing `Backoff` tests. No spawned-process test: the module has none, and the wiring is
the same path the freeze kill already takes. The commit carries a value card (`why_new=recovery`).

**Spec:** the Fable uptime audit's item A (recorded in the 2026-11-27 hand-off and in #948's report).
