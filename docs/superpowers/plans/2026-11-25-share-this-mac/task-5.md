# Task 5: the auth matrix

Read the index's brief and Global Constraints first. Size: Core (permissions). Pure: no I/O.

**Files:** new `apps/daemon/src/api/listener.ts`, `principal.ts`, `auth-matrix.ts`.

**Implements:** `Listener`, `ApiBindings`, `listenerOf`, `Principal`, `ticketScopeOf`, `RouteClass`,
`Credential` (with `Unknown`), `AuthVerdict`, `routeClassOf` and `authorize`, as quoted in the index.

**`routeClassOf(method, path)`:** `/health` → Health; `/mcp` → Mcp; `/builder/mcp` → BuilderMcp;
`POST /screens/claim` → ScreensClaim; `/events/stream` → Stream; `POST /events/ticket` → Ticket;
`POST /devices/pair` → Pair; `GET` or `HEAD` of `/app` or `/app/…` → AppStatic; anything else → Api. Match the
path exactly after removing one trailing slash; never by prefix except `/app/`.

**`authorize(listener, route, credential)`** is the spec's §4.3 table, written as a `Record<Listener,
Record<RouteClass, Partial<Record<Credential, AuthVerdict>>>>` whose missing cells are `Unauthorized`:

- **Main:** Health passes every credential. Mcp passes None and Unknown (its handler checks the session token, as
  today). BuilderMcp passes Ui only. ScreensClaim and Api pass Ui, DevUi and Render (their read limits follow in
  `app.ts`, as today). Ticket passes Ui and DevUi (a render token is refused on the stream today, so it gets no
  ticket). Stream passes Ticket only. Pair and AppStatic are NotFound for every credential. Device is
  Unauthorized everywhere but Health.
- **Share:** Health passes every credential. Pair and AppStatic pass None. Mcp, BuilderMcp and ScreensClaim are
  NotFound for every credential. Ticket and Api pass Device only. Stream passes Ticket only. Ui, DevUi and Render
  never occur on the share listener (task 6 classifies them as Unknown there), and the table still refuses them.

**Tests:** one table test, `auth-matrix.test.ts`, that walks every listener × route class × credential and
compares the result with an expected table written out in full in the test (not computed from the module). Also
assert `routeClassOf` for each class and for `/app` lookalikes (`/apps`, `/appx/y`, `POST /app/x`) and trailing
slashes. Value card:
`protects=each credential reaches only its cells on each listener; fails_when=a cell is loosened or a route is misclassed; why_new=core: permissions, a pure rule table; no_claim=the middleware's wiring`.

**Spec:** §4.3.
