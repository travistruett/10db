# One admission gate holds new lanes on load, free disk and a machine-wide lane cap

- **Date:** 2026-11-14
- **Supersedes:** the overload and clear levels of
  `decisions/2026-10-30-hold-work-while-the-mac-is-overloaded.md` (its card, its holds and its sampling stand)

## Decision

The scheduler's `held` is one admission gate (`apps/daemon/src/scheduler/admission.ts`), and Factory says what it
holds (`GET /admission`, one line per hold, in the order load, disk, lane cap):

- **Load.** Overloaded now means the one-minute load stays above **2×** the cores for 5 minutes, and it ends below
  **1.5×** (`DEFAULT_OVERLOAD_FACTOR`, `DEFAULT_CLEAR_FACTOR` in `load/guard.ts`). It holds new lanes, a lane's
  next session, a task's gate and a ship's gate, as before.
- **Free disk.** Free disk on the volume worktrees are made on (`statfs` `bavail × bsize`, read at the worktree
  root's nearest existing ancestor) below the floor holds **new lanes only**. Gates and ships run: a ship removes
  its batch's worktree, which is what frees the disk. The floor is 20 GB by default, and the hold ends once free
  disk is back above the floor plus 5 GB. One flag card (fold key `machine-disk-low`) says so while it holds. A
  disk that cannot be read never holds. The watch is on only when `DaemonOptions.disk` is given; the entry point
  gives it unless `TENDB_DISK=off`, and Playwright's daemon sets it off.
- **Machine lane cap.** The daemon-wide cap (`SchedulerOptions.caps.global`, which `roomForLane` already counts
  across every project) is the `capacity` app setting's `machineLaneCap` (default 4, 1 to 32), read through a
  getter on each tick, so a change applies at the next tick. `DaemonOptions.caps` still overrides it. It stays
  in the scheduler's per-lane room check rather than `held`, since a warm session can close to make room.
- **The drain** of a waiting update still holds new lanes, as before.

`GET/PUT /settings/capacity` reads and writes `{ machineLaneCap, diskFloorGb }`.

## Why

The build-process audit (`docs/architecture/research/2026-11-14-build-process-audit.md` §3.7, §7) found the Mac
queueing for the CPU at loads far below 4× the cores (a load of 40 on a 10-core Mac): tests and gates time out
long before then, and those failures read as the batch's. Twice the cores held for minutes is already a Mac whose
gates queue. The clear level sits below the start level so a load near 2× does not flap the hold at every
30-second sample, without waiting for an idle Mac.

The audit's bad day had 24 GB free, and one Rust worktree takes 1.3 to 3 GB. Holding gates or ships at low disk
would keep the space taken, since retiring a shipped batch's worktree is what gives it back. The 5 GB margin
stops the hold flapping as builds write and remove files. CI runners and the e2e container have little free disk
and `start()` is called from many tests, so the watch is off unless the production entry point turns it on, as
Slack and the catalogue sync are.

The machine cap existed as a constant nobody could change; a setting read on each tick lets the builder size it
to the Mac. Provider: independent; it measures the Mac.
