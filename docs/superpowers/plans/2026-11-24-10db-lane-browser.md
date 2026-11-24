# Plan: the lane browser

**Size:** Core (sandbox reach). It opens a new path from a sandboxed lane to loopback, held by an ownership rule
on every connection, and it sends lane screenshots to the lane's model. It gets this index, one card per task and a
plan review. The desktop and docs card (7) is Feature-sized inside it and gets no process of its own.
**Spec:** `docs/superpowers/specs/2026-11-23-10db-lane-browser-design.md` (approved). Cards name its sections by
heading.
**Builds on:** `main` at `7dde4895`. Nothing else in flight.

## Brief

**What changes for you.**
- Every lane, on every account, has five tools on 10db's own server: `browser_open`, `browser_snapshot`,
  `browser_act`, `browser_upload` and `browser_screenshot`. A lane starts its own app (a dev server, or a Docker
  Compose stack from its copy), opens it, signs in through the app's own pages, clicks, fills, uploads a fixture
  from its copy and takes screenshots.
- A screenshot is kept on the task as a **lane screen** with the lane's note, and recorded as browser evidence.
  The task drawer shows lane screens in their own group under Pictures, labelled with the note. The Linear
  reporter's brief lists them.
- Recovery stops offering **Run these now** for a skipped call whose program can't run in a lane at all (the
  Aside CLI, say). The card says "use 10db's browser, or run it yourself".
- Your browser, cookies, Aside, your stack on 8800, other lanes' servers and 10db's daemon never come into it.

**What it buys.** AMP-56's workbook import and every browser QA step run unattended to the end on any account,
with screenshots as evidence that review, QA and the reporter can cite.

**What could go wrong, and how we'd know.**
- **A lane reaches a server that isn't its own.** Every connection goes through a per-session proxy that asks the
  ownership rule first (a listener in the session's process ledger, or a Compose stack started from its copy or
  temp dir). The rule is a pure table test (card 2); one test through the real pipeline shows an unowned loopback
  server refused and an owned one reached (card 5); the live browser test runs the real Chromium against both
  (card 4).
- **Two browsers are mistaken for each other**, so ending one session kills another's browser, or pictures'.
  Today the ledger finds "the daemon's child running the pinned executable", which is ambiguous once several run.
  Card 3 launches and finds browsers one at a time and never takes a root another ledger holds.
- **A screenshot ends a session.** An image over the account's size or side limit, or past its conversation
  budget, would fail every later turn. Lane screenshots draw on the same budget as `check_design`; one that doesn't
  fit goes as its PNG path only, and every answer names that path (card 5).
- **A lane uploads, or overwrites, a file it may not touch** by swapping a link in after the check. The handler
  opens each upload itself without following a link, checks the open file is the one the rule allowed, and hands
  the browser bytes, never a path; the screenshot's copy in the temp dir is written the same way (card 5's test).
