# Task 3: a starting daemon stops when its shell leaves

Read the index's brief and Global Constraints first. Size: Core (recovery).

**Files:** `apps/daemon/src/main.ts`; the daemon's `AGENTS.md` note on start-up, one line.

**Implements:** no new export. The state-table rows "Shell gone while the child starts".

**Notes**

- Today `main.ts` listens for stdin's `end` only after `startDaemon` resolves, so a daemon stuck starting outlives a
  shell that quit or crashed. It keeps `daemon.lock` with no `daemon.json`, and every later shell's daemon exits 2
  against it.
- When `TENDB_PARENT_STDIN === '1'`, listen for `end` before `startDaemon` is called. While starting, `end` exits at
  once with code 1 and a one-line `console.error` saying the shell left during start-up. Nothing is serving yet, and
  an open migration rolls back on the next open.
- Once `startDaemon` resolves, remove that listener and install today's `shutdown` on `end`, as now. Call
  `process.stdin.resume()` once, before `startDaemon`.
- SIGTERM during start-up keeps Node's default (exit); don't add a handler.

**Tests:** none. The only rung that fails for this is spawning the real daemon with a held stdin and a start that
waits, which no test helper does today, and building one is test-only code. **Run it** by hand instead: start the
built daemon with `TENDB_PARENT_STDIN=1` and a stdin you then close while it's starting (a large pending migration
or a breakpoint), and check it exits. Say in the PR that this ran, or that it didn't.

**Spec:** plan review round 1, finding 2 (the plan index's brief and state table).
