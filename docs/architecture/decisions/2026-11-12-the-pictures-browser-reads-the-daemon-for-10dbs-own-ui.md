# The pictures browser reads the daemon, over the dev UI token, when the app is 10db's own UI

- **Date:** 2026-11-12
- **Amends:** `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md` (its
  browser reaches only the app; it may now also read the daemon for one app) and
  `decisions/2026-11-11-10db-runs-the-preview-while-a-pass-is-open.md` (the dev UI token it gives Open Page is
  given to the pictures browser too)

## Decision

When the app address of the project being pictured has the dev UI origin the daemon trusts
(`TENDB_DEV_UI_ORIGIN`), each shot is handed the daemon's address (`http://127.0.0.1:<port>`) and the read-only
dev UI token in the URL's fragment, in the same format Open Page uses (`handOffTo` in `packages/contracts`). For
that shot only, the pictures browser may also reach the daemon's exact origin:

- The proxy (`proxyAllows`) forwards an absolute-form `GET`, `HEAD` or `OPTIONS` on the daemon's origin.
  Every other method, a `CONNECT` to the daemon and any other spelling of it (`localhost`, `https`, another
  port) get 403, as before.
- Playwright's routing (`requestAllowed`) lets an `http` request to the daemon's origin through and still
  refuses a WebSocket to it.
- What the daemon answers is held by the dev UI token: only the reads named in `screens/dev-ui-access.ts`.

Every other app is shot as before, with a reach of the app alone, and a sign-in never reaches the daemon.

## Why

10db's own dev UI draws nothing without the daemon. Under `pnpm dev:factory` it took its token from the dev
server, so the camera saw a working UI. The 2026-11-11 decision moved the token off the dev server and into
Open Page's fragment, and the pictures browser was given no way in. Every before, turn and after picture of
10db's own pages then showed "Connecting to the 10db daemon…". The before and after are the record of how a
page got where it is, so they are worth having for 10db too.

The camera gains no reach that Open Page does not already give. Open Page hands the same token to the same dev
UI code, which a pass's agents may be editing, in the builder's own browser, which has no wall at all. The
pictures browser keeps its wall and adds one origin, for reads, under that token.

Turned down:

- **Skipping pictures of 10db's own UI.** This is safe, but it leaves the one project 10db builds most with no
  record.
- **Giving the dev server the token again.** The 2026-11-11 decision moved it off on purpose: the dev server
  runs the repository's code under the gate's sandbox.
- **The app's own UI token for the camera.** That token writes.