- **A Compose stack on `0.0.0.0` sits beside your server on `127.0.0.1` on the same port.** A stack's port is the
  lane's only when Docker bound it to `127.0.0.1`, or to all addresses with nothing else bound to `127.0.0.1` there
  (card 2's table).
- **Codex drops MCP images.** The PNG path is in every answer, and card 6's live check decides whether Codex lanes
  are told to open it with `view_image`.

**Calls you might disagree with.**
1. **Lane screens are pruned like turn pictures**, 14 days after their task is done or cancelled; the evidence row
   stays and says the picture was pruned. Cost if wrong: an old QA run's pictures are gone.
2. **One migration** adds five nullable columns (a lane screen's URL, title, note and the session it was sent to;
   the evidence row's screen).
   The spec asked for these fields but the tables have no place for them. Generated last, after the final merge of
   `main`.
3. **The lane browser has its own process ledger**, as pictures' browser does, and is closed beside
   `endProcesses` when the session ends. The spec said "held in the session's own process ledger"; the browser is
   the daemon's child, not the session's, so the session's watch would never see it. Same effect: ended with the
   session, reaped after a crash.
4. **A listener counts as the session's when it, or any process above it, is in the session's ledger.** The ledger
   samples every second, so a server forked a moment ago would otherwise be refused until the next sample.
5. **The e2e seeds a lane screen** into the core loop flow (`loop.spec.ts`) rather than drive a real browser: no
   e2e today shows the drawer's pictures, and the e2e daemon runs no browser.
6. **Batch-mates that share a worktree share their stacks**: the compose rule owns a stack by its copy, and they
   have one copy. Their own processes stay apart (the ledger rule). Accepted: they are one batch's work.
7. **HTTPS with a self-signed certificate fails** (no certificate is trusted beyond Chromium's defaults). A lane's
   dev server on plain `http` works.

**What is needed from you.** Nothing. AMP-56 through a Codex lane is the acceptance run once it is installed.

---

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the `AGENTS.md` of every
  directory you touch, once each. Keep notes in your scratch folder.
- **Integration branch** `feat/lane-browser`, a draft PR from the first push. Each card runs in its own worktree
  `../10db-worktrees/lane-browser-<n>` branched from the integration branch, and the coordinator merges it in.
- **The repo typechecks after every card.** Where a later card owns a caller, the earlier card bridges it with the
  smallest shim marked `// TODO(lane-browser)`. None may remain when the PR leaves draft.
- **Migrations are forward-only** (`packages/db/AGENTS.md`). Card 1 generates one dev migration so the branch's
  tests run. At each merge of `main` into the integration branch the coordinator checks whether `main` added a
  migration; if so it deletes the dev migration (its `.sql`, its `drizzle/meta` snapshot and its `_journal.json`
  entry), takes `main`'s files, runs `pnpm --filter @10db/db generate`, and commits the result in the merge. After
  the final merge of `main` it regenerates once more. Only one open PR adds migrations at a time: the coordinator
  checks before the PR leaves draft.
- **Reach is never widened by a fallback.** No code path connects to a name it resolved, to a port the rule didn't
  answer `owned` for in this check, or to an address the listener didn't report. A reading that fails (`lsof`,
  `docker ps`, the process table) is a refusal that says so, never an allow.
- **Nothing waits on the builder.** Every tool call answers within `CALL_DEADLINE_MS` (60 s) with text; a refusal
  is final and says why. No tool raises an Inbox card.
- **The browser never touches the builder's world.** `HOME` and `TMPDIR` only (`launchOptions`), a profile of its
  own under the data dir, no extension, no stored state across sessions, downloads refused, service workers blocked.
- **Pictures are untouched in behavior.** Its queue, its proxy and its host's one-at-a-time use stay as they are.
  Card 3 changes only how its ledger finds its browser (shared with the lane browsers).
- **Peer ownership tonight.** Session 10db-a2 owns `apps/daemon/src/pictures/pictures.ts`,
  `apps/desktop/src/views/settings/**` and the task drawer (`apps/desktop/src/views/board/task-pictures.tsx`,
  `task-drawer.tsx`). No card edits `pictures.ts` or Settings. Card 7 edits `task-pictures.tsx`: the coordinator
  clears it with 10db-a2 before that card starts.
- Tests: only those named on the card, each proven red first, each with a value card in its commit
  (`.claude/rules/testing.md`). No rendered-component tests, no test-only exports or branches.
- While working, run `pnpm exec vitest related <files> --maxWorkers=2` in the package, plus typecheck and lint of
  the packages changed. Before you hand back, run `make precheck`. Never the full suite, never
  `make check-changed` (this is an integration branch).
- Commit after every green step, naming paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`.
- Use the injected `Clock`, not `Date.now` or a bare `setTimeout`. Child processes the daemon runs (`lsof`,
  `docker`) get a deadline, a fixed env and `execFile` with an argument list, never a shell.

## Provider parity

The tools are on 10db's MCP server, which every lane gets, and their reach is held in the daemon, so the browser,
the ownership rule, the evidence and the drawer are the same on every account. `mcp__10db__*` is allowed by prefix
in every step, read-only ones included (`guard/judge.ts`, `permissions/rules.ts`), so no judge runs and nothing is
skipped. What differs is only how a screenshot reaches the model:

| Account | Image limits (`pictureLimitsFor`) | A screenshot |
| --- | --- | --- |
| Claude plan, Anthropic API key | `CLAUDE_LIMITS` | an image block when it fits; else its path |
| Claude through Bedrock | `BEDROCK_LIMITS` (3.5 MiB an image, 6 MiB a message, 8 MiB a conversation) | the same, against the smaller budget |
| ChatGPT/Codex plan, OpenAI API key | `STRICTEST_LIMITS` | an image block when it fits, which Codex may drop (card 6 checks); its path always |
| OpenRouter | `NO_PICTURES` unless the model lists image input | its path only |

Every answer carries the PNG's path in the session's temp dir, so a lane that gets no image reads it with `Read`
(Claude) or `view_image` (Codex). If card 6's live check shows Codex drops MCP images, Codex lanes' brief tells them
to open the path, and the coordinator files a follow-up task for Codex's support. Codex's MCP tool timeout (the
project's human wait plus five minutes) and Claude Code's are both above the 60 s call deadline.

## Interfaces

Each card repeats, word for word, the blocks it implements or calls.

### Existing (quoted from `main` at 7dde4895)

```ts
// apps/daemon/src/mcp/server.ts
/** A tool as the endpoint registers it: its name, words, input schema and what running it does. */
interface RegisteredTool {
  readonly name: string;
  readonly description: string;
  readonly schema: z.ZodType;
  run(input: unknown): Promise<unknown>;
}
function laneTools(
  deps: McpDeps,
  sessionId: SessionId,
  workstreamId: WorkstreamId,
  claimWaits: ClaimWaits,
): RegisteredTool[]

// apps/daemon/src/mcp/tool-images.ts
export class ToolImages {
  readonly text: string;
  readonly images: readonly { readonly mediaType: string; readonly data: string }[];
}

// apps/daemon/src/mcp/tools.ts (McpDeps, last field)
  /** Draws a mock-up and shoots the app for `check_design`; absent, a lane is not offered it. */
  readonly pictures?: Pick<Pictures, 'shootNow' | 'drawMockup' | 'bytesOf'>;

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

// apps/daemon/src/sandbox/file-access.ts
export type ReadAccess =
  'inside' | 'allowed' | 'protected' | 'contains-protected' | 'outside-copy' | 'ask';
export function readAccess(
  spelled: string,
  ctx: FileAccessContext,
  tree = false,
  cwd?: string,
): { access: ReadAccess; realPath: string }

// apps/daemon/src/sandbox/docker-access.ts
export function dockerEnvNames(env: Readonly<Record<string, string>>): string[]

// apps/daemon/src/git/install-prefixes.ts (exported from git/index.ts)
export function firstExecutable(candidates: readonly string[]): string | null
export function installCandidates(name: string): string[]

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

// apps/daemon/src/pictures/playwright.ts
export async function launchChromium(options: BrowserLaunch): Promise<Browser>

// apps/daemon/src/pictures/deadline.ts
export function withDeadline<T>(
  clock: Clock, ms: number, work: () => Promise<T>, stop: () => void, signal?: AbortSignal,
): Promise<T>

// apps/daemon/src/pictures/picture-files.ts
export type ScreenToKeep = Omit<NewTaskScreen, 'sha256' | 'size' | 'width' | 'height' | 'storedPath'> & {
  readonly png: Uint8Array;
};
export function keepScreen(state: StateStore, dataDir: string, screen: ScreenToKeep): TaskScreenDto | null
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null

// apps/daemon/src/environment/pinned-install.ts
export async function ensurePinned(
  dataDir: string, pin: PinnedRelease, deps: InstallDeps, options: EnsureOptions = {},
): Promise<string>

// apps/daemon/src/conversation/picture-budget.ts, picture-limits.ts
export function imagesWithinBudget(sizes: readonly number[], spent: number, limits: PictureLimits): number[]
export function pictureLimitsFor(
  kind: AccountKind, on?: { readonly accountId: AccountId; readonly launchId: string },
): PictureLimits                                  // PictureLimits.imageMaxSide: 3000 on every platform

// packages/contracts/src/entities.ts
export function isDaemonAddress(appUrl: AppUrl, daemonPort: number): boolean
// EvidenceDto: z.discriminatedUnion('kind', [...]) over EvidenceBase
//   { id, workstreamId, summary, logPath, commitShas, createdAt } with command/exitCode per kind

// packages/contracts/src/task-screens.ts
export const ScreenKind = { Before: 'before', Turn: 'turn', After: 'after' } as const;

// packages/contracts/src/skipped-actions.ts
export function approvalOf(kind: SkipKind, summaryCut: boolean): Approval

// packages/db/src/store/task-screens.ts
export interface NewTaskScreen {
  readonly taskId: TaskId; readonly turnId: PassTurnId | null; readonly kind: ScreenKind;
  readonly route: string; readonly viewport: ScreenViewport; readonly theme: ScreenTheme;
  readonly sha256: string; readonly size: number; readonly width: number; readonly height: number;
  readonly storedPath: string; readonly keptSha: string | null;
}

// apps/daemon/src/trust/skip-recorder.ts
export function createSkipRecorder(
  deps: { readonly state: StateStore; readonly log: Logger },
  run: { readonly workstreamId: WorkstreamId; readonly sessionId: SessionId | null },
): SkipRecorder

// apps/daemon/src/briefing/prompts.ts (PromptInput)
  readonly pictures?: boolean;

// playwright-core 1.65.0 (pinned): page.ariaSnapshot({ mode: 'ai' }) prints `[ref=e2]` refs, and
// page.getByRef(ref) resolves one against the latest snapshot.
```

### New

```ts
// packages/contracts/src/lane-browser.ts (card 1), exported from the package entry
export const BrowserToolName = {
  Open: 'browser_open',
  Snapshot: 'browser_snapshot',
  Act: 'browser_act',
  Upload: 'browser_upload',
  Screenshot: 'browser_screenshot',
} as const;
export type BrowserToolName = (typeof BrowserToolName)[keyof typeof BrowserToolName];
export const BrowserAction = {
  Click: 'click', Fill: 'fill', Select: 'select', Check: 'check', Press: 'press',
} as const;
export type BrowserAction = (typeof BrowserAction)[keyof typeof BrowserAction];
/** A ref from the latest snapshot, as `[ref=e12]` prints it. */
export const ElementRef = z.string().regex(/^[A-Za-z0-9]{1,32}$/);
export const BrowserToolInputs = {
  [BrowserToolName.Open]: z.strictObject({ url: z.string().min(1).max(2048), viewport: ScreenViewport.optional() }),
  [BrowserToolName.Snapshot]: z.strictObject({}),
  [BrowserToolName.Act]: z.strictObject({
    ref: ElementRef,
    action: z.enum(BrowserAction),
    /** The text to fill, the option to select, or the key to press; refused for click and check. */
    value: z.string().max(10_000).optional(),
    /** Accepts a `confirm` or `prompt` the action raises; absent, it is dismissed. */
    dialog: z.literal('accept').optional(),
  }),                                   // a superRefine: fill, select and press need `value`; click and check refuse it
  [BrowserToolName.Upload]: z.strictObject({ ref: ElementRef, paths: z.array(z.string().min(1).max(4096)).min(1).max(10) }),
  [BrowserToolName.Screenshot]: z.strictObject({ fullPage: z.boolean().optional(), note: z.string().max(500).optional() }),
} as const satisfies Record<BrowserToolName, z.ZodType>;
export const BROWSER_TOOL_DESCRIPTIONS: Record<BrowserToolName, string>;
/** The most characters of a snapshot an answer carries; a longer one is cut and says so. */
export const SNAPSHOT_MAX_CHARS = 24_000;
/** The most pages a session's browser holds open; a fifth closes the oldest. */
export const BROWSER_MAX_PAGES = 4;
export const BrowserDialog = z.object({
  type: z.enum(['alert', 'beforeunload', 'confirm', 'prompt']),
  message: z.string(),
  answer: z.enum(['accepted', 'dismissed']),
});
/** What every tool but `browser_screenshot` answers, as JSON text. */
export const BrowserAnswer = z.object({
  /** The current page: its URL after redirects, its title, and the status of its last navigation. */
  page: z.object({ url: z.string(), title: z.string(), status: z.int().nullable() }).nullable(),
  /** Every open page, oldest first; `current` marks the one the snapshot reads. */
  pages: z.array(z.object({ url: z.string(), title: z.string(), current: z.boolean() })),
  snapshot: z.string().nullable(),
  snapshotCut: z.boolean(),
  /** Each request refused since the last answer: `<method> <origin><path>: <why>`, never the query. */
  refused: z.array(z.string()),
  dialogs: z.array(BrowserDialog),
  /** What else the lane should know: cookies cleared after an idle close, a page closed for a fifth. */
  notes: z.array(z.string()),
});
export type BrowserAnswer = z.infer<typeof BrowserAnswer>;

// packages/contracts/src/task-screens.ts (card 1)
export const ScreenKind = { Before: 'before', Turn: 'turn', After: 'after', Lane: 'lane' } as const;
// TaskScreenDto gains, null on every kind but `lane`:
  /** Origin and path only: the query and fragment are dropped before it is kept. */
  url: z.string().max(2048).nullable(),
  title: z.string().max(512).nullable(),
  note: z.string().nullable(),

// packages/contracts/src/states.ts, entities.ts (card 1)
// EvidenceKind gains Browser: 'browser'. EvidenceDto gains the variant
  z.object({ ...EvidenceBase, kind: z.literal(EvidenceKind.Browser), command: z.null(), exitCode: z.null(),
    screenId: TaskScreenId }),

// packages/db/src/schema.ts (card 1)
// task_screens: url: text('url'), title: text('title'), note: text('note'),
//   sentSessionId: text('sent_session_id').$type<SessionId>()                         // all nullable
// evidence: screenId: text('screen_id').$type<TaskScreenId>().references(() => taskScreens.id)   // nullable

// packages/db/src/store/task-screens.ts (card 1)
// NewTaskScreen gains, optional, so every caller outside a lane screen is unchanged:
  readonly lane?: {
    readonly url: string; readonly title: string; readonly note: string | null;
    /** The session the picture went to as an image block; null when it went as a path only. */
    readonly sentSessionId: SessionId | null;
  };
/** The summed size of unpruned lane screens sent as image blocks to any of these sessions. */
export function laneScreenBytesSentTo(db: DbReader, sessionIds: readonly SessionId[]): number;
// packages/db/src/store/evidence.ts (card 1): NewEvidence gains
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Browser;
      readonly command: null;
      readonly exitCode: null;
      readonly screenId: TaskScreenId;
    })

