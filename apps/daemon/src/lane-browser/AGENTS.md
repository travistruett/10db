# apps/daemon/src/lane-browser

The browser a lane drives against its own servers. This part holds its reach: what a page may load.

- **Targets** (`lane-reach.ts`, pure): http or https to exactly `localhost`, `127.0.0.1` or `[::1]`, any
  other spelling (`0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost`, a decimal or hex address)
  refused by name, and `file:`, `view-source:`, `chrome:`, `filesystem:`, `javascript:`, `data:` and
  `blob:` refused. The proxy takes only `CONNECT host:port` or an absolute `http://` request.
- **Fixed refusals**: the daemon's port and every lane proxy's, before anything is read.
- **The ledger rule**: with the project's localhost switch on, a port is owned when every listener's process
  chain (read from one process-table reading, by pid and start time) reaches a member of the session's
  ledger and none of the chain is a lane browser's pid. It is reached at the address the listeners
  reported (`::1` only when all are on `::1`).
- **The compose rule**: with Docker on, a port is owned when every publication of it is a Compose stack whose
  working dir (a real path) is in the session's copy or temp dir and in no registered checkout, bound to
  `127.0.0.1`; or `0.0.0.0` or `::` while no listener on the port is bound to `127.0.0.1` (a `::` counts
  only beside `0.0.0.0` or `127.0.0.1`). Any other address is refused. Known limit: `lsof` run as the
  builder doesn't list another user's sockets, so a root listener on `127.0.0.1` is invisible to that check.
- **Cache and rate** (`port-owner.ts`): a verdict is kept `PORT_CACHE_MS`; a session gets
  `PORT_CHECKS_PER_MINUTE` fresh checks a minute, past which a new port is refused (cached ones still
  answer). A failed reading (`lsof`, `docker ps`, the process table) is a refusal that says so.
- **The proxy holds** (`lane-proxy.ts`): Playwright's routing is a first check; the proxy answers every
  connection by asking `PortOwner.check` and connects only to the address it returns, never a name.
  `lsof` and `docker ps` run through `execFile` with an argument list, a 5 s deadline and a fixed env.
