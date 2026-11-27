# Log

- `openLogFile` is the daemon's log file. A write after it closed or errored is dropped, never thrown (SonicBoom
  throws `destroyed`, which a late handler turns into an unhandled rejection); one `error` listener writes a line
  to stderr for the stream's whole life.
- `keepRotated(clock)` checks the size hourly, rotates with `rotateLogFile` and reopens the stream; `close()` stops
  the check first and resolves once the descriptor is closed.