// apps/daemon/src/lane-browser/lane-reach.ts (card 2), pure
/** A browser's request target, read before any reading: a loopback port, or why not. */
export type LaneTarget =
  | { readonly kind: 'port'; readonly port: number }
  | { readonly kind: 'refused'; readonly why: string };
/** A URL a tool loads or a navigation goes to: http or https, host exactly localhost, 127.0.0.1 or [::1]. */
export function laneUrlTarget(raw: string): LaneTarget;
/** What the proxy is asked: absolute-form `http://` only, or `CONNECT host:port`; userinfo and origin-form refused. */
export function laneProxyTarget(request: { readonly method: string; readonly target: string }): LaneTarget;
export interface PortReadings {
  /** `lsof`'s listeners on the port: each one's address and its process chain, itself first, up to launchd. */
  readonly listeners: readonly {
    readonly address: string;
    readonly chain: readonly { readonly pid: number; readonly startedAt: string }[];
  }[] | 'unread';
  /** Each publication of the port by a running container: its compose working dir (null without the label)
   * and the host address Docker bound (`127.0.0.1`, `0.0.0.0`, `::`, or another); null when Docker is off for
   * the project, 'unanswered' when `docker ps` failed or passed 5 s. */
  readonly compose: readonly { readonly workingDir: string | null; readonly hostIp: string }[] | null | 'unanswered';
}
export interface PortSession {
  /** `${pid}:${startedAt}` of every process the session's ledger holds. */
  readonly members: ReadonlySet<string>;
  /** Every lane browser's pids (`BrowserLedger.pids`): never an owner. Pictures' browser and every proxy run
   * as the daemon or its children, whose chains reach no session's member. */
  readonly browserPids: ReadonlySet<number>;
  /** Real paths. */
  readonly copy: string;
  readonly tempDir: string;
  readonly registeredCheckouts: readonly string[];
  /** The project lets lane commands bind localhost (`sandboxLoopback`). */
  readonly loopback: boolean;
}
export type PortVerdict =
  | { readonly kind: 'owned'; readonly connectTo: '127.0.0.1' | '::1' }
  | { readonly kind: 'refused'; readonly why: string };
