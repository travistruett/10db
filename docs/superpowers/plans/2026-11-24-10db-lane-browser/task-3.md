# Card 3: the session's browser: launch, ledger, lifecycle and wiring

**Size:** Core (process ledgers, recovery after a crash, sandbox reach through the session). Reviewed in group 1.
**Spec:** "The browser process" (the paragraph and its event table), "What exists and what is new".
**Track:** after card 2.
**Peer note:** this card edits `pictures/browser-ledger.ts` and `pictures/browser-host.ts`, not `pictures.ts`.
Pictures' behaviour must not change. Its host gains only the shared launch lock.

## Files

- **One launch lock for every browser.** `apps/daemon/src/pictures/browser-ledger.ts`. The pictures' browser, and
  then every lane browser, is found as "the daemon's child running the pinned executable". With two running, that
  is ambiguous: a ledger can take the other's root, and ending one session would stop another's browser.
  - `createBrowserLaunches()`: a promise chain (`one`) plus the set of roots open ledgers hold (`held`).
  - `browserRoot` takes `held` and skips those pids.
  - `openBrowserLedger`:
    - uses `deps.launches` (or one of its own when absent, as today);
    - `track` reads `held()`, takes the root, and adds it;
    - `end` removes it;
    - `pids()` answers what its watch remembers (card 3's `members()`, below).
  - `apps/daemon/src/pictures/browser-host.ts`: `open()` runs `deps.launch(...)` and `ledger.track(exe)` inside
    `deps.launches.one(...)` when given. Nothing else in the host changes.
- **The ledger's members.**
  - `apps/daemon/src/sandbox/lane-processes.ts`: `LaneProcessWatch.members()`, a read of what the watch remembers
    (pid, start time, group), copied, never the live map.
  - `apps/daemon/src/sandbox/lane-sandbox.ts`: `LaneSession.processMembers()` delegates to the session's watch.
    Session doubles in tests that build a `LaneSession` by hand get an empty list (the type requires it).
- **The session it lends.** `apps/daemon/src/runner/live-sessions.ts`: `LiveSession.browser`.
  - `apps/daemon/src/runner/runner.ts`, where it calls `opts.live.register(session.id, …)`: with a `laneSession`,
    build the `LaneBrowserSession`:
    - `copy` and `tempDir` are the real paths of `laneSession.spec.checkout` and `laneSession.tmpDir`;
    - `fileAccess` is `laneSession.fileAccess`;
    - `registeredCheckouts` is every project's `repoPath` by real path (a path that won't resolve is kept as
      written);
    - `loopback` and `docker` are `project.sandboxLoopback` and `project.sandboxDocker`;
    - `members` is `() => laneSession.processMembers()`.
  - Where the runner calls `opts.live.unregister(session.id)`, call the new `RunnerOptions.endLaneBrowser?.(id)`
    before `stopLaneProcesses`, and log a failure without throwing, as `stopLaneProcesses` does. Every way a
    session ends goes through there: finished, stopped, cancelled, taken over, the daemon stopping.
