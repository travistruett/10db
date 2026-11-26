# Task 9: serve control and the sharing service

Read the index's brief, Global Constraints and "Serve facts" first. Size: Core (what reaches the tailnet).

**Files:** new `apps/daemon/src/sharing/serve-mapping.ts`, new `apps/daemon/src/sharing/sharing-service.ts`,
`sharing/index.ts`, `sharing/AGENTS.md`.

**Implements:** `ServeStatus`, `MappingProblem`, `isTendbMapping`, `mappingProblem`, `shareRefusal`,
`serveArgs`, `unserveArgs`, `SharingService` (with `requestCertificate`) and `createSharingService`, as quoted
in the index. Build `ServeStatus` from the shapes in "Serve facts"; parse only `TCP`, `Web` and `AllowFunnel`.

**Mapping rules (pure)**

- `isTendbMapping`: `Web["<fqdn>:<port>"].Handlers` has exactly one handler, `/`, whose `Proxy` is exactly
  `http://127.0.0.1:<port>`, and the port has no `AllowFunnel` and no `TCP` entry. A variant that needs no name
  (`loopbackMappingOn(serve, port)`: any `Web` key ending `:<port>` with that same single handler) is used only to
  remove 10db's mapping while the name is unknown.
- `mappingProblem` returns Funnel, TCP or elsewhere (with the target) in that order, or null.
- `shareRefusal`: a port in `FUNNEL_PORTS`, below 1024, or the main listener's port, with a sentence saying why.

**The service**

- **One queue:** `set`, `requestCertificate`, `start`, `stop` and the monitor's ticks run one at a time.
- **Refresh:** reads Tailscale, then, if the name has the builder's Get Certificate (`sharing.certificateFor`,
  task 8), ticks the probe. It runs on each monitor tick while enabled, and when `status()` finds the last refresh
  over 10 s old (not awaited; the page polls every 10 s). `status()` itself returns the cache at once.
- **`requestCertificate()`:** stores the fqdn's hash in `sharing.certificateFor`, runs the probe now, returns a
  fresh status.
- **`set({ enabled: true, port })`:** refuse per `shareRefusal`; refuse unless Installed through Certificate pass;
  read `serve status` fresh and refuse on a `mappingProblem`; then `listen(port)` (a held port fills `portHolder`
  and stops); run `serveArgs`; store `sharing.enabled` and `sharing.port` with `setAppSetting`; emit
  `sharing.changed`. A failure at any step closes the listener it opened and leaves `enabled` false.
- **`set({ enabled: false })` and `stop()`:** read `serve status` fresh, run `unserveArgs` only when
  `isTendbMapping` holds, then `sockets.closeListener('share')`, then close the listener. An unserve failure or
  timeout is logged and the close goes ahead; the next start removes the mapping. A changed port is Stop on the
  old, Share on the new.
- **`start()`,** with `sharing.enabled`: read Tailscale and `serve status` first. With a `mappingProblem`, don't
  listen; Paused names it. Otherwise listen; a held port leaves the listener down and removes 10db's mapping
  (`isTendbMapping`, or `loopbackMappingOn` when the name can't be read). Restore the mapping when absent. Catch
  every error, log it, set Paused.
- **The monitor,** every 60 s on the clock while enabled: refresh, re-read `serve status`. A Funnel or TCP entry
  on the port, or a foreign mapping, closes the sockets and the listener and stops sharing (Paused names it). A
  changed name closes the share sockets with 4410 and rebuilds the lists. While the port is held by another process it keeps trying to remove a `loopbackMappingOn` mapping, and never re-shares.
- `app_settings` values are parsed with zod on read; a bad value reads as off on 4319.

**The by-hand checks are the coordinator's** ("Serve facts" in the index): a lane can't reach Tailscale.

**Tests:** one pure table test, `serve-mapping.test.ts`, over parsed `ServeStatus` fixtures: 10db's mapping, the
same port with a second handler, the same port proxying elsewhere, Funnel on, a TCP forward, another port's
mapping, empty; `loopbackMappingOn` with the name absent; and `shareRefusal` for 443, 8443, 10000, 80, the main
port and 4319. One `sharing-service.test.ts` case with a fake `TailscaleRun` (a child process 10db doesn't own),
a fake `listen` and an injected clock: Share then `stop()` records the order (unserve, `closeListener`, listener
close); a mapping that points elsewhere is never removed; `start()` with Funnel on the port never calls `listen`;
and no `cert` call is made before `requestCertificate`. Value card:
`protects=10db shares only its own mapping, never behind Funnel, unshares before closing, and publishes no name unasked; fails_when=the order flips, a foreign mapping is removed, start listens behind Funnel, or the probe runs unasked; why_new=core: exposure on the tailnet; no_claim=tailscale's own serve behaviour`.

**Spec:** §3.1–§3.4, §7.