/** The ownership rule. The daemon's and every lane proxy's port are refused before any reading. */
export function portVerdict(input: {
  readonly port: number;
  readonly daemonPort: number | null;
  readonly proxyPorts: ReadonlySet<number>;
  readonly session: PortSession;
  readonly readings: PortReadings;
}): PortVerdict;
/** How long a port's verdict is kept, and how many fresh checks a session gets a minute. */
export const PORT_CACHE_MS = 5_000;
export const PORT_CHECKS_PER_MINUTE = 20;

// apps/daemon/src/lane-browser/port-owner.ts (card 2)
export interface PortReaders {
  /** `lsof -nP -a -iTCP:<port> -sTCP:LISTEN`, each listener's pid and address; rejects on failure. */
  listeners(port: number): Promise<readonly { readonly pid: number; readonly address: string }[]>;
  /** The process table, for each listener's chain and start times. */
  readonly table: ProcessTable;
  /** `docker ps` for the port's publications: compose working dir and host address; null when no docker is found. */
  readonly compose: ((port: number) => Promise<readonly { readonly workingDir: string | null; readonly hostIp: string }[]>) | null;
}
export function systemPortReaders(
  home: string, env: Readonly<Record<string, string | undefined>>, table: ProcessTable,
): PortReaders;
export interface PortOwner {
  /** The verdict for a connection now: cached `PORT_CACHE_MS`, read again after, at most
   * `PORT_CHECKS_PER_MINUTE` fresh reads a minute (past it, refused). */
  check(port: number): Promise<PortVerdict>;
}
export function createPortOwner(deps: {
  readonly clock: Clock;
  readonly readers: PortReaders;
  readonly daemonPort: () => number | null;
  readonly proxyPorts: () => ReadonlySet<number>;
  readonly browserPids: () => ReadonlySet<number>;
}, session: LaneBrowserSession): PortOwner;

