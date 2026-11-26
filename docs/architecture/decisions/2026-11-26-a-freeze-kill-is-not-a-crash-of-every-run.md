# A freeze kill is not a crash of every run, and a run that keeps bringing 10db down is held

- **Date:** 2026-11-26

## Decision

**The app says when it killed the daemon.** Just before the supervisor (`apps/desktop/src-tauri/src/supervisor.rs`)
kills a daemon that stopped answering `/health`, it writes `daemon.frozen-kill` beside `daemon.lock`:
`{ pid, at, frozenAfterMs }`, staged and renamed into place. The next daemon reads it once its instance lock
is held, logs it and removes it (`apps/daemon/src/daemon/frozen-kill.ts`). A missing or malformed marker
means the restart was a crash.

**What a restart charges** (`apps/daemon/src/recovery/recover.ts`). A run's recovery attempts (3 before it
fails) go up by one only when all of these hold:

- the previous daemon neither shut down cleanly nor was killed as frozen;
- the run was past STARTING: running, handing off, verifying, recovering or taken over. A STARTING run's
  session never reported started in that launch, so the restart cost it nothing.

Queued, held and paused runs keep their state and are never charged, as before.

**A run that keeps bringing 10db down is held.** The app setting `recovery.starting_at_unclean_restart`
names the runs that were STARTING at the last unclean restart (a crash or a freeze kill). A run found
STARTING at the next unclean restart too is held instead of queued, gives up its claims (unless its work
is on a lane branch, as a failed run does), and gets one Inbox card naming it ("Held: … stopped 10db
while starting"). Starting the task again or cancelling the run closes the card. A clean shutdown clears the
setting, so the two restarts must come in a row.

**The app kills more slowly instead of stopping.** Each freeze kill within 10 minutes of the last one
doubles how long the next daemon may stay silent before it is killed: 30 s, 60, 120, 240, then 480 s at
most. Ten quiet minutes start it over at 30 s. The supervisor never stops restarting.

## Why

The app's watchdog SIGKILLs a frozen daemon, so no clean-shutdown mark was written, and every kill counted
as a crash of every active run. One run whose start froze the daemon (a synchronous knowledge search over a
100 KB Fix CI description) brought down the daemon at each start, and after three kills every run that had
been mid-session failed with "Recovery failed 3 times".

The budget used to be what ended a loop like that. Once neither a freeze kill nor a starting run is charged,
something else has to end it. The hold rule lives in the daemon rather than in the app's kill count, so it
also stops a run that crashes the daemon (not only freezes it) on every start, and it works for a daemon run
without the app.

The costs, accepted:

- A run that happened to be STARTING at two unrelated crashes in a row is held wrongly. Its card says why,
  and Start puts it back.
- A daemon frozen over and over by a run that is already mid-session is not held; only the longer
  threshold slows that loop.
- A daemon blocked for up to 8 minutes after a run of freeze kills is left alone that long.

Turned down: a hard stop in the app after N freeze kills (it would leave the app with no daemon at all), and
deciding the hold from the app's kill count alone (it misses crashes).

Follows from `2026-11-25-a-silent-daemon-is-killed-and-replaced.md`.
