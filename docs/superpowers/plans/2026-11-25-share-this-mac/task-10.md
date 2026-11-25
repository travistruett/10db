# Task 10: the share listener and the routes

Read the index's brief and Global Constraints first. Size: Core (a second listener).

**Files:** new `apps/daemon/src/sharing/share-listener.ts`, `apps/daemon/src/daemon/start.ts` (build the
services, start and stop sharing, the main listener's fetch wrapper), `apps/daemon/src/api/app.ts` (the routes in
the index, each calling a service), `apps/daemon/src/daemon/AGENTS.md` or `apps/daemon/AGENTS.md` (the listener
line).

**Implements:** `ShareListener`, `ShareListenResult` and `startShareListener`, as quoted in the index, and the
HTTP routes table.

**Rules**

- The share listener is a second `serve()` from `@hono/node-server` on `127.0.0.1:<port>` with its own
  `WebSocketServer({ noServer: true })`, the same `app`, and `fetch: (req, env) => app.fetch(req, { ...env,
  listener: Listener.Share })`. The main listener's `fetch` passes `listener: Listener.Main` the same way.
- `EADDRINUSE` answers `{ ok: false, holder }`, where `holderOf` runs `lsof -nP -iTCP:<port> -sTCP:LISTEN -Fpc`
  and returns `"<command> (pid <n>)"` or null.
- In `startDaemon`: build `createSocketRegistry`, `createTickets`, `createPairingCodes`, `createDeviceService`
  and `createSharingService` after the database opens; call `sharing.start()` after the main listener is up and
  recovery has run; make `sharing.stop()` the **first** step of the daemon's `stop()`, so a shutdown killed
  part-way has already unshared.
- `POST /sharing/certificate` calls `requestCertificate()`.
- `GET /devices`, `POST /devices/pairing-code` (409 `{ error: 'not_ready', message }` on
  `SharingNotReadyError`), `POST /devices/pair` (401, or 429 when `rateLimited`), `DELETE /devices/:deviceId`
  (204, 404), `GET /sharing`, `PUT /sharing` (409 with the refusal's sentence). Bodies validated with the task 1
  schemas.
- `GET /app/*` on the share listener answers 404 in this slice.
**Tests:** extend task 6's `request-path.test.ts` with one case that runs through the real `startShareListener`
on port 0 (a real socket, `fetch` to `127.0.0.1`), pairs, opens a WebSocket with a device ticket, revokes, and
sees the socket close with 4401; it covers state-table row 15. No new file. Value card:
`protects=revoke closes a real socket on the real share listener; fails_when=the registry isn't wired to the listener's sockets; why_new=core: permissions; no_claim=tailscale serve in front`.

**Spec:** §3.3, §4.3, §5.
