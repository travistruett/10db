# A daemon that is gone or silent is replaced, and a silent one is killed first

- **Date:** 2026-11-25

## Decision

Two things judge whether a daemon still counts, and both use the same two signs: the process state `ps`
reports, and an answer from `GET /health` on the port in `daemon.json`.

**The instance lock** (`apps/daemon/src/daemon/instance-lock.ts`) decides who owns the data directory. When
`daemon.lock` names another pid, in order:

1. No such process, or `ps` shows it as a zombie (`Z`) or exiting (`E`): the lock is taken over, no signal sent.
2. `daemon.json` is absent, unreadable or names another pid: the holder keeps the lock (`AlreadyRunningError`,
   exit 2). There is no port to ask.
3. `/health` is asked every second for `HOLDER_SILENCE_MS` (10 s), 2 s per try. One 200 and the holder keeps
   the lock.
4. Silent throughout: the holder's start time is read from `ps`. Later than `daemon.json`'s `startedAt`
   (compared at whole seconds; equal counts as the daemon's own) means another process reused the pid, and the
   lock is taken over with no signal. Otherwise the holder is sent SIGKILL and gets 5 s to leave.

A `ps` that cannot run, prints nothing or prints something else is "unknown", never "dead": the holder keeps
the lock and nothing is killed. This is the rule recovery already follows in
`apps/daemon/src/recovery/processes.ts`: a stored pid is signalled only while its OS start time still
identifies it.

**The window's supervisor** (`apps/desktop/src-tauri/src/supervisor.rs`) decides when to start a daemon.

- Exit 2 no longer ends it. It watches the holder every second and starts its own daemon when `daemon.lock`
  is gone, the holder is gone by `ps`, or the holder has not answered `/health` as the daemon `daemon.json`
  names for `HOLDER_SILENCE` (30 s). It never signals the holder; the daemon it starts runs the lock above.
  A healthy holder is watched for as long as it lives.
- Its own child is asked for `/health` every 5 s once `daemon.json` names it. A child that is gone by `ps`
  but whose exit can't be collected yet is handed to a thread that reaps it, and the next daemon starts. A
  child silent for `FROZEN_AFTER` (30 s) is killed and replaced. A daemon that has not written `daemon.json`
  yet is never judged, and nothing is judged while the app quits.

Both probes speak HTTP/1.1 over loopback (the supervisor by hand on a `TcpStream`, the lock with `fetch`). If
`/health` ever answers only HTTP/2, both change together.

## Why

On 2026-11-26 (UTC) a wedged daemon was SIGKILLed and the open window sat without one for over twenty minutes. The
next daemon found the dead one's pid in `daemon.lock`; `kill(pid, 0)` still succeeded, because a zombie, or a
process still tearing down a large address space, has a pid until it is reaped. It exited 2, and the
supervisor stopped on 2 for good. A daemon a self-update starts is the relaunched window's child, so the same
supervisor is what brings it back.

`kill(pid, 0)` says a pid exists, not that a daemon runs. The process state says whether it can still do
anything, and `/health` says whether it does.

Killing the silent holder was chosen over running a second daemon beside it: the daemon is the only database
writer, and a frozen one that wakes up would write under the new one. The kill is bounded by identity (the pid
`daemon.json` names, started no later than it says) so a stranger that reused the pid is never signalled.

The costs, accepted:

- A daemon whose event loop is blocked for more than 30 s is killed as frozen, with its sessions.
- Where `ps` cannot run (a sandbox refuses the setuid binary), the lock never kills a frozen holder. The
  supervisor keeps retrying every 30 s; that is safe, not self-healing.

Turned down: an HTTP client crate in the shell (one request does not earn a dependency), and treating a
missing `ps` row as dead in the lock (a `ps` that failed for another reason would then cost a live daemon its
lock).
