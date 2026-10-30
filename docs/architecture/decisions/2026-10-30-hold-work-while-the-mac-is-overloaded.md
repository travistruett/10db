# 10db holds new lanes and gates while the Mac is overloaded, and says what is using the CPU

- **Date:** 2026-10-30

## Decision

The daemon's load guard (`apps/daemon/src/load/`) reads the one-minute load average every 30 seconds.

**Overloaded** means the load stays above 4 times the core count for 5 minutes of samples. It **ends** when the
load is below 2 times the core count. The two levels differ so a load at the edge does not flap; the gap is wide
because the load average lags by about a minute. The night this was built for (13 orphaned busy loops from one
lane, load 150 to 210 on a Mac with fewer than 20 cores) was 10 times past the start level.

**While overloaded:**

- The scheduler launches nothing (`SchedulerOptions.held`), awaited claim holders included. It ticks by itself
  when the guard clears (`onCleared`).
- A lane that is already running finishes its session, and its next session waits before anything is built or
  launched (`RunnerOptions.hold`). A stop or cancel ends the wait (`Control.holdAbort`).
- A gate, a task's or a batch's, waits before it takes a gate slot (`limitGates` `hold`), so a held gate never
  keeps a slot from one that could run. Its abort signal ends the wait. Worktree dependency installs are not
  gates and are not held.
- Nothing already running is stopped. Stopping what is busy is the builder's call, and the busy thing may not be
  10db's.

**One card** (fold key `machine-overloaded`, a flag card) is raised once the overload is declared, reworded as the
busy processes change (only when its text does), and withdrawn when the overload ends. It names the load, the
core count and the top five processes at 20% of a core or more, each with what it belongs to:

| Owner         | How it is found                                                                                                             |
| ------------- | --------------------------------------------------------------------------------------------------------------------------- |
| a gate        | the process or its process group is the `gatePid` of a running workstream or `SHIPPING` batch, or a descendant of it        |
| a lane        | the process or an ancestor is a live session's `pid`, or it holds a file open in that lane's temp dir or its batch worktree |
| an ended lane | it holds a file open in a `10db-*` dir under the sandbox temp root that no running lane owns (the orphaned loops)           |
| 10db itself   | a descendant of the daemon that is none of the above                                                                        |
| not 10db's    | everything else; the card says so, and that only the builder can stop it                                                    |

The card lives on the project with the oldest work in flight, or the first project; with no project it is not
raised and the log says so. The hold applies either way.

**A gate that fails while overloaded says so.** The not-shipped card of a gate that failed, failed twice or timed
out carries a paragraph saying the Mac was overloaded while the gate ran and the load reached; the shipper asks
the guard whether any overload overlapped the run from the moment the gate got its slot. A gate that passes gets
nothing.

## Why

- Ten hours of failed gates and lost work came from 10db launching into a machine that could not run its tests.
  Test timeouts look exactly like a broken batch, so the card says which it is.
- The signal is the load average because it is what the failures followed and it needs no permission. Per-process
  CPU (`ps`) and open files (`lsof`, for the few processes listed) are read only while overloaded, both read-only
  and for the same user. The process environment is never read: it holds credentials.
- Orphans are matched by their lane's temp dir, not their parent: an orphan's parent is launchd, and lane
  sessions are not process-group leaders, so neither parent nor group names the lane. The runner records each
  session's temp dir while it runs (`laneTempDirs`) and forgets it at dispose.
- Holding at the scheduler alone would leave running lanes starting fresh sessions, and holding at the gate runner
  alone would let lanes keep piling load, so the three gates are the three places work starts.
- Turned down: killing the busy processes (they may be the builder's, and a lane's orphans are evidence); a card
  per process or per project (one machine, one card); a fixed load threshold (it would be wrong on another Mac).
- Not done: the thresholds are not settings; lanes already waiting at a question card are not touched; a gate
  that started before the overload and failed during it is told it overlapped, even when the overload began late
  in the run.
