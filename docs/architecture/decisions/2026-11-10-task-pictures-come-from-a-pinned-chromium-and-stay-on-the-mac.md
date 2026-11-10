# Task pictures come from a pinned Chromium that reaches only the app, and stay on the Mac

- **Date:** 2026-11-10
- **Amends:** `decisions/2026-11-03-plan-sees-the-app-through-screenshots-not-a-browser.md` (that record gives
  Plan no browser; the Workbench's task pictures are taken by a browser the daemon drives, with no session at
  its controls); beside `decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md`, whose
  install and check it reuses

## Decision

- **The pin.** The Workbench's pictures of the builder's app (spec
  `docs/superpowers/specs/2026-11-09-10db-workbench-design.md` §10-§13) are taken by Chrome for Testing's
  headless shell at one build, `BROWSER_PIN` in `apps/daemon/src/pictures/browser-pin.ts`: version
  158.0.8127.18 for mac-arm64, from `cdn.playwright.dev`, with the SHA-512 of its zip recorded beside it. It is
  the build the daemon's `playwright-core` (1.65.0, pinned exactly) names in its `browsers.json`, and a test
  fails when the two part. The zip is fetched, checked, unpacked (macOS's `tar` reads zip), recorded and
  locked read-only by the agent pins' install (`environment/pinned-install.ts`, which takes a `PinnedRelease`
  for that) into `<data dir>/tools/chromium-headless-shell-<version>-darwin-arm64/`, and checked again before
  each launch. A download or copy that fails its check is refused, and the status line says why. The fetch is
  eager, once a project has an app address (`BrowserHost.prepare`); while it runs the status is `fetching`.
- **`playwright-core` ships beside the bundle.** Bundled, it cannot find the `package.json` and `browsers.json`
  it reads from disk, so the build leaves it external, copies the package whole to
  `node_modules/playwright-core` beside `daemon.mjs`, and the daemon loads it by a dynamic import when a
  picture is first taken. Renovate moves it in a PR of its own whose note says to move `BROWSER_PIN` with it
  and run the live test.
- **The renderer is sandboxed.** The launch sets `chromiumSandbox: true`; without it Playwright adds
  `--no-sandbox`. The browser gets only `HOME` and `TMPDIR` of the daemon's environment, its artifacts directory
  is `<data dir>/browser/artifacts` (0700), downloads are refused in every context, no trace, video or HAR is
  ever started, and the daemon's own signals are left to the daemon.
- **The origin guard is a proxy below Playwright.** The daemon starts an HTTP proxy on `127.0.0.1` with the
  browser (`pictures/app-proxy.ts`) and launches Chromium with `--proxy-server=http://127.0.0.1:<port>` and
  `--proxy-bypass-list=<-loopback>`, passed as Chromium's own switches, not Playwright's `proxy` option, so
  `PLAYWRIGHT_DISABLE_FORCED_CHROMIUM_PROXIED_LOOPBACK` cannot let loopback around it; and with
  `--force-webrtc-ip-handling-policy=disable_non_proxied_udp`. While a shot or a sign-in runs, the proxy
  forwards an absolute-form request on the app's origin and tunnels a `CONNECT` to exactly the app's host and
  port (`proxyAllows`); anything else, and everything between shots, gets 403 and is never forwarded. The
  browser is used by one shot or sign-in at a time, so the proxy lets one app through at a time. On top,
  Playwright's `route` and `routeWebSocket` let through only the app's origin, a WebSocket to its host and
  port, `data:`, `blob:` and `about:blank` (`requestAllowed`), and log what they refuse. A load that lands off
  the app's origin is `failed` ("left the app's address"), never `elsewhere`.
- **Each shot is a fresh context.** In-memory, with the viewport at device scale 1, no colour scheme
  emulated for the `default` theme, service workers blocked and reduced motion; the PNG is the viewport only,
  with animations off and the caret hidden. Chromium's own launch profile (a temp folder Playwright makes) is
  never used for a page, so no cookie of the app is written there.
- **What counts as broken.** A load is `failed` for no page (a navigation error, a timeout), a landing off
  the app's origin, or a document that answered 500 or more with no overlay; `elsewhere` for another path of
  the app; `overlay` when a dev server's error overlay is up (Next's error dialog,
  `nextjs-portal [data-nextjs-dialog]`, not its issue badge; Vite's `vite-error-overlay`), even on a 500, with
  up to 4 KB of its text; else `clean`.
- **No ledger, no browser.** The browser's process (the daemon's child running the pinned executable, read
  from `ps`) is watched in a lane process ledger the sweep holds while it runs, and released at close, so a
  daemon that dies leaves it for the next start to stop. When the sandbox's roots were refused there is no
  ledger, no browser is ever launched, and the status says so. The browser closes after five idle minutes and
  at shutdown.