// apps/daemon/src/lane-browser/lane-proxy.ts (card 2)
export interface LaneProxy {
  readonly port: number;
  /** The refusals since the last call, worded for the answer; empties the list. */
  takeRefused(): string[];
  close(): Promise<void>;
}
export function startLaneProxy(owner: PortOwner, logger: Logger): Promise<LaneProxy>;

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
//                          mark(): Promise<void>                  // reads the daemon's children running the
//                                                                 // executable just before a launch, inside `one`
// browserRoot gains a last parameter: skip: ReadonlySet<number> = new Set()   // the marked and the held roots
// A root stays held until its ledger's watch has stopped it (`pending()` false), not merely until `end` is called.

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
  /** The pinned build, shared with pictures: one fetch, and whether it is fetching now. */
  readonly build: { ready(): Promise<string>; fetching(): boolean };
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
// apps/daemon/src/runner/runner.ts (card 3): RunnerOptions gains
  /** Ends a lane session's browser as the session ends; absent, the daemon has no lane browser. */
  readonly endLaneBrowser?: (sessionId: SessionId) => Promise<void>;

// apps/daemon/src/lane-browser/playwright-driver.ts (card 4)
export const launchPlaywrightDriver: LaunchLaneDriver;

// apps/daemon/src/mcp/browser-tools.ts (card 5)
/** The five tools as the lane endpoint registers them; empty when the session has no lane sandbox. */
export function browserTools(deps: {
  readonly state: StateStore;
  readonly dataDir: string;
  readonly laneBrowser: NonNullable<McpDeps['laneBrowser']>;
  readonly pictures: Pick<Pictures, 'bytesOf'> | undefined;
  readonly sessionId: SessionId;
  readonly signal: AbortSignal | undefined;
}): { readonly name: BrowserToolName; readonly description: string; readonly schema: z.ZodType;
      run(input: unknown): Promise<BrowserAnswer | ToolImages | string> }[];
