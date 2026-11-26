# sharing

Shares this Mac's daemon on the builder's tailnet through `tailscale serve`.

- `tailscale-cli.ts` is the only module that runs the Tailscale CLI. `findTailscaleCli` reads no environment;
  `TENDB_TAILSCALE=off` is parsed in `daemonOptionsFromEnv` (`tailscaleOff`) and `start.ts` then passes
  `cli: () => null`, so the e2e daemon sees no Tailscale on a Mac that has one. `TENDB_TAILSCALE_CLI=<absolute path>` (`tailscaleCli`) names the CLI to run instead of the search (`start.ts` composes `tailscaleOff`, then `tailscaleCli`, then `findTailscaleCli`). `createTailscaleRun` uses
  `execFile` with no shell, a 10 s default timeout, 1 MiB of output and an environment of `PATH` and `HOME` only; it
  never rejects. Lanes can't run the CLI, so nothing here is tested against a real one: the zod schema reads only
  the fields 10db needs, and an unreadable answer throws `TailscaleUnreadableError`, naming the field, never a value.
- `certificate-probe.ts` runs `tailscale cert --cert-file - --key-file - <fqdn>` and keeps only the exit status and
  the last 500 characters of stderr; stdout (the key) is dropped. `tick` runs when due, 60 s after a success and 10
  minutes after a failure; `current()` never runs the CLI.
- **The probe never makes the first certificate on its own.** 10db can't see whether a certificate exists without
  running `tailscale cert`, and the first issue publishes the name for good. The sharing service therefore calls
  `tick` only for a name the builder has pressed Get Certificate for: `app_settings` key `sharing.certificateFor`
  holds the SHA-256 hex of that fqdn, never the name. A changed name needs a new click.

- `serve-mapping.ts` is pure. `isTendbMapping` is true only for `Web["<fqdn>:<port>"]` with one `/` handler proxying
  `http://127.0.0.1:<port>`, a `TCP[port]` entry that is exactly `{ "HTTPS": true }` and no Funnel on the name.
  `loopbackMappingOn` is the same check without a name, used only to remove 10db's mapping while the name is
  unreadable. `shareRefusal(port, mainPort)` takes the main listener's port because it is only known at run time.
- `sharing-service.ts` runs `set`, `requestCertificate`, `start`, `stop`, the refresh a stale `status()` starts and the
  60 s monitor on one queue. Stop and shutdown unserve first, then close the share sockets, then the listener, and
  remove only a mapping that is 10db's. A start with a Funnel, TCP or foreign mapping on the port never listens
  (`blocked`); a start that fails for Tailscale or certificate reasons (`retry`) is tried again by the monitor, a held
  port is not, and the monitor only removes 10db's mapping while the listener is down. `set` refuses with
  `SharingRefusedError`, whose message is shown to the builder (task 10 maps it to 409).
- The 60 s monitor publishes `sharing.changed` on every tick, including one that finds the CLI gone. The rail
  waits for that event (or for Remote Access's 10 s poll, which fills the same query), so a removed CLI clears
  the rail's line within a minute.
- `share-listener.ts` is the second `serve()` on `127.0.0.1:<port>` with its own `WebSocketServer({ noServer: true })`
  and the same app. Its fetch wrapper (and the main listener's in `start.ts`) marks the **env object in place**
  (`Object.assign(env, { listener })`): `@hono/node-server` reads back a symbol the upgrade helper writes on that very
  object, so a spread copy silently breaks every WebSocket upgrade. `EADDRINUSE` answers `{ ok: false, holder }`,
  `holder` from `lsofHolderOf` (`"<command> (pid <n>)"`). `start.ts` calls `sharing.start()` unawaited after recovery
  and `sharing.stop()` first in shutdown.

## Serve facts

Recorded against Tailscale 1.104.7 (standalone app) on this Mac, with a throwaway
mapping of 4399 to a header-recording listener, removed afterwards (`serve status` back to `{}`).

- **What the share listener receives** through `serve`: the peer is `127.0.0.1`. `Host` is `<fqdn>:<port>`
  (forwarded as the client sent it), and `Origin` passes through unchanged. Serve adds `X-Forwarded-For`,
  `X-Forwarded-Host`, `X-Forwarded-Proto`, `Tailscale-Headers-Info`, `Tailscale-User-Login`, `Tailscale-User-Name`
  and `Tailscale-User-Profile-Pic` to every request from an untagged peer.
- **Forged headers are replaced:** a request sent with its own `X-Forwarded-For` and `Tailscale-User-Login` arrived
  with serve's values only.
- **`serve status --json` with no mapping** is `{}`.
- **With 10db's mapping** (`serve --bg --https=4399 http://127.0.0.1:4399`):
  `{"TCP":{"4399":{"HTTPS":true}},"Web":{"<fqdn>:4399":{"Handlers":{"/":{"Proxy":"http://127.0.0.1:4399"}}}}}`.
  **An HTTPS mapping has a `TCP` entry of its own**, `{ "HTTPS": true }`. A TCP forward is a `TCP[port]` entry
  with `TCPForward` (or `TerminateTLS`), which this check didn't create. So task 9's "no `TCP` entry" means: the
  port's `TCP` entry is exactly `{ "HTTPS": true }` (no `TCPForward`, no `TerminateTLS`, no other key), and
  `AllowFunnel` has no `<fqdn>:<port>` set to true.
- `tailscale serve` and `serve --https=<port> off` each exit 0 within a second here.