- **The lifecycle.** `apps/daemon/src/lane-browser/driver.ts` (the `LaneDriver` type, implemented in card 4) and
  `apps/daemon/src/lane-browser/lane-browsers.ts` (new). One entry per session.
  - **Launch on first `use`:**
    1. Await `ensure()`. A pinned build still fetching answers "10db is fetching its browser; try again in a
       minute". A refused build gives its reason.
    2. Make `<dataDir>/browser/lanes/<sessionId>/artifacts`, mode 0700.
    3. `openBrowserLedger` with the shared `launches`.
    4. `createPortOwner` for the session, with `proxyPorts` every running lane proxy's port and `browserPids` the
       union of every lane ledger's `pids()`.
    5. `startLaneProxy`.
    6. Inside `launches.one`: `deps.launch(launchOptions(exe, proxy.port, artifactsDir, env))`, then
       `ledger.track(exe)`. `env` is `HOME` and `TMPDIR` only, as `browserEnv` in `browser-host.ts` picks them.
       Copy those three lines; don't export the private function.
    7. A failure at any step closes what started (driver, ledger, proxy) and answers why. The session goes on.
  - **No ledger:** with `ledgers` null (sandbox roots refused), every call is refused with `NO_LEDGER_PROBLEM`'s
    words. A browser that could outlive the daemon is never launched.
  - **Queue:** one call at a time per session, a promise chain as in `browser-host.ts`.
  - **Deadline:** each `use` runs under `withDeadline(clock, CALL_DEADLINE_MS, …, stop, signal)`, counted from the
    call's arrival, so a call waiting behind another waits within its own 60 s. `signal` is the MCP call's
    session signal joined with the entry's own end signal.
  - **Stuck page:** a `BrowserStuckError`, or a deadline whose `stop` could not close the page, closes the
    browser (driver close within `BROWSER_CLOSE_MS`, then `ledger.end()`, then `proxy.close()`). The next call
    launches fresh.
  - **Idle:** `LANE_BROWSER_IDLE_MS` after its last call ends, the entry closes the same way. The next call's
    `notes` gets "The browser closed after five idle minutes, so its cookies were cleared; sign in again."
  - **`end(sessionId)`:** aborts the entry's signal, so a call in flight rejects with `LaneBrowserError("the
    session ended")`. Then it closes, removes the artifacts dir and drops the entry. Calling it for an unknown
    session is a no-op.
  - **`close()`:** ends every entry and refuses later calls.
  - **Logs:** launch, close and why, each with the session id. Never a URL's query.
- **The daemon's wiring.** `apps/daemon/src/daemon/start.ts`:
  - One `createBrowserLaunches()`, passed to the pictures host (`launches`) and to `createLaneBrowsers`.
  - One memoised `ensureBrowser` (`ensurePinned(opts.dataDir, BROWSER_PIN, …)` as `browser-host.ts` calls it),
    passed to the pictures host as `ensure` and to the lane browsers, so the two never fetch at once.
    `BROWSER_PIN` and `ensurePinned` are reached through their modules' entry points. Export `BROWSER_PIN` from
    `pictures/index.ts` if it isn't.
  - `DaemonOptions.laneBrowser`:
    - `pinned` gives `launch: launchPlaywrightDriver` (card 4). Until card 4 lands, use a shim that throws
      `LaneBrowserError('the lane browser is not built yet')`, marked `// TODO(lane-browser)`.
    - `readers: systemPortReaders(homedir(), process.env, laneProcesses.table)`.
    - `given` takes both from the options.
    - Absent: no `LaneBrowsers`, no `McpDeps.laneBrowser`, no `endLaneBrowser`.
  - `daemonPort: () => listenPort`.
  - `McpDeps.laneBrowser`: `{ browsers, sessionOf: (id) => live.get(id)?.browser }`.
  - `RunnerOptions.endLaneBrowser`: `(id) => browsers.end(id)`.
  - Shutdown: `browsers.close()` beside the pictures host's close, before the database closes.
  - `apps/daemon/src/main.ts` passes `laneBrowser: { kind: 'pinned' }` unless `TENDB_LANE_BROWSER=off`, read
    through the daemon's env schema (`env.ts`).
- **Module notes.** `apps/daemon/src/lane-browser/AGENTS.md`: the lifecycle in a few lines (launch lock, own ledger
  per browser, queue, deadline, idle, end with the session, crash reap by the sweep). `pictures/AGENTS.md`: one
  line that every browser launches and is found under one lock (`createBrowserLaunches`).

## Interfaces it implements

From the index, word for word:

