# A lock holder that started after the lock was written is a stranger, and a stop has a deadline

- **Date:** 2026-11-27
- **Amends:** `decisions/2026-11-25-a-silent-daemon-is-killed-and-replaced.md`

## Decision

**The instance lock** (`apps/daemon/src/daemon/instance-lock.ts`). Step 2 of the amended record, "`daemon.json` is
absent, unreadable or names another pid: the holder keeps the lock", gains one exception. When `ps` shows that the
holder's start time is more than 60 s (`STRANGER_MARGIN_MS`) after `daemon.lock`'s mtime, the holder is not the
daemon that wrote the lock but a process that got its pid later. The lock is taken over, and no signal is sent to
that process. An unreadable start time or lock proves nothing, and the holder keeps the lock as before. Each `ps`
read of the holder gets 5 s (`PS_TIMEOUT_MS`), and a killed read is unknown.

**A stop has a deadline** (`apps/daemon/src/daemon/stop-within.ts`, wired in `main.ts`). A daemon's stop gets
60 s (`STOP_DEADLINE_MS`). Past that it logs one line and exits 1. The supervisor restarts an exit 1, and the
next start runs crash recovery, since no `daemon.clean_shutdown` row was written.

## Why

- **The lock.** A daemon that dies before it writes `daemon.json` leaves a lock naming its pid. After a Mac
  restart that pid often belongs to another long-lived process, so step 2 refused every start with exit 2, and
  the shell restarted it every 30 s for good.
  - A live daemon writes its lock with `wx` after it has started. So its own start time is never later than the
    lock's mtime.
  - `ps` prints whole seconds, and a repeated DST hour parses to the earlier instant. Both make a process look
    older, never newer.
  - The 60 s margin covers a clock correction between the fork and the write.
  - A clock-free proof was considered and left for later: store the daemon's own start time in `daemon.lock` and
    treat any mismatch as a stranger. A clock that steps back more than 60 s between a daemon's fork and its lock
    write is the case it would close.
- **The deadline.** A stop that awaited a step that never settled kept the lock and kept answering `/health`
  with its scheduler stopped. The shell's health watch counted that as alive, and a new daemon exited 2. The
  shell's own 30 s kill applies only when the shell itself quits. 60 s is longer than that kill, so a normal
  quit is still the shell's to end.