/** Picture bytes this session's conversation already carries as image blocks: the task's `check_design` shots, and
 * the lane screens sent to this session or to an earlier one with the same provider session id (a resume). */
export function lanePicturesSpent(
  db: DbReader, bytesOf: (sha256: string) => number, taskId: TaskId, sessionId: SessionId,
): number;
// apps/daemon/src/mcp/browser-files.ts (card 5)
export const UPLOAD_MAX_BYTES = 50 * 1024 * 1024;   // all files of one call together
/** Opens each path itself (`O_NOFOLLOW`), checks the open file is the one a fresh `realpath` + `readAccess`
 * names (same dev and inode, a regular file) and reads it; refuses the whole call otherwise. */
export function readUploads(paths: readonly string[], session: LaneBrowserSession):
  { readonly files: readonly UploadFile[] } | { readonly refused: string };
/** Writes `<tempDir>/10db-screens/<screenId>.png` without following a link; null with why when it can't. */
export function writeScreenCopy(tempDir: string, screenId: TaskScreenId, png: Uint8Array):
  { readonly path: string } | { readonly path: null; readonly why: string };
/** The picture limits of the session's account; the strictest when it can't be read (moved from
 * `design-check-tool.ts`'s private `limitsOf`, which `check_design` then calls). */
export function sessionPictureLimits(db: DbReader, sessionId: SessionId): PictureLimits;
// McpDeps gains: readonly dataDir?: string   (the browser tools are offered only with it)
// pictures/index.ts exports writePicture, removeUnnamed, keepScreen, pngSize (card 5) and BROWSER_PIN (card 3), unchanged

// packages/contracts/src/skipped-actions.ts (card 6)
// SkipKind gains CantRunInLane: 'cant_run_in_lane'; approvalOf maps it to Approval.None.
// apps/daemon/src/trust/skip-recorder.ts (card 6): createSkipRecorder's deps gain
  /** Whether a shell call's program can run under the lane's profile; absent, every program can. */
  readonly runnable?: (command: string) => boolean;
// apps/daemon/src/trust/program-reach.ts (card 6)
/** False only when the command's program, found on the lane's PATH by its real path, is outside what the
 * lane may read (`readAccess` is neither `inside` nor `allowed`); true when it can't be told. */
