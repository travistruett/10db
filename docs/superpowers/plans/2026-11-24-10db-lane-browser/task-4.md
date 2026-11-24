# Card 4: the Playwright driver and the live browser test

**Size:** Core (the browser's own reach checks; the live proof of the proxy). Reviewed in group 1.
**Spec:** "The tools" (Pages, Dialogs, Uploads), "Reach" (Scheme and host), "Tests" (the live browser test).
**Track:** after card 3.

## Files

- **The driver.** `apps/daemon/src/lane-browser/playwright-driver.ts` (new): `launchPlaywrightDriver`.
  - It loads Playwright only through `launchChromium` (`pictures/index.ts`), so the dynamic import stays in one
    place. It imports `playwright-core`'s types only. Amend `pictures/AGENTS.md`'s "only `pictures/playwright.ts`
    and `pictures/playwright-camera.ts` touch `playwright-core`" to name this file as the third.
  - **One context per launched browser:** `newContext({ acceptDownloads: false, serviceWorkers: 'block', viewport:
    { width: 1440, height: 900 } })`. It is the session's cookie jar until the browser closes.
  - **The first check, on the context:**
    - `context.route('**/*')`: an `http(s)` request passes when `laneUrlTarget` gives a port, and is aborted
      `blockedbyclient` otherwise.
    - `data:` and `blob:` pass unless the request is a main-frame navigation. Every other scheme is aborted.
    - Each abort goes on the driver's refused list as `<method> <origin><path>: <why>`.
    - `context.routeWebSocket`: `ws(s)` to a loopback target connects; any other closes 1008.
    - The proxy is what holds (a redirect's next hop never reaches a route), so this is a first check only, as in
      `playwright-camera.ts`'s `guard`.
  - **Navigations Playwright's route can't see:** on each page's `framenavigated` for the main frame, a URL whose
    scheme is not `http(s)` and is not `about:blank` sends the page to `about:blank` and is reported in
    `refused`.
  - **Pages:**
    - `context.on('page')` makes a popup or new tab the current page.
    - Past `BROWSER_MAX_PAGES` the oldest closes, with a note "closed the oldest page, <url>: at most four stay
      open".
    - A closed current page hands current to the newest left.
    - `pages` in every answer lists them oldest first.
  - **Dialogs**, on every page: `alert` and `beforeunload` are accepted. `confirm` and `prompt` are dismissed,
    unless the `act` call in flight named `dialog: 'accept'`. Each goes in `dialogs`. No dialog is left open past
    the call that raised it.
  - **`open(url, viewport)`:**
    - `laneUrlTarget` first; a refusal answers without `goto`.
    - Then `setViewportSize` when given.
    - Then `goto(url, { waitUntil: 'load', timeout })`, whose timeout is what is left of the call's deadline less
      5 s, at least 1 s.
    - `page.status` is the response's status, or null when none.
    - With no page yet, it opens one.
  - **`snapshot`:** `page.ariaSnapshot({ mode: 'ai' })`, cut at `SNAPSHOT_MAX_CHARS` with `snapshotCut: true` and
    a last line "… cut at 24,000 characters; act on what is shown or scroll first". With no page, the snapshot is
    null and a note says to call `browser_open`.
  - **`act`:** `page.getByRef(ref)`, then `click`, `fill(value)`, `selectOption(value)`, `check()` or
    `press(value)`, with an action timeout of at most 15 s. A ref the snapshot no longer has answers "ref e12 is
    not in the latest snapshot; call browser_snapshot". Then wait for `domcontentloaded` (at most 5 s, never an
    error) and answer with a new snapshot.
  - **`upload`:** `getByRef(ref).setInputFiles(files.map((f) => ({ name: f.name, mimeType: f.mimeType, buffer:
    Buffer.from(f.buffer) })))`, then a new snapshot. The driver never takes a path: the handler (card 5) opened and
    checked each file and passes its bytes.
  - **`screenshot`:** `page.screenshot({ type: 'png', fullPage, animations: 'disabled', timeout })`, the current
    URL and title, and `page.viewportSize()`.
  - **Every method** races its `signal`. A page that won't close when the signal aborts, or a Playwright call that
    never settles, throws `BrowserStuckError`, so `LaneBrowsers` closes the browser (card 3). Answers are built by
    one function that fills `BrowserAnswer` from the driver's state and drains its refused list.
  - **Errors:** Playwright errors become text answers, with the message's first line and no stack. A
    `net::ERR_TUNNEL_CONNECTION_FAILED` or a 403 from the proxy reads "the browser was refused <url>; see refused".
- **Wiring.** `apps/daemon/src/daemon/start.ts`: the `pinned` kind uses `launchPlaywrightDriver`. Remove card 3's
  `// TODO(lane-browser)` shim.
- **Module notes.** `apps/daemon/src/lane-browser/AGENTS.md`: the driver's checks (routing first, proxy holds), the
  pages, dialogs and snapshot rules.

## Interfaces it implements

From the index, word for word:

```ts
// apps/daemon/src/lane-browser/playwright-driver.ts (card 4)
export const launchPlaywrightDriver: LaunchLaneDriver;
```

## Interfaces it calls

From the index, word for word:

```ts
// apps/daemon/src/lane-browser/driver.ts (card 3)
export interface UploadFile { readonly name: string; readonly mimeType: string; readonly buffer: Uint8Array }
// apps/daemon/src/lane-browser/driver.ts (card 3 declares, card 4 implements with Playwright)
/** One launched browser, driven for one session; every method settles or throws, never hangs. */
export interface LaneDriver {
  open(url: string, viewport: ScreenViewport | undefined, signal: AbortSignal): Promise<BrowserAnswer>;
  snapshot(signal: AbortSignal): Promise<BrowserAnswer>;
  act(input: z.output<(typeof BrowserToolInputs)['browser_act']>, signal: AbortSignal): Promise<BrowserAnswer>;
  /** The files' bytes, read and checked by the handler (`readUploads`); the driver never opens a path. */
  upload(ref: string, files: readonly UploadFile[], signal: AbortSignal): Promise<BrowserAnswer>;
  screenshot(fullPage: boolean, signal: AbortSignal): Promise<{
    readonly png: Uint8Array; readonly url: string; readonly title: string; readonly viewport: ScreenViewport;
  }>;
  isConnected(): boolean;
  close(): Promise<void>;
}
export type LaunchLaneDriver = (options: BrowserLaunch) => Promise<LaneDriver>;

// apps/daemon/src/lane-browser/lane-reach.ts (card 2), pure
export function laneUrlTarget(raw: string): LaneTarget;

// apps/daemon/src/pictures/playwright.ts
export async function launchChromium(options: BrowserLaunch): Promise<Browser>

// apps/daemon/src/pictures/browser-host.ts
export class BrowserStuckError extends Error { override readonly name = 'BrowserStuckError'; }

// packages/contracts/src/lane-browser.ts (card 1)
export const SNAPSHOT_MAX_CHARS = 24_000;
export const BROWSER_MAX_PAGES = 4;
export type BrowserAnswer = z.infer<typeof BrowserAnswer>;

// playwright-core 1.65.0 (pinned): page.ariaSnapshot({ mode: 'ai' }) prints `[ref=e2]` refs, and
// page.getByRef(ref) resolves one against the latest snapshot.
```

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| any | `browser_open` of `file:`, `data:`, `javascript:` or a non-loopback host, `0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost` | refused before `goto`, saying why (cards 2, 4) |
| a page | navigates itself to a scheme other than http(s) | the navigation is aborted, reported in `refused`; its own `data:` and `blob:` subresources load (card 4) |
| any call | 60 s pass | the call answers "timed out"; a page that won't close closes the browser (`BrowserStuckError`), and the next call launches fresh (cards 3, 4) |
| a page | `alert`, `beforeunload` | accepted, reported in `dialogs` (card 4) |
| a page | `confirm`, `prompt` | dismissed, unless the `browser_act` that raised it named `dialog: "accept"`; reported (card 4) |
| four pages open | a popup or new tab | the oldest closes, a note says so; the new page is current (card 4) |
| any | a download | refused (`acceptDownloads: false`) (card 4) |

## Tests

**Extend** `apps/daemon/src/pictures/browser.live.test.ts` (`TENDB_LIVE_BROWSER=1`, never in CI) with one case, on
the real headless shell (core: sandbox reach, below the routing). Set it up like this:

- Two loopback HTTP servers, each a `node -e` child of the test, on ports of their own.
- A `createLaneBrowsers` with the real `launchPlaywrightDriver` and `systemPortReaders`.
- A `LaneBrowserSession` whose `members()` lists only server A's pid and start time (read with `ps`), with
  `loopback: true`, `docker: false`, and the copy and temp dir in the test's own temp folder.

Through one session's browser, it checks that:

1. `open` of A's URL answers A's page, by its title.
2. `open` of B's URL answers a refusal, and nothing reaches B (B counts its requests).
3. A page on A whose script fetches B gets no answer from B, and the fetch is in `refused`.
4. `open` of `http://127.0.0.2:<A's port>/` is refused before `goto`.

The value card says it guards the proxy below Chromium, with loopback forced through it
(`--proxy-bypass-list=<-loopback>`). Prove it red by launching once with the loopback bypass dropped from
`launchOptions`' args in a scratch edit, then restore it.

The case runs on the Mac. Run it and say in your report that it passed; CI never runs it.

## Done when

- The checks in Global Constraints pass.
- The live case passed on the Mac, and its run is named in your report.
- No new file but `playwright-driver.ts` imports `playwright-core`, and only its types.