```ts
// apps/daemon/src/sandbox/lane-processes.ts (card 3): LaneProcessWatch gains
  /** The processes it remembers now, the session's own among them, by pid and start time. */
  members(): readonly ProcessMember[];
// apps/daemon/src/sandbox/lane-sandbox.ts (card 3): LaneSession gains
  /** What the session's process watch remembers now (`LaneProcessWatch.members`). */
  processMembers(): readonly ProcessMember[];
// apps/daemon/src/runner/live-sessions.ts (card 3): LiveSession gains
  /** A lane session's sandbox as its browser reads it; absent for a session with no lane sandbox. */
  readonly browser?: LaneBrowserSession;

// apps/daemon/src/pictures/browser-ledger.ts (card 3)
/** One per daemon: a browser is launched and found with no other launch between, and a root one ledger
 * holds is never another's. */
export interface BrowserLaunches {
  one<T>(fn: () => Promise<T>): Promise<T>;
  /** The roots every open ledger holds; `track` skips them. */
  held(): ReadonlySet<number>;
}
export function createBrowserLaunches(): BrowserLaunches;
// BrowserLedgerDeps gains: readonly launches?: BrowserLaunches   (absent: one of its own, as today)
// BrowserHostDeps gains:   readonly launches?: BrowserLaunches   (passed to its ledger; launch + track run in one)
// BrowserLedger gains:     pids(): ReadonlySet<number>            // what its watch remembers: never an owner
// browserRoot gains a last parameter: held: ReadonlySet<number> = new Set()

// apps/daemon/src/lane-browser/driver.ts (card 3 declares, card 4 implements with Playwright)
/** One launched browser, driven for one session; every method settles or throws, never hangs. */
export interface LaneDriver {
  open(url: string, viewport: ScreenViewport | undefined, signal: AbortSignal): Promise<BrowserAnswer>;
  snapshot(signal: AbortSignal): Promise<BrowserAnswer>;
  act(input: z.output<(typeof BrowserToolInputs)['browser_act']>, signal: AbortSignal): Promise<BrowserAnswer>;
  /** `paths` are real paths the handler already checked. */
  upload(ref: string, paths: readonly string[], signal: AbortSignal): Promise<BrowserAnswer>;
  screenshot(fullPage: boolean, signal: AbortSignal): Promise<{
    readonly png: Uint8Array; readonly url: string; readonly title: string; readonly viewport: ScreenViewport;
  }>;
  isConnected(): boolean;
  close(): Promise<void>;
}
export type LaunchLaneDriver = (options: BrowserLaunch) => Promise<LaneDriver>;

// apps/daemon/src/lane-browser/lane-browsers.ts (card 3)
export const CALL_DEADLINE_MS = 60_000;
export const LANE_BROWSER_IDLE_MS = BROWSER_IDLE_MS;
export class LaneBrowserError extends Error { override readonly name = 'LaneBrowserError'; }
export interface LaneBrowsers {
  /** Runs one call on the session's browser, launching it and its proxy first when closed, after any call of
   * the session in flight, all within `CALL_DEADLINE_MS`; `notes` gets "cookies were cleared" after an idle
   * close. Throws `LaneBrowserError` with the answer's words. */
  use<T>(session: LaneBrowserSession, signal: AbortSignal,
    fn: (driver: LaneDriver, proxy: LaneProxy, notes: string[]) => Promise<T>): Promise<T>;
  /** Closes the session's browser and proxy; a call in flight answers "the session ended". */
  end(sessionId: SessionId): Promise<void>;
  /** Shutdown: ends every session's browser and refuses later calls. */
  close(): Promise<void>;
}
export function createLaneBrowsers(deps: {
  readonly dataDir: string;
  readonly ledgers: { readonly sweep: LedgerSweep; readonly root: string } | null;
  readonly processes: LaneProcessSetup;
  readonly launches: BrowserLaunches;
  readonly ensure: () => Promise<string>;
  readonly launch: LaunchLaneDriver;
  readonly readers: PortReaders;
  readonly daemonPort: () => number | null;
  readonly clock: Clock;
  readonly logger: Logger;
}): LaneBrowsers;

// apps/daemon/src/daemon/start.ts (card 3): DaemonOptions gains
  /** The lane browser: the pinned build (the entry point), or a driver tests give. Absent, lanes get no
   * browser tools and nothing is fetched. */
  readonly laneBrowser?:
    | { readonly kind: 'pinned' }
    | { readonly kind: 'given'; readonly launch: LaunchLaneDriver; readonly readers: PortReaders };
// apps/daemon/src/mcp/tools.ts (card 3): McpDeps gains
  /** Each lane session's browser; absent, a lane is not offered the browser tools. */
  readonly laneBrowser?: {
    readonly browsers: LaneBrowsers;
    sessionOf(sessionId: SessionId): LaneBrowserSession | undefined;
  };
```

