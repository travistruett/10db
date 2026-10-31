# Lane sessions and their commands run at background priority, gates between them and the builder's apps

- **Date:** 2026-10-30
- **Amends:** `decisions/2026-10-28-gate-slots.md`

## Decision

Three CPU priorities, highest first, with no setting and the same in every project:

| Work                                                                          | Priority                          | macOS                   | Elsewhere (CI, Linux) |
| ----------------------------------------------------------------------------- | --------------------------------- | ----------------------- | --------------------- |
| The builder's own apps                                                        | normal                            | untouched               | untouched             |
| A gate (`verify/gate-runner.ts`: srt, the project's gate command, its output) | between lanes and the builder     | `taskpolicy -c utility` | `nice -n 10`          |
| A lane session (`claude`) and everything it starts                            | background, below everything else | `taskpolicy -b`         | `nice -n 19`          |

- **Where it is set.** `atPriority` (`src/priority/index.ts`) wraps the one process 10db spawns: the
  `claude` process a lane session starts (`spawnClaude` in `sessions/claude-adapter.ts`) and the gate's
  process group leader (`runGroup` in `verify/gate-runner.ts`, which every gate and shipping gate goes
  through). `taskpolicy` and `nice` set the policy and then exec the program, so the pid, the process group
  and the signals 10db sends are the program's own.
- **Everything below inherits it.** A priority survives fork and exec, so the lane's Bash commands (run
  under Seatbelt by Claude Code), the repo's stdio MCP servers (run under srt by Claude Code), and anything
  a command leaves running, including a busy loop orphaned when its lane ended, keep the lane's background
  priority. Nothing is set after the spawn, so no child starts at normal priority in a window. A gate's
  tree keeps the gate's priority for the same reason, so a lane's work can't be starved into the gate's
  timeouts, and the gate isn't slowed to lane level by a lane that is waiting on it.
- **Background is `taskpolicy -b`.** It lowers CPU priority and also throttles disk and network I/O, so
  lane builds yield to the builder's apps and to gates. A gate's `-c utility` clamp caps its QoS at utility
  (below user-initiated and interactive work, above background) without throttling I/O.
- **No switch.** There is no setting and no environment variable: the priority is part of how 10db starts
  a lane or a gate, so a project can't opt out of it by accident or by a repo file.

## Why

On 2026-10-29/30 two lanes, their gates and a lane's orphaned busy loops held the Mac's load average at 50
to 210 for hours. The builder's desktop slowed, and the gates failed on 5-second test timeouts because
they competed with lane work at equal priority. A gate failing for that reason fails a task that should not
fail, so the gate gets the priority between the two.

Turned down:

- `os.setPriority` on the pid after spawn: leaves a window in which `claude` or the gate has started
  children at normal priority.
- The same priority for lanes and gates: a loaded Mac would still starve the gate's timeouts.
- A setting: the incident needed no tuning, and a lane must not be able to turn it off.
- `nice` alone on macOS: its effect on the scheduler is weak next to the QoS policy, and it does not
  throttle I/O.
- Throttling by load (holding work back): a separate mechanism, not this decision. Priority limits what work
  already running costs the builder; it stops nothing.

A sandboxed process may not set its own background policy (`taskpolicy -b` fails with `Operation not
permitted` inside Seatbelt), which is why the daemon sets it from outside, before the sandbox starts. Tests
that run inside a sandbox replace the lane wrapper with one that records the tier.
