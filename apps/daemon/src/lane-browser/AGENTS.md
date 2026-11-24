# apps/daemon/src/lane-browser

The browser a lane drives against its own servers. This part holds its reach: what a page may load.

- **Targets** (`lane-reach.ts`, pure): http or https to exactly `localhost`, `127.0.0.1` or `[::1]`, any
  other spelling (`0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost`, a decimal or hex address)
  refused by name, and `file:`, `view-source:`, `chrome:`, `filesystem:`, `javascript:`, `data:` and
  `blob:` refused. The proxy takes only `CONNECT host:port` or an absolute `http://` request.
- **Fixed refusals**: the daemon's port and every lane proxy's, before anything is read.
- **The ledger rule**: with the project's localhost switch on, a port is owned when every `lsof` listener's
  process chain (from one process-table reading, by pid and start time) reaches a member of the session's
  ledger and none of the chain is a lane browser's pid. `lsof` run as the builder cannot see another user's
  socket, so `netstat -anv -p tcp` supplies every listener on the port (family, address, pid): one whose pid
  is not a lane listener's refuses "another process listens on port P", and a `netstat` failure or
  timeout refuses. The proxy connects to an address a lane socket covers: `127.0.0.1` for tcp4, `*` or
  tcp46, else `::1`; a socket bound to anything else is refused. `netstat` needs the real node: it printed
  nothing under `pnpm exec` in the sandbox of an agent session, which reads as a refusal here.
- **The compose rule**: with Docker on, a port is owned when every publication of it is a Compose stack whose
  working dir (a real path) is in the session's copy or temp dir and in no registered checkout, bound to
  `127.0.0.1`; or `0.0.0.0` or `::` while no `netstat` socket on the port is bound to `127.0.0.1` (a `::`
  counts only beside `0.0.0.0` or `127.0.0.1`). Any other address is refused.
- **Cache and rate** (`port-owner.ts`): a verdict is kept `PORT_CACHE_MS`; a session gets
  `PORT_CHECKS_PER_MINUTE` fresh checks a minute, past which a new port is refused (cached ones still
  answer). A failed reading (`lsof`, `docker ps`, the process table) is a refusal that says so.
- **The proxy holds** (`lane-proxy.ts`): Playwright's routing is a first check; the proxy answers every
  connection by asking `PortOwner.check` and connects only to the address it returns, never a name.
  `lsof` and `docker ps` run through `execFile` with an argument list, a 5 s deadline and a fixed env.
