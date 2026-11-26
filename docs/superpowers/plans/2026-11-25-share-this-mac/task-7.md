# Task 7: the stream by ticket and the two health shapes

Read the index's brief and Global Constraints first. Size: Core (a credential leaves the URL).

**Files:** `apps/daemon/src/api/app.ts` (the stream route, `/health`, `POST /events/ticket`),
`apps/daemon/src/screens/dev-ui-access.ts` and `apps/daemon/src/pictures/origin-guard.ts` (the one POST
exception), `apps/desktop/src/daemon/events.ts` (`eventStreamUrl` and the socket open), the desktop's hono client
module, `apps/desktop/src/test/daemon.tsx` as far as it fakes the stream, and the tests that assert `?token=`
today: `apps/daemon/src/api/app.test.ts` (around 91–105), `apps/daemon/test/acceptance.test.ts` (around 223),
`apps/desktop/src/daemon/events.test.tsx` (around 140–143).

**Rules**

- `POST /events/ticket` issues a ticket for the request's principal: `ticketScopeOf(principal)`, its `deviceId`,
  and the listener. A principal with no scope (render, none) gets 401.
- **The dev UI's one write:** both read limits allow only `GET`, and the pictures proxy lets only GET, HEAD and
  OPTIONS reach the daemon. Add `POST /events/ticket` as the single named exception in `dev-ui-access.ts`'s
  `mayRead` and in `origin-guard.ts`, with a comment saying a ticket only opens the stream that token already
  reads. The render limit (`render-access.ts`) gets no exception: a render token stays off the stream.
- The stream route reads its scope from `c.var.ticketOwner`: `full` hears every live frame, `dev_ui` hears a
  conversation's only where it is a Plan's, as today. On open it calls `registry.add(owner, ws)` **first**, then,
  for a device ticket, checks `devices.isActive(deviceId)` and closes with 4401 if false (state-table row 25). It
  removes itself from the registry on close.
- `/health`: principal `none` (no credential, or `Unknown`) answers `HealthPublicResponse`; any other answers
  today's `HealthResponse`. Check the desktop's client sends its token on `health`.
- The desktop opens each socket by first `POST`ing `/events/ticket` with its token, then connecting with
  `?after=&ticket=`. A failed ticket request counts as a failed connect for the existing backoff. The dev UI goes
  through the same code with its own token.
- Remove every remaining `?token=` read and write in daemon and desktop, including task 6's interim read.

**Tests:** none new; update the three that assert `?token=` to the ticket. The existing e2e flows open the stream
through the real daemon and app, so they fail if the ticket path breaks: run `apps/desktop/e2e/inbox.spec.ts` and
`sessions.spec.ts` locally before handing back, plus `vitest related` on the changed files.

**Spec:** §4.4, §5.3.
