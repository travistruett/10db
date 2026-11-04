# Plan sees the app's own screens through a screenshot tool, never through a browser

- **Date:** 2026-11-03
- **Amends:** `decisions/2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md` (a Shape session's tool list);
  spec `docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md` §5.2 and §5.5

## Decision

A Plan (Shape) session can look at the app while it plans UI work, through one more Shape tool on the `10db`
MCP server, **`see_screen`**. It answers a picture, as the tool's result, and the picture shows in the
conversation. The session gets no browser, no click and no command.

- **The tool.** `see_screen { screen, taskId?, width?, height? }`: `screen` is `factory`, `board`, `inbox`,
  `plan` (this conversation) or `task` with a `taskId` (that task's drawer on the Board); width 480 to 1600
  (default 1200), height 400 to 2000 (default 900). It takes no selector, key, URL or script. The MCP endpoint
  returns a text block and an image block (`ToolImages`), which Claude receives as the tool's result.
  Only the main session may call it; the hook refuses it from a reviewer or the researcher.
- **Who draws: the app's own window, in a hidden frame of itself.** The daemon cannot draw a screen. A call
  becomes a request in the daemon's `ScreenBroker`; the window, which long-polls `POST /screens/claim`, loads
  the app in a hidden, sandboxed `<iframe>` at the route, waits until nothing is loading, captures the frame
  with `html-to-image` (the frame's DOM and styles drawn to a canvas) and posts the picture to
  `POST /screens/:id/image`, or a reason to `…/refuse`. No request is stored: it lives in memory until answered,
  so asking for a screen writes no row. The capture draws once and encodes that one canvas, as a PNG or, when
  that is too big, a JPEG.
- **Live data.** The frame reads the conversation's project through the daemon as it is now, not a fixture. A
  fixture would show the session a screen the builder does not have and could not be told from the real one.
  The Inbox's read spans projects, so a frame filters it to the conversation's project, and a card of another
  project (perhaps another account's) never reaches the picture.
- **Read-only, by the daemon and again by the frame.**
  - Each request carries its own **render token**, valid until that request is answered. The daemon's auth
    middleware lets it make a `GET` of a route a screen shows, and nothing else: any other method, any other
    path, a near miss of an allowed one, the event stream, `/mcp` and `/builder/mcp` are refused (403, or 401 at
    `/mcp`).
  - **Every GET the daemon serves is named in `screens/render-access.ts`, allowed or refused with a reason,** and
    `api/render-reads.test.ts` fails for a GET in neither, so a new route has to be decided before a screen can
    reach it. This is the 2026-11-02 design review's proxy (GET only, no `GET /goals/:id/digest`) as a rule the
    daemon holds. The audit found, besides the digest (moves the goal's last-opened mark): `GET
/accounts/:id/identity` (runs a command against the account's login), `GET /system` (probes the machine, and
    `?recheck=1` runs the probes again on every read) and `GET /workstreams/:id/changes` (runs git in a lane's
    checkout). All are refused, and so is every route no screen draws (settings, accounts, benchmarks, the
    event log). The drawer's Changes section therefore shows its own "can't be read" answer in a screenshot.
  - **One allowed read runs a command.** `GET /shapes/:id`, the Plan screen's own view, lists the checkout's
    tracked files with `git ls-files` to work out one-way paths. It writes nothing, so it stays: Plan's screen
    can't be drawn without it, and refusing it would be refusing the screen. The rule is that a screen may not
    change anything, not that no read may touch git.
  - **A kept picture is refused.** `GET /shapes/:id/screens/:name` is not for a render token: it would widen the
    token for a picture of a picture, which spends what one image may hold. A frame draws a dimmed line ("A
    screenshot of the Board at 900×900.") in its place and asks for nothing.
  - The frame's client is built with `readOnly`: its `fetch` rejects any method but GET before a request leaves
    the window. The frame renders the screen alone (no shell, so no tray, notification, window theme or
    keep-awake call), draws the project it was told to without writing the builder's remembered selection,
    and opens no event stream.
  - The `<iframe>` is `sandbox="allow-scripts allow-same-origin"` (no form, popup or top navigation),
    `inert`, `aria-hidden`, out of focus, `pointer-events: none`, fully transparent and behind the window, not
    outside it: WebKit is understood to slow the timers and animation frames of a subframe outside the viewport
    (recalled from its source, not observed here), which would hold a drawer's transition back. The window
    listens only to
    messages from that frame, from the app's own origin. The frame's URL is parsed with care: it believes a
    known screen, ids that are ids and the daemon's own `http://127.0.0.1:<port>` and nothing else.
  - A test dumps every table of a started daemon before and after: reading every allowed route with the token
    changes no row at all, and a screenshot changes no task, batch, card, goal view mark, setting or decision.
    A control shows the dump does see a write.
- **Refusals say why.** A screen that cannot be drawn is the tool's error with a reason, never a blank or broken
  image: no window is open (nothing asked for work lately), the window is hidden, the frame did not finish loading
  in 15 s, the screen failed to load (a 401 or 5xx on its data), the view crashed, the capture failed, used up what
  the load left of the draw's 19 s (a budget from the draw's start, a little inside the daemon's 20 s) or came out
  one flat colour, the picture is not a whole PNG or JPEG by its bytes (a PNG to its IEND, a JPEG to its EOI), is
  not the size it says, is larger than the window asked for, or is too large to keep; the task is not in this
  project; the conversation already holds 12 screens. Each writes `see_screen · refused · <reason>` as a dimmed
  line.
- **A hidden window refuses at once, from the window.** Closing 10db's window only hides it (spec §3), and a
  hidden window keeps long-polling, so the daemon cannot tell it from a visible one. A hidden WebKit page runs no
  animation frame, which `html-to-image` waits on (from WebKit's behaviour, not observed here), so a capture there
  would hang until the draw's 19 s ran out and blame the screen. The host checks `document.visibilityState` before it
  draws, and refuses with a reason that tells the session to ask the builder to bring 10db forward; a window
  hidden part-way through a draw gets the same reason, not the timeout's.
- **Image budget and context.** One picture is at most the window asked for (so at most 1600 × 2000, inside
  the API's 2000 px limit for many images), at most 1.5 MB decoded, a PNG, or a JPEG at quality 0.85 when the
  PNG is bigger. A conversation takes at most 12 screens, and the tool's description and the system prompt tell
  the session to ask for the one screen and width it needs. A fresh session (a resume with no SDK session, or a
  move past 70% of the context window) is seeded with a digest that says a screenshot was taken, of what, and
  to take it again with `see_screen`; the picture is not carried over.
- **The builder sees what Plan saw.** A `screen` transcript row names the picture (`0001.png` under the
  conversation's `screens/` directory of the data directory); the image is never in the database. The window
  reads it with `GET /shapes/:id/screens/:name` under the UI token, as a data URL (the window's CSP allows
  `img-src 'self' data:`, not `blob:`).

## Why

- **A browser would give the session a process that runs commands and clicks that act.** One click in the real
  app can Hold a task, answer a card or start work. A screenshot tool has one input (a screen name and a size)
  and one output (a picture); there is nothing to click, so there is nothing to confine after the fact.
- **The window is the one renderer the installed app already has.** The e2e suite's Playwright WebKit is not in
  the app bundle. Rejected:
  - **Snapshot a hidden Tauri webview with WKWebView's `takeSnapshot`.** It is the natural fit, but it needs
    Objective-C calls from Rust, and `src-tauri` is `unsafe_code = "forbid"`. Relaxing that lint for a call that
    cannot be run or tested in a lane was the wrong price. It stays the upgrade path if `html-to-image`'s fidelity
    falls short, behind the same `capture` seam (`screens/capture-frame.ts`).
  - **Capture the real 10db window.** It shows only what is on screen (the builder's current screen, not the one
    asked for, at the window's size, not the width asked for), needs Screen Recording permission, and shows
    anything else the window holds.
  - **Download a WebKit build on first use.** A second browser to fetch, keep current and run, from a host the app
    does not otherwise reach, driven by the daemon: a process that runs commands, which the builder ruled out.
- **A token per request, not a mode of the UI token.** The UI token reaches every write. A render token that the
  middleware holds to an allow-list means a bug or a hostile page in the frame cannot write, and a stolen one
  dies when its request does.
- **The classification test is the audit that lasts.** The review's proxy refused one GET it happened to know
  about. Two more were found by reading every route; the test makes the next one a failing test, not a
  surprise.

## What is proven, and what is not

The broker, the token rule, the image checks, the tool, the MCP image result, the hook's refusals, the frame's
parameters, sandbox and read-only client, the host's answers and the transcript image are tested, and a started
daemon drives a conversation's `see_screen` through a window played over HTTP with the database dump above, on a
real PNG. Every one of those fakes a seam of the drawing, so `e2e/see-screen.spec.ts` is written to run it with
nothing faked: a session on the fake adapter asks, the real host draws in Playwright WebKit, and the picture in the
conversation must have the width asked for and many colours, for the Board and for a Plan screen that already holds
a screenshot.

**Not proven here, and what would prove it:**

- That spec has not run yet. It needs WebKit, which a lane's sandbox can't launch, and a gate 10db runs has
  `TENDB_SANDBOX=1`, so `scripts/gate.sh` reports "e2e skipped (sandboxed)": a lane's GATE PASS says nothing about
  it. Its first run will be the `gate` job in `.github/workflows/ci.yml`, on Linux WebKit in the Playwright image,
  not on macOS. Even then it says nothing of fidelity (fonts, Mantine's CSS variables), and it runs without the
  Tauri CSP.
- Claude Code handing the image block to the model is `test/shape-session.live.test.ts` under
  `TENDB_LIVE_CLAUDE=1`: only the model can say what colours the picture holds. It type-checks; a lane can't run it.
- That a hidden WKWebView really reports `hidden` and stops its animation frames, and whether a fully covered
  window does, are read from WebKit's behaviour. The host's test fakes `visibilityState`.
- That the transcript's `content-visibility` blocks would have come out blank is reasoned, not seen; the frame
  turns `content-visibility` off so it can't happen either way.

Until the spec has passed on CI, the installed app has been checked by hand and the live test has passed, treat
`see_screen` as built but unproven live. `tsk_01a18a08-e391` (preview a task's copy live with its own dev server)
can reuse the broker and the `capture` seam, pointing the frame at its dev server's origin.
