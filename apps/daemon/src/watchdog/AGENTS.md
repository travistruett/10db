# watchdog

Restarts a daemon whose main thread has stopped.

- `startWatchdog` (called only by `main.ts`, after `startDaemon` resolves, so start-up migrations and in-process
  tests are never watched) beats a counter in a `SharedArrayBuffer` each second and starts `worker.ts` in a
  worker thread. After `STALL_MS` (15 s) without a beat the worker appends one fatal line to `daemon.log`
  (`component: 'watchdog'`, with `stalledMs`, `rssBytes`, the in-flight outbound `hosts` and `samplePath`),
  saves `/usr/bin/sample <pid> 1` as `logs/daemon-stall-<time>.sample.txt` (the newest 5 are kept), then
  `SIGKILL`s the process. The desktop supervisor restarts a signal death and start-up recovery resumes the lanes.
- A late worker tick (the Mac slept, the process was stopped) resets the count, so sleep never kills the daemon.
- Synchronous main-thread work must stay well under 15 s, so the main thread never waits on work whose size a
  lane, a server, a build or the builder's project sets. A tree one of them can fill is removed off the main
  thread: `rm` from `node:fs/promises`, or `removeLaneTempDirAsync` for a lane temp dir. ESLint refuses a
  recursive `rmSync` and the synchronous `removeLaneTempDir` in `src`; a line that keeps one disables the rule
  and says what bounds its tree (a folder only 10db fills, or the sweep at start, before the watchdog runs).
  A synchronous child process takes a `timeout` well under 15 s (`git ls-files` 10 s, `security` 5 s):
  nothing checks that.
- `TENDB_WATCHDOG=off` turns the watchdog off, which a debugger breakpoint needs.
- The worker is its own bundle, `watchdog-worker.mjs` (`scripts/build.ts`). It only reads the shared memory,
  writes with `fs.writeSync` and runs `sample`: nothing in it may wait on the main thread.