- **The live test.** `TENDB_LIVE_BROWSER=1 pnpm --filter @10db/daemon exec vitest run
src/pictures/browser.live.test.ts` fetches the pin into the live tests' own folder and proves on it what only
  the real build can: `localhost`, `127.0.0.1` and `[::1]` go through the proxy; a document and an image,
  script and fetch redirected to a second loopback port, and direct requests and a WebSocket to it, reach it
  zero times; a sign-in that redirects there is refused; the app's WebSocket tunnels by `CONNECT`; no UDP
  leaves around the proxy; the renderer runs with its seatbelt and no process has `--no-sandbox`; the temp
  profile holds no app cookie after a signed-in shot; both overlays are recognised; and no browser process is
  left once it closes. CI never runs it; a bump of the pin or of `playwright-core` must pass it first.

- **The dev login runs as a gate, never turns Docker on, and its log is a credential.** The builder's dev
  login command (Settings › General) runs through the gate runner, outside the gate slots as a worktree's
  install does, under the gate sandbox, with no project id, so it gets the project's Docker switch as it stands
  and never turns it on; a refused `docker` says to turn on Allow Docker. It runs for at most 60 seconds. Its
  output holds a sign-in token, and the system temp dir is readable to lanes, so its log is
  `<data dir>/browser/<project id>/login-<ms>.log`, made 0600 before the command writes it and deleted once read
  whatever happened; the address is never logged or shown. The last line that is a route or a URL on the app's
  own origin is opened by the camera's sign-in, and the storage state it leads to is kept in
  `<data dir>/browser/<project id>/state.json` (0600), outside every path a lane or gate reads (the data dir is a
  protected read, which the seatbelt test shows). A capture signs in when no state is kept, and once again when
  a page lands elsewhere on the app; a page still elsewhere is said once on the task's thread.
- **The before rule.** A before shows the page before the task's first edit: it is asked only while the task
  has no pass turn (a pass page) or no session (any other task) and no kept work, and a finished one is dropped
  when a session of the task reported a Write, Edit, MultiEdit, NotebookEdit or any Bash call at or before the
  shot's end. A task's first launch waits for its before at most 20 seconds, before its session exists; past
  that the launch goes on and the rule keeps or drops the shot. While the browser downloads, befores wait for
  it and turn and after pictures are dropped.
- **Pictures are files by their hash, at 1x.** Each is the viewport's PNG at device scale 1 in each viewport and
  theme of the project's matrix (at most 4 a route), kept at `<data dir>/screens/<2 hex>/<sha256>.png` (0600),
  written under a temporary name and renamed before its row; a turn picture with the same hash as the last one
  of its route, viewport and theme is not kept. One capture runs at a time; one a turn, a take-out, a close,
  an Abandon or a changed app address overtakes writes nothing.
- **Nothing leaves the Mac.** Pictures are shown in the Workbench's thread and the task drawer, read by id with
  the UI's token; a screen's render token is refused them. They are not uploaded to a pull request and not sent
  to a model: they can show the builder's own data.

## Why

A picture of the builder's app is taken with the builder's dev session, and the daemon's own API listens on
another loopback port of the same Mac. A page, or a redirect of one, that reached it would reach it signed in.

- **Routing alone is not enough.** In `playwright-core` 1.65.0 a request that is a redirect hop is continued
  without a route (`lib/coreBundle.js`), so `route` and `routeWebSocket` never see a 302's target. Only
  something every request passes, hop by hop, can hold the guard; the live test shows a document redirected
  to the second port reaches it without the loopback rule and never with it.
- **Turned down: `--host-resolver-rules`.** It maps names, so it cannot tell two ports of one host apart (the
  app and the daemon are both on loopback), and it does not apply to IP literals.
- **The proxy grants nothing new.** It reaches only the app, which any process able to reach its loopback port
  can reach directly.
- **A pinned, checked build.** A browser Playwright was not built for drifts in ways only the live test
  shows, and an unchecked 105 MB download is code the daemon would run. The agent pins' install already
  fetches, checks and locks down a release; the browser is one more.
- **The sandbox stays on** because the pages are the builder's work in progress, whatever it loads; the live
  test shows the headless shell runs sandboxed on macOS.
- **A browser with no ledger** could outlive a daemon that dies, with the dev session in memory and nothing
  that would stop it; the lane ledger is what stops what a dead daemon left.
- **The dev login outside the gate slots** cannot wait behind a 20-minute gate while a launch waits for its
  before; it changes nothing in the folder a gate reads. **Without Docker turned on**, a dev login that needs it
  says so rather than 10db turning on the socket for a command typed in Settings.
- **A before kept only if nothing wrote first** takes a shot that is slow (a cold dev server) rather than
  holding a lane longer; a write before it finished is the only thing that makes it wrong.
- **Cost.** Web fonts and CDNs never load, so pictures show fallback fonts; 105 MB on first use; about 14 MB
  of `playwright-core` in the app.
