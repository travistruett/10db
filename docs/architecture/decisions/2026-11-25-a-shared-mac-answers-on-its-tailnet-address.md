# A shared Mac answers on its tailnet address, to device tokens only

- **Date:** 2026-11-25
- **Amends:** `decisions/2026-10-29-dev-ui-over-the-factory.md`

## Decision

- The daemon still binds only `127.0.0.1`. Sharing adds a second listener, also on `127.0.0.1` (default port 4319),
  and `tailscale serve` maps the Mac's tailnet name to it over HTTPS. The tailnet is the only reach: 10db never
  turns on Funnel, and it never listens on another interface.
- The dev UI's origin is unchanged: loopback, opted in with `TENDB_DEV_UI_ORIGIN`. The share listener accepts the
  Mac's tailnet origin and the desktop's origins, and takes device tokens only.
- Credentials are tied to a listener. A device token works only on the share listener; there, any other bearer is
  never compared. On the main listener a request marked remote (it carries serve's headers) is refused, except
  `/health`, and the main listener gains a Host check. Which credential reaches which route is one table,
  `apps/daemon/src/api/auth-matrix.ts`, enforced by `request-guards.ts`.
- The event stream opens only with a one-use ticket that lasts 30 seconds. The `?token=` form is gone.
- The first `tailscale cert` waits for the builder's Get Certificate click. The first certificate publishes the
  Mac's name to public certificate logs, and the builder chose on 2026-11-25 that it never happens unasked.
- Calls and their costs:
  - A device token never expires. A lost phone stays valid until the builder revokes it. Revoking closes its sockets.
  - Any paired device can open a pairing code for another. One stolen, unlocked device can enrol more.
  - In slice 2 the phone's token sits in `localStorage`. Any script running in that origin can read it.

## Why

The builder wants to reach the Mac from a phone. `serve` gives TLS and the tailnet's own access control without
10db opening a port to the network, and keeps the daemon loopback-only, so the sandbox and trust-boundary model
still hold. A separate listener lets the credential rules differ per listener rather than per request, so a leaked
device token can't be replayed on the main listener and the UI token can't be used from the tailnet. Token expiry,
pair-by-owner-only and non-`localStorage` storage were turned down for now: each adds a flow the builder must
operate, and the builder is the only user.