export function programRunnable(command: string, path: string, ctx: FileAccessContext): boolean;
// apps/daemon/src/briefing/prompts.ts (card 6): PromptInput gains
  /** The session has 10db's lane browser (every lane step, read-only ones included). */
  readonly browser?: boolean;
```

## State table (design, not a test list)

| State | Event | Next |
| --- | --- | --- |
| no browser for the session | first tool call | the pinned build is ensured (shared with pictures), a proxy starts, Chromium launches at it and its ledger finds it under the launch lock; the call runs (card 3) |
| no browser | the launch fails, or the build is still fetching or refused | the call answers why at once ("10db is fetching its browser; try again in a minute"), never waiting on a download; the session goes on (card 3) |
| a browser whose Chromium crashed (driver disconnected) | the next call | on the entry's queue: the dead browser's ledger and proxy are closed, a fresh one launches, and the answer notes "the browser had stopped, so its cookies were cleared" (card 3) |
| a launch under way | `end(sessionId)` | `end` runs on the entry's queue, after the launch: the browser it made is closed, never left without an owner (card 3) |
| session ended | a later call naming it | refused "the session ended", by its id, with no launch (card 3) |
| a call in flight | a second call of the same session | it waits for the first, within its own 60 s (card 3) |
| any call | 60 s pass | the call answers "timed out"; a page that won't close closes the browser (`BrowserStuckError`), and the next call launches fresh (cards 3, 4) |
| browser idle five minutes | the idle timer | on the entry's queue: browser, proxy and ledger closed; the next call launches fresh and notes "cookies were cleared" (card 3) |
| any | `close()` at shutdown | every entry's shut runs on its queue; later calls are refused (card 3) |
| browser running | session ends, is stopped or taken over | the runner ends it beside `endProcesses`; a call in flight answers "the session ended" (card 3) |
| browser running | daemon restart or crash | its ledger is swept at the next start; nothing was saved; the next session's first call launches fresh, and every first launch of a session notes "a fresh browser: no cookies from earlier sessions" (card 3) |
| two sessions launching, or pictures' browser running | a launch | inside one lock: the daemon's matching children are marked, Chromium launches, and the root taken is one not marked and not held; a root stays held until its watch has stopped it (card 3) |
| any | `browser_open` of `file:`, `data:`, `javascript:` or a non-loopback host, `0.0.0.0`, `127.0.0.2`, `[::ffff:127.0.0.1]`, `*.localhost` | refused before `goto`, saying why (cards 2, 4) |
| a page | navigates itself to a scheme other than http(s) | the navigation is aborted, reported in `refused`; its own `data:` and `blob:` subresources load (card 4) |
| a connection to port P | P is the daemon's, or any lane proxy's | refused before any reading (card 2) |
| a connection to P | loopback on, and every listener on P has a chain that reaches a member of the session's ledger | owned; the proxy connects to the address the listeners reported (`::1` when all are on `::1`, else `127.0.0.1`) (card 2) |
| a connection to P | one listener on P is the session's and another is not (one on `127.0.0.1`, one on `*`) | refused "P is shared with a server that isn't this lane's" (card 2) |
| a connection to P | the listener belongs to another session, the builder, or a browser pid | refused "not this lane's server" (card 2) |
| a connection to P | Docker on; every publication of P is by a container whose compose working dir is in the session's copy or temp dir (not inside a registered checkout), bound to `127.0.0.1` | owned, reached on `127.0.0.1` (card 2) |
| a connection to P | the same, bound to `0.0.0.0` or `::` | owned only when no listener on P is bound to `127.0.0.1`; else refused "P is shared with a server that isn't this lane's" (card 2) |
| a connection to P | a publication bound to any other address | refused (card 2) |
| two tasks batched in one worktree | one's Compose stack | the other owns it too (one copy); accepted, since they are one batch's work (card 2) |
| a connection to P | the compose dir is inside a registered checkout (the builder's stack on 8800), elsewhere, or no label (`docker run -p`) | refused; a plain `docker run` refusal says to start it with Compose from the copy (card 2) |
| a connection to P | `docker ps` fails or passes 5 s, or `lsof` fails | refused, saying which reading failed (card 2) |
| P owned within the last 5 s | another connection | the cached verdict; after 5 s it is read again, so a port the lane's server gave up and another took is refused (card 2) |
| a session past 20 fresh checks this minute | a new port | refused "too many ports"; cached verdicts still answer (card 2) |
| Docker off, loopback off | any port | refused: nothing can own one (card 2) |
| a page | `alert`, `beforeunload` | accepted, reported in `dialogs` (card 4) |
| a page | `confirm`, `prompt` | dismissed, unless the `browser_act` that raised it named `dialog: "accept"`; reported (card 4) |
| four pages open | a popup or new tab | the oldest closes, a note says so; the new page is current (card 4) |
| any | `browser_upload` of a secret, or a path outside the copy, the temp dir and the setup reads | refused, naming the path; nothing uploaded (card 5) |
| any | `browser_upload` of a link, or a file swapped after the check | refused: opened without following a link, its dev and inode checked against a fresh real path (card 5) |
| any | `browser_upload` past 50 MB in one call | refused, naming the size (card 5) |
| the temp dir's `10db-screens` is a link, or not a directory | `browser_screenshot` | the screen and evidence are kept; no copy is written, and the answer's `path` is null with why (card 5) |
| any | a download | refused (`acceptDownloads: false`) (card 4) |
| any | `browser_screenshot` | the PNG's file, then one write with the `lane` screen (URL without its query, title, note, the session it went to) and its browser evidence; a copy in the temp dir; the image sent when it fits the account's limits and this session's budget, else its path only (card 5) |
| a screenshot | its write fails | nothing of it is kept: the file is removed when no row names it, and the answer says the screenshot was not kept (card 5) |
| next session of the task (review, QA) | first call | a fresh browser; the stack the implement step left is the new session's only by the rule as read now (its compose dir is the shared copy) (cards 2, 3) |
| Your-folder task | a stack the builder runs from the checkout | refused: the copy is a registered checkout, which owns nothing (card 2) |
| a skipped shell call | its program's real path is outside the lane's reads | recorded `cant_run_in_lane`, no Run these now; the card says "use 10db's browser, or run it yourself" (card 6) |
| a lane screen's task done or cancelled 14 days | the prune round | the screen is pruned as turn pictures are; the evidence row stays (card 5) |

## Tracks

One track, sequential: each card starts once the one before is merged into `feat/lane-browser`. Cards 6 and 7 may
run side by side once card 5 is merged.

- [Card 1](2026-11-24-10db-lane-browser/task-1.md): contracts, schema and stores: the tool names and inputs, the
  `lane` screen kind with URL, title and note, browser evidence, one dev migration. Core (shared shapes).
- [Card 2](2026-11-24-10db-lane-browser/task-2.md): reach: the URL and proxy target rules, the ownership rule
  and its readers (`lsof`, the process table, `docker ps`), the 5 s cache and rate, the per-session proxy. Core.
- [Card 3](2026-11-24-10db-lane-browser/task-3.md): the session's browser: one launch lock for every browser,
  the ledger's members, `LiveSession.browser`, `createLaneBrowsers` (launch, queue, deadline, idle close, end with
  the session), the daemon's wiring. Core.
- [Card 4](2026-11-24-10db-lane-browser/task-4.md): the Playwright driver: one context per browser, pages,
  dialogs, the `ai` snapshot, actions, uploads, screenshots, the scheme guard; the live browser test. Core.
- [Card 5](2026-11-24-10db-lane-browser/task-5.md): the five tools: registration, the upload check by open file,
  the screenshot's screen, evidence, temp copy and picture budget, pruning; the wiring test through the real
  pipeline; then a smoke against the real daemon. Core. *Review group 1: cards 1-5, once card 5's smoke has run.*
- [Card 6](2026-11-24-10db-lane-browser/task-6.md): the lane prompt, the not-runnable skip, and Codex image
  parity (live check, fake Responses server). Core.
- [Card 7](2026-11-24-10db-lane-browser/task-7.md): the drawer's lane group, the reporter brief, the e2e
  extension, the decision file and the module notes. Feature. Touches the peer's `task-pictures.tsx`: the
  coordinator clears it first. *Review group 2: cards 6-7, after a click-through against the real daemon.*

**Shared files:** `apps/daemon/src/daemon/start.ts` (cards 3, 5), `apps/daemon/src/mcp/server.ts` and
`mcp/tools.ts` (cards 3, 5), `apps/daemon/src/runner/runner.ts` (cards 3, 6), `pictures/browser-ledger.ts` and
`browser-host.ts` (card 3 only). The coordinator merges them.
**Run before review.** Review group 1 starts only after card 5's `make dev` smoke (a real lane serves its own
`python3 -m http.server`, opens it, takes a screenshot and is refused a port it doesn't own). Group 2 starts after
card 7's click-through.
**After the build:** install, then AMP-56's fresh import through a Codex lane is the acceptance run.
