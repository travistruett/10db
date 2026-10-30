# A lane session's processes are stopped when it ends, and after a daemon that died

- **Date:** 2026-10-30
- **Amends:** decision 132 (the gate kills its process group; lane commands had no equivalent)

## Decision

- **Watch the tree while the session runs.** `sandbox/lane-processes.ts` samples the process table (`ps -axo pid=,ppid=,pgid=,lstart=`, one reading shared by all sessions, every second) from the moment Claude Code reports its pid. It remembers every process under the session's pid, everything below those, and everyone in their process groups, by pid and start time.
- **Stop it all when the session ends**, however it ends (finished, cancelled, handed off, the daemon stopping): in the runner's `finally`, after the Claude Code process is gone and before the temp dir is removed, `LaneSession.endProcesses()` reads the table again, sends SIGTERM to each remembered process and its group, waits 1.5 s, sends SIGKILL to what is left and repeats up to four times for what forked meanwhile. A failure to read the table is logged; the session still ends.
- **Survive a daemon restart.** Each session keeps a ledger, `10db-proc-<hex>.json`, in the sandbox temp root, outside every lane-writable directory. At start, right after the temp root is claimed and before recovery and before any session or gate, `reapLaneProcessLedgers` stops what each ledger names and removes it. It does nothing when another live daemon shares the root. A machine whose table can't be read leaves the ledgers for the next start.
- **Never signal what is not the lane's.** A process is signalled only while its pid and start time match what was recorded (a recycled pid is left alone). Never launchd, the daemon, or the daemon's own process group, even if a session process shares it (that process is signalled by pid). The process environment is never read.
- **A command that starts an endless background loop raises a permission card.** `guard/background-loops.ts` reads a Bash command's quotes, comments and operators (and follows `sh -c` and `eval`): a `while :`, `while true`, `until false`, `for ((;;))`, `yes`, `cat /dev/zero`, `dd` from `/dev/zero` with no count, or an interpreter one-liner that loops forever, with an `&` (or `coproc`) puts it in the background. The broker asks about it like a hazard; it is not stored as a rule it can run unasked. The same loop in the foreground is not asked about: the command ends with it or at the tool's timeout.
- **A denial covers equivalents, and lasts the workstream.** The text a lane gets names the denied call and says an equivalent (another program, loop, script, wrapper, tool) is denied too, with the builder's note. Every later session of the workstream is told in its prompt (and after a compaction), from the denied permission cards in the database (`deniedPermissionsForWorkstream`, the newest 20, each clipped to 400 characters). No new table.

## Why

On 2026-10-29 a lane ran a command that started twelve `(while :; do :; done) &` loops, then 10db restarted for an app install before the command ended. The loops lost their parent, went to launchd and ran for ten hours at about 55% CPU each, which put the Mac at load 170 and made gates fail on timeouts. The gate already killed its process group; a lane's commands had nothing like it. The same lane had just been denied a `yes` loop, and the broker allowed the `while` form without a card.

- A walk down from the session's pid at the end finds nothing: orphans have launchd as their parent. So the tree is remembered while the parents are alive, and the process group (which outlives its leader) catches what forked after the last sample.
- Spawning Claude Code as a process group leader would put commands in one group only if Claude Code leaves them there; it does not promise that, and a changed spawn would change how a hard daemon kill ends the session. Sampling and the ledger don't depend on it.
- The ledger sits in the temp root, not in the lane's temp dir, because a lane could rewrite its own and make the next start signal anything.
- Reading each process's environment for the lane's `TMPDIR` would name every orphan, including a double-fork between samples, but a process environment holds the project's secrets and is read by nothing else in 10db. A process that forks, daemonizes and leaves its group within one second, with no ancestor sampled, is the known gap.
- A denial that lives in the session's tool result is gone with the session. The permission cards are already stored with their answer and note, so a query reads them back.
