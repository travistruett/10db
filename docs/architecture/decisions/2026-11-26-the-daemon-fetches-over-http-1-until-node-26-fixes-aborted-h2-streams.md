# The daemon fetches over HTTP/1.1 until Node 26 fixes aborted HTTP/2 streams

- **Date:** 2026-11-26

## Decision

Built, in `apps/daemon/src/outbound/` and `apps/daemon/src/watchdog/`.

1. **One outbound fetch, HTTP/1.1 only.** Every `fetch` the daemon makes is `outboundFetch`: Node's built-in
   fetch with one shared `Agent({ allowH2: false })` from the npm `undici` package (pinned exactly) as its
   dispatcher. It is the default for `DaemonOptions.fetch` and for every module that fetches directly, the
   builder's MCP bridge included. The built-in dispatcher is never replaced through its global Symbol.
2. **A lint rule is the mechanism.** ESLint refuses the global `fetch` as a value in `apps/daemon/src` outside
   `outbound/`, tests and the fake sessions (`eslint.config.js`). One regression test checks the offer: a local
   TLS server records the ALPN protocols `outboundFetch` sends, which must be `http/1.1` alone.
3. **Bedrock's client is left as it is.** Its `NodeHttp2Handler` resets an aborted stream with `CANCEL` and
   passed both failures below.
4. **A watchdog restarts a stalled main thread.** A worker thread reads a beat the main thread writes to a
   `SharedArrayBuffer` each second. After 15 s without one it appends a line to `daemon.log` (stall length,
   RSS, the hosts of the outbound calls in flight), saves `/usr/bin/sample <pid> 1` beside the log (the newest
   five are kept) and sends the process `SIGKILL`. The desktop supervisor restarts a signal death and start-up
   recovery resumes the lanes. A late tick of the worker itself (sleep, a stopped process) resets the count.
   `TENDB_WATCHDOG=off` turns it off, which stopping at a debugger breakpoint needs. A daemon run without the
   desktop app (`pnpm dev`) has no supervisor, so there the watchdog only ends the process.
5. **An outbound transport error is logged, not fatal.** `main.ts` still exits 1 on any other unhandled
   rejection or uncaught exception. An error whose `code`, or whose cause's, is one of undici's (`UND_ERR_*`),
   an HTTP/2 session's (`ERR_HTTP2_*`) or a socket's (`ECONNRESET`, `ETIMEDOUT`, `ECONNREFUSED`, `ENOTFOUND`,
   `EAI_AGAIN`, `EHOSTUNREACH`, `ENETUNREACH`) is logged and the daemon carries on. `EPIPE` is not in the
   list: a closed stdout or child pipe raises it too.

**Return to HTTP/2** when a Node 26 release carries nodejs/node#67372 (its v26 backport is nodejs/node#67444)
and `mise.toml` moves to it: delete the `Agent`, the cast beside it and the `undici` dependency, and let
`outboundFetch` call the built-in fetch as it is. The lint rule, the in-flight hosts, the watchdog and the
non-fatal transport errors stay.

Provider parity: every account kind keeps working. Only the transport of the daemon's own calls changes
(the judge on OpenRouter and Anthropic, Slack, Figma, Linear pictures, benchmarks, the catalogue, pinned
tools); Claude, Codex, `gh` and remote MCP run in child processes and are untouched.

## Why

On 2026-11-26 the installed daemon failed twice on the same path, on Node 26.13.0 with its built-in undici
8.12.2.

- **A wedge.** A judge call to OpenRouter was aborted at its 4 s deadline while its body was still queued on a
  warm HTTP/2 session. undici closes the stream then destroys it, Node sends no `RST_STREAM`, and nghttp2
  loops on empty DATA frames without returning to the event loop (nodejs/node#67363). The daemon stopped for
  more than eight minutes, grew to 139 GB of footprint, and nothing noticed.
- **A crash.** The same abort leaves a stream that a late answer wraps in a new stream with no `error`
  listener (nodejs/undici#6143). When undici's idle timer destroys the socket, that stream throws
  `InformationalError: socket idle timeout` (`UND_ERR_INFO`) uncaught, and the daemon exited.

Both reproduce against a local HTTP/2 server, and an `allowH2: false` dispatcher prevents both: the server
then sees only `http/1.1`, so no HTTP/2 session exists to wedge or to time out.

Turned down:

- **An environment variable or Node flag.** undici 8.12.2 has none that turns HTTP/2 off.
- **Setting the global dispatcher.** The built-in fetch reads it from a global Symbol that names undici's
  version; setting it from another copy of undici depends on the two agreeing. Passing the dispatcher per
  call is the documented way and is what the regression test checks.
- **Waiting for the fix.** The fix is merged upstream but in no Node 26 release.
- **A heartbeat the main thread checks itself.** A wedged loop runs no timers; only another thread can see it.
- **Treating every uncaught error as survivable.** An unknown error may leave the daemon's own state wrong,
  and a restart with recovery is the safe answer there. A failed connection to someone else's server is not
  that.

The cost is one connection per concurrent request to a host instead of one multiplexed session, which the
daemon's few, small calls do not notice. The risk of the watchdog is a kill during honest synchronous work of
15 s or more; the daemon's known synchronous work (a few short child processes) is far below it.
