# Task 6: the request guards and the credential middleware

Read the index's brief and Global Constraints first, and the index's "Serve facts" (the coordinator fills them
before this task). Size: Core (permissions).

**Files:** new `apps/daemon/src/api/request-guards.ts`, new `apps/daemon/src/api/credential.ts`,
`apps/daemon/src/api/app.ts` (the `.use` chain and `ApiDeps`), `apps/daemon/src/api/app.test.ts` (only to adapt
existing helpers to the new deps).

**Implements:** `ListenerAllowlists`, `RequestGuardDeps`, `hostGuard`, `originGuard`, `remoteMark`,
`CredentialDeps` and `credentialMiddleware`, as quoted in the index. `createApp`'s Hono env becomes
`{ Bindings: ApiBindings; Variables: { principal: Principal; remote: boolean; ticketOwner: TicketOwner | null } }`.

**The chain, in order:** CORS with the listener's origins → `hostGuard` → `originGuard` → `remoteMark` →
`credentialMiddleware` → the dev-UI and render read limits (moved out of today's `if` chain unchanged) → the
skill-version check → `limitBody` → routes. It replaces today's `if` chain and the stream-only Origin check.

**Rules**

- **Hosts, main:** `127.0.0.1:<port>`, `localhost:<port>`, `[::1]:<port>` for the daemon's bound port, read from a
  dep the daemon sets once it listens (`listenPort` in `start.ts`). A request with **no** `Host` passes on main
  (no browser omits it; `app.request` in tests does) and gets 421 on share. Before writing the list, check every
  caller sends one of these: the Tauri webview, Vite's dev UI on 1420, the agent skill's CLI
  (`packages/agent-skill/src/connection.ts`), the pictures proxy (`apps/daemon/src/pictures/app-proxy.ts`), the
  harness, `createTestEngine`, the e2e daemon and `scripts/`. List what you found in the commit message.
- **Hosts, share:** the value the "Serve facts" record (`<fqdn>:<share port>` if serve forwards it).
  `allowlists('share')` returns null while the name is unknown, and every share request but `/health` then gets
  503 `{ error: 'not_shared' }`.
- **Origins:** main is today's `deps.allowedOrigins`; share is `https://<fqdn>:<share port>`, `tauri://localhost`,
  `http://tauri.localhost`. A missing `Origin` passes both.
- **Remote:** the share listener, or, on the main listener, `Tailscale-Headers-Info`, `X-Forwarded-For` or a
  `*.ts.net` Host. **The listener is never swapped:** a remote-marked main request is authorised as `Main`, then
  refused 401 everywhere but Health, which answers the short shape. A `Tailscale-User-Login` header (compared
  case-insensitively) that isn't `hostLogin()`, or is present while `hostLogin()` is null, gets 403
  `{ error: 'forbidden' }`.
- **Credential:** `Authorization: Bearer <t>`, or `?ticket=` on the stream. On the **share** listener only a `tdb_`
  token (device) and a ticket are looked at; any other bearer is `Unknown` and is never passed to `sameToken`. On
  **main**, the UI, dev-UI and render tokens are compared as today with `sameToken`, a `tdb_` token is `Device`,
  and anything else is `Unknown`. Until task 7 lands, a valid UI or dev-UI token in `?token=` on the main stream becomes a ticket owner (`scope` by the token, `listener: main`) classed as `Credential.Ticket`, so the matrix and its test never change; task 7 deletes that branch.
- A ticket is spent with the request's listener; a device ticket also needs `devices.isActive(deviceId)` at spend
  time.
- `NotFound` answers 404 `{ error: 'not_found' }`; `Unauthorized` answers 401 `{ error: 'unauthorized' }`.

**Tests:** one wiring test, `request-path.test.ts`, through `createApp(...).request(path, init, { listener })` with
real `createDeviceService` and `createTickets` over a temp database: it runs the index's state-table rows 1–8,
11–14, 19 and 21–24 as one `it.each` (status code, and the short health shape for 8, 21 and 23), plus the 401 body
being identical for an unknown device, a revoked device and a wrong secret. Rows 9 and 10 stay on task 3's cheaper
rung. Value card:
`protects=the guards and the matrix hold on the real middleware for both listeners; fails_when=a guard is skipped, misordered, swaps the listener or compares a UI token on share; why_new=core: permissions; no_claim=tailscale serve's own header handling`.

**Spec:** §4.1–§4.3.