Also `RunnerOptions.endLaneBrowser?: (sessionId: SessionId) => Promise<void>`. It is absent in every test that
gives no lane browser.

## Interfaces it calls

From the index, word for word:

```ts
// apps/daemon/src/runner/live-sessions.ts
export interface LiveSession {
  readonly signal: AbortSignal;
  readonly observer: WaitObserver;
  /** A tool's answer told the session to hand off, so a handoff it writes is one 10db asked for. */
  askedToHandOff(): void;
  /** Present for a lane nobody watches: its questions are answered at once and kept. */
  readonly away?: AwayLane;
}

// apps/daemon/src/sandbox/lane-processes.ts
export interface ProcessMember {
  readonly pid: number;
  /** `ps`'s start time: a recycled pid has another one, and is left alone. */
  readonly startedAt: string;
  /** The process group when last seen; 0 when not yet known. */
  readonly pgid: number;
}
export interface LaneProcessWatch {
  track(root: { readonly pid: number; readonly startedAt: string | null }): Promise<boolean>;
  end(): Promise<void>;
  pending(): boolean;
  markOwn(): void;
  endJobs(): Promise<void>;
}

// apps/daemon/src/sandbox/lane-sandbox.ts (LaneSession, the fields the browser reads)
  readonly spec: LaneSandboxSpec;          // spec.checkout: the checkout's real path
  readonly fileAccess: FileAccessContext;
  readonly tmpDir: string;
  readonly commandEnv: Readonly<Record<string, string>>;
  endProcesses(): Promise<void>;

// apps/daemon/src/pictures/browser-host.ts
export const BROWSER_IDLE_MS = 5 * 60_000;
export const BROWSER_CLOSE_MS = 10_000;
export class BrowserStuckError extends Error { override readonly name = 'BrowserStuckError'; }
export interface BrowserLaunch {
  readonly executablePath: string;
  readonly headless: true;
  readonly chromiumSandbox: true;
  readonly args: readonly string[];
  readonly env: Readonly<Record<string, string>>;
  readonly artifactsDir: string;
  readonly handleSIGINT: false;
  readonly handleSIGTERM: false;
  readonly handleSIGHUP: false;
  readonly timeout: number;
}
export function launchOptions(
  executablePath: string,
  proxyPort: number,
  artifactsDir: string,
  env: Readonly<Record<string, string>>,
): BrowserLaunch
export interface BrowserHostDeps<B extends ClosableBrowser> {
  /* … */ readonly ensure?: () => Promise<string>; /* … */
}

// apps/daemon/src/pictures/browser-ledger.ts
export function browserRoot(
  rows: readonly ProcessRow[],
  commands: ReadonlyMap<number, string>,
  exe: string,
  ownPid: number,
): ProcessRow | null
export interface BrowserLedgerDeps {
  readonly root: string;
  readonly sweep: LedgerSweep;
  readonly processes: LaneProcessSetup;
  readonly commands?: CommandReader;
  readonly onError?: (failure: LaneProcessFailure, error: unknown) => void;
}
export interface BrowserLedger {
  track(exe: string): Promise<void>;
  end(): Promise<void>;
}
export function openBrowserLedger(deps: BrowserLedgerDeps): BrowserLedger

// apps/daemon/src/pictures/deadline.ts
export function withDeadline<T>(
  clock: Clock, ms: number, work: () => Promise<T>, stop: () => void, signal?: AbortSignal,
): Promise<T>

// apps/daemon/src/environment/pinned-install.ts
export async function ensurePinned(
  dataDir: string, pin: PinnedRelease, deps: InstallDeps, options: EnsureOptions = {},
): Promise<string>

// apps/daemon/src/lane-browser/session.ts (card 2 declares it, card 3 fills it from the runner)
/** What a lane session lends its browser; the runner builds it from the session's sandbox. */
export interface LaneBrowserSession {
  readonly sessionId: SessionId;
  readonly projectId: ProjectId;
  readonly taskId: TaskId;
  readonly workstreamId: WorkstreamId;
  /** Real paths: the session's checkout and its own temp dir. */
  readonly copy: string;
  readonly tempDir: string;
  readonly fileAccess: FileAccessContext;
  /** Every project's checkout, real paths: a compose dir inside one owns nothing. */
  readonly registeredCheckouts: readonly string[];
  readonly loopback: boolean;
  readonly docker: boolean;
  /** The session's process ledger as it reads now. */
  members(): readonly ProcessMember[];
}

// apps/daemon/src/lane-browser/port-owner.ts, lane-proxy.ts (card 2)
export function createPortOwner(deps: {
  readonly clock: Clock;
  readonly readers: PortReaders;
  readonly daemonPort: () => number | null;
  readonly proxyPorts: () => ReadonlySet<number>;
  readonly browserPids: () => ReadonlySet<number>;
}, session: LaneBrowserSession): PortOwner;
export function startLaneProxy(owner: PortOwner, logger: Logger): Promise<LaneProxy>;
```

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| no browser for the session | first tool call | the pinned build is ensured (shared with pictures), a proxy starts, Chromium launches at it and its ledger finds it under the launch lock; the call runs (card 3) |
| no browser | the launch fails, or the build is still fetching or refused | the call answers why ("the browser is being fetched; try again in a minute"); the session goes on (card 3) |
| a call in flight | a second call of the same session | it waits for the first, within its own 60 s (card 3) |
| any call | 60 s pass | the call answers "timed out"; a page that won't close closes the browser (`BrowserStuckError`), and the next call launches fresh (cards 3, 4) |
| browser idle five minutes | the idle timer | browser, proxy and ledger closed; the next call launches fresh and notes "cookies were cleared" (card 3) |
| browser running | session ends, is stopped or taken over | the runner ends it beside `endProcesses`; a call in flight answers "the session ended" (card 3) |
| browser running | daemon restart or crash | its ledger is swept at the next start; nothing was saved (card 3) |
| two sessions launching, or pictures' browser running | a launch | launch and find run under one lock; a root another ledger holds is never taken (card 3) |
| next session of the task (review, QA) | first call | a fresh browser; the stack the implement step left is the new session's only by the rule as read now (its compose dir is the shared copy) (cards 2, 3) |

## Tests

- **One case** in `apps/daemon/src/pictures/browser-host.test.ts`, the file that tests the browser's ledger
  (core: process ledgers and recovery; a wrong root stops another session's browser). Two daemon children run the
  same executable; with the first's pid held, `browserRoot` answers the second. Prove it red against today's
  `browserRoot`.
- No test of the lifecycle table: card 5's wiring test runs it through the real pipeline, and card 4's live test
  through the real browser.

## Done when

- The checks in Global Constraints pass.
- A daemon started with `TENDB_LANE_BROWSER=off`, and one with no `laneBrowser`, offer no browser tools and fetch
  nothing.
- Pictures' own tests (`pictures/*.test.ts` related to the two files you changed) are green.
