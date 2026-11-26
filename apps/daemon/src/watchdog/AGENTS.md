# watchdog

Restarts a daemon whose main thread has stopped.

- `startWatchdog` (called only by `main.ts`, after `startDaemon` resolves, so start-up migrations and in-process
  tests are never watched) beats a counter in a `SharedArrayBuffer` each second and starts `worker.ts` in a
  worker thread. After `STALL_MS` (15 s) without a beat the worker appends one fatal line to `daemon.log`
  (`component: 'watchdog'`, with `stalledMs`, `rssBytes`, the in-flight outbound `hosts` and `samplePath`),
  saves `/usr/bin/sample <pid> 1` as `logs/daemon-stall-<time>.sample.txt` (the newest 5 are kept), then
  `SIGKILL`s the process. The desktop supervisor restarts a signal death and start-up recovery resumes the lanes.
- A late worker tick (the Mac slept, the process was stopped) resets the count, so sleep never kills the daemon.
- Synchronous main-thread work must stay well under 15 s. `TENDB_WATCHDOG=off` turns the watchdog off, which a
  debugger breakpoint needs.
- The worker is its own bundle, `watchdog-worker.mjs` (`scripts/build.ts`). It only reads the shared memory,
  writes with `fs.writeSync` and runs `sample`: nothing in it may wait on the main thread.
