# apps/daemon/src/lane-browser

The browser a lane drives against its own servers. This part holds its reach: what a page may load.

- **Targets** (`lane-reach.ts`, pure): http or https to exactly `localhost`, `127.0.0.1` or `[::1]`, any
  other spelling (`0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost`, a decimal or hex address)
  refused by name, and `file:`, `view-source:`, `chrome:`, `filesystem:`, `javascript:`, `data:` and
  `blob:` refused. The proxy takes only `CONNECT host:port` or an absolute `http://` request.
- **Fixed refusals**: the daemon's port and every lane proxy's, before anything is read.
- **The ledger rule**: with the project's localhost switch on, a port is owned when every `lsof -sTCP:LISTEN`
  listener's process chain (from one process-table reading, by pid and start time) reaches a member of the
  session's ledger and none of the chain is a lane browser's pid, and the listener addresses include a loopback
  one (`127.0.0.1`, `*` or `0.0.0.0` connects to `127.0.0.1`, else `[::1]`, `::` to `::1`).
- **The probe** (`PortReaders.acceptors`), only after a rule passes: the daemon makes a byteless connection to
  exactly the address the proxy would use and holds it. The acceptor exists only once the server calls accept,
  so `lsof -nP -iTCP:<the probe's local port>` is polled up to about a second; every holder but the daemon must
  be a ledger member or descendant (ledger rule) and one of the pids `lsof` showed listening (both rules). No
  holder in time refuses "did not accept in time"; an acceptor `lsof` cannot see (a root-owned `127.0.0.1:P`
  beside a lane's wildcard socket) refuses the same way, as does a failed probe. A one-shot listener
  (`nc -l`) is consumed by the probe. The proxy's own connection that follows is the same window as the cache.
- **The compose rule**: with Docker on, a port is owned when every publication of it is a Compose stack whose
  working dir (a real path) is in the session's copy or temp dir and in no registered checkout, bound to
  `127.0.0.1`; or `0.0.0.0` or `::` while no `lsof` listener on the port is bound to `127.0.0.1` (a `::`
  counts only beside `0.0.0.0` or `127.0.0.1`). Any other address is refused. The probe's acceptor must be
  one of the `lsof` listeners (Docker's own process, never the lane's).
- **Cache and rate** (`port-owner.ts`): an owned verdict is kept `PORT_CACHE_MS`, a refusal
  `PORT_REFUSAL_CACHE_MS`; a session gets `PORT_CHECKS_PER_MINUTE` fresh checks a minute, counting only ports
  with no owned verdict in the last minute, past which a new port is refused (cached ones still answer). A failed reading (`lsof`, `docker ps`, the process table) is a refusal that says so.
- **The proxy holds** (`lane-proxy.ts`): Playwright's routing is a first check; the proxy answers every
  connection by asking `PortOwner.check` and connects only to the address it returns, never a name.
  `lsof` and `docker ps` run through `execFile` with an argument list, a 5 s deadline and a fixed env.

- **Lifecycle** (`lane-browsers.ts`, `createLaneBrowsers`): one entry per session, and everything on the
  entry's queue (calls, launches, the idle close, `end`, `close`), so a close never races a launch. A call
  runs under `CALL_DEADLINE_MS` counted from its arrival; the driver it gets stops when the deadline or the
  session ends, and a call that will not stop has its browser closed out from under it
  (`BROWSER_CLOSE_MS` later). The first call with no browser (or a crashed one) fetches nothing itself: it
  asks the build shared with pictures, answers "fetching" at once while it downloads, then makes the
  session's artifacts dir, a ledger of its own, a port owner and proxy, and launches inside the launch lock
  (`pictures/browser-ledger.ts`: `mark`, launch, `track`), so ending one session never stops another's
  browser. A `BrowserStuckError` closes the browser; idle five minutes closes it; each says so in the next
  answer's `notes`. `end` runs as the session does (`RunnerOptions.endLaneBrowser`), after any launch under
  way, and later calls for that id are refused. A browser a crash leaves is reaped by the ledger sweep at the
  next start. With no sandbox roots (`ledgers` null) every call is refused.

- **The driver** (`playwright-driver.ts`, `launchPlaywrightDriver`): one context per launched browser (its
  cookie jar), downloads refused, service workers blocked. Playwright's routing is the first check and the
  proxy is what holds: an http(s) request passes when `laneUrlTarget` names a port; `data:` and `blob:`
  pass unless they are a main-frame navigation; every other scheme is aborted. WebSockets connect only to a
  loopback target. A main-frame navigation the route cannot see (to a scheme other than http(s)) is sent to
  `about:blank`. Each refusal goes in the next answer's `refused` as `<method> <origin><path>: <why>`; the
  proxy's own 403 (no body, no content type) and a bare `ERR_FAILED` or tunnel failure are read as proxy
  refusals.
- **Pages, dialogs, snapshot**: a popup or new tab becomes current; past `BROWSER_MAX_PAGES` the oldest closes
  with a note. `alert` and `beforeunload` are accepted; `confirm` and `prompt` are dismissed unless the
  `browser_act` in flight said `dialog: "accept"`; each is reported in `dialogs`. A snapshot is
  `ariaSnapshot({ mode: 'ai' })` cut at `SNAPSHOT_MAX_CHARS`. A call stopped by its signal probes the current
  page; one that will not answer throws `BrowserStuckError`, so the browser closes.
- **Live test**: `pictures/browser.live.test.ts` (`TENDB_LIVE_BROWSER=1`) runs a lane browser against two
  loopback servers, one in the session's ledger.
- **The tools** (`mcp/browser-tools.ts`, offered by `mcp/server.ts` `laneTools` when `McpDeps.laneBrowser` and
  `dataDir` are given): `browser_upload` reads each file itself in `mcp/browser-files.ts` (`O_NOFOLLOW`,
  a regular file, a fresh `readAccess` that must land in the copy, temp dir or setup reads, the same dev and
  inode, 50 MB a call) and hands the driver bytes. `browser_screenshot` writes the picture, then one write with
  its `lane` screen (URL without query, title, note, whether it was sent) and its `browser` evidence, then a
  copy under `<tempDir>/10db-screens`; it shares the model's picture budget with `check_design`
  (`mcp/picture-spend.ts`). Lane screens are pruned like turn pictures.
