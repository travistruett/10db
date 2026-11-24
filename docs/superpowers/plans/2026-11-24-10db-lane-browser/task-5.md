# Card 5: the five tools, the screenshot's records and the wiring test

**Size:** Core (what a lane may upload, what reaches its model, what is kept and pruned). Last card of review
group 1 (cards 1-5): the coordinator dispatches `code-reviewer` on the integration branch once it merges.
**Spec:** "The tools", "Evidence", "Judging, prompt and recovery" (first bullet), "Tests" (the wiring test).
**Track:** after card 4.

## Files

- **The tools.** `apps/daemon/src/mcp/browser-tools.ts` (new): `browserTools(deps)` answers the five
  registrations, with names, descriptions and schemas from `@10db/contracts`. Each `run` parses its input with
  the tool's schema, looks the session up (`laneBrowser.sessionOf(sessionId)`), and runs in
  `laneBrowser.browsers.use(session, signal, …)`.
  - **No session** (no lane sandbox): the tools are not registered at all (`browserTools` answers `[]`).
  - **Answers:**
    - The four page tools answer `BrowserAnswer` objects, which the endpoint sends as JSON text.
    - `refused` is the driver's list followed by `proxy.takeRefused()`.
    - `notes` gets what `use` passed.
    - A `LaneBrowserError` or `DeadlineError` answers its message as a plain string. The endpoint sends that as
      text, not `isError`: a refusal is an answer, and the lane goes on.
  - **`browser_upload`:** for each path, `readAccess(path, session.fileAccess, false, session.copy)`. A path
    passes when its access is `inside` or `allowed` and its real path is at or under the copy, the temp dir, or
    one of `fileAccess.setupReads`. Every other answer refuses the whole call, naming the path and why, and
    uploads nothing:
    - `protected` or `contains-protected` (a secret, 10db's own files);
    - `outside-copy`;
    - `ask`;
    - `allowed` elsewhere (a toolchain, a doc root).
    No judge model runs.
  - **`browser_screenshot`**, in order:
    1. `driver.screenshot(fullPage === true)`.
    2. `keepScreen(state, dataDir, …)` with:
       - `kind: ScreenKind.Lane`, `turnId: null`, `keptSha: null`, `theme: ScreenTheme.Default`;
       - `viewport` the driver's, clamped into `ScreenViewport`'s bounds;
       - `route` the URL's path and query when it passes `PageRoute`, else its path cut to 512 characters,
         else `/`;
       - `lane: { url, title, note: note ?? null }`.
    3. One write: `insertEvidence` with `kind: Browser`, `command: null`, `exitCode: null`, `logPath: null`,
       `commitShas: []`, `screenId`, and `summary` set to `Screenshot of <url> (<title>)` plus `: <note>` when
       there is one.
    4. A copy at `<tempDir>/10db-screens/<screenId>.png`, mode 0600 (directory 0700), which the lane reads with
       `Read` or `view_image`.
    5. **The model's budget.** The limits are the session's account's (`pictureLimitsFor`, as
       `design-check-tool.ts`'s `limitsOf` reads them; move `limitsOf` into a shared exported
       `sessionPictureLimits(db, sessionId)` in `mcp/`, and have both tools call it). The image goes as a block
       only when all three hold:
       - its longest side (`pngSize`) is at most `limits.imageMaxSide`;
       - `imagesWithinBudget([bytes], lanePicturesSpent(db, bytesOf, taskId), limits)` keeps it;
       - the limits take pictures at all.
    6. The answer is `ToolImages`. Its text is JSON:
       `{ screenId, path, url, title, sent: boolean, why: string | null }`. `why` gives the reason when not sent:
       too big a side, the budget used up, or "this account's model takes no pictures; open the path".
  - **`lanePicturesSpent`** is the bytes of the task's lane screens, plus the bytes `check_design` counts for the
    task (move its loop over `listTaskDesignChecks` into this function). `check_design` then counts lane screens
    too, so the two tools share one budget.
  - `bytesOf` is `deps.pictures?.bytesOf` when given. Otherwise read the size from the screen's row: lane screens
    have `size`.
- **Registration.** `apps/daemon/src/mcp/server.ts` `laneTools`:
  - when `deps.laneBrowser` is given and `sessionOf(sessionId)` answers, push each of `browserTools(…)`, as
    `check_design` is pushed;
  - `signal: deps.sessionSignal(sessionId)`; `dataDir` comes from a new `McpDeps.dataDir?` (set in
    `start.ts`), and the tools are not offered without it.
  - The endpoint's `ToolImages` branch already turns images into blocks: no change there.
- **Pruning.** Lane screens are pruned as turn pictures are, 14 days after their task is done or cancelled.
  - `apps/daemon/src/pictures/prune.ts`: the pure rule takes `ScreenKind.Lane` beside `ScreenKind.Turn`.
  - `packages/db/src/store/task-screens.ts` `listFinishedTurnScreens`: reads both kinds, with its comment saying
    so.
  - The evidence row stays and names a pruned screen. The drawer already hides pruned rows.
- **Module notes.** `apps/daemon/src/lane-browser/AGENTS.md` and `apps/daemon/src/mcp/AGENTS.md`: one line each on
  the tools, the upload rule, the screenshot's records and the shared picture budget.

## Interfaces it implements

From the index, word for word:

```ts
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
/** Picture bytes the task's lane already sent as image blocks: its `check_design` shots and lane screens. */
export function lanePicturesSpent(db: DbReader, bytesOf: (sha256: string) => number, taskId: TaskId): number;
```

## Interfaces it calls

From the index, word for word:

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

// apps/daemon/src/mcp/tools.ts (card 3): McpDeps gains
  /** Each lane session's browser; absent, a lane is not offered the browser tools. */
  readonly laneBrowser?: {
    readonly browsers: LaneBrowsers;
    sessionOf(sessionId: SessionId): LaneBrowserSession | undefined;
  };

// apps/daemon/src/lane-browser/lane-browsers.ts (card 3)
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

// apps/daemon/src/lane-browser/lane-proxy.ts (card 2)
export interface LaneProxy {
  readonly port: number;
  /** The refusals since the last call, worded for the answer; empties the list. */
  takeRefused(): string[];
  close(): Promise<void>;
}

// apps/daemon/src/sandbox/file-access.ts
export type ReadAccess =
  'inside' | 'allowed' | 'protected' | 'contains-protected' | 'outside-copy' | 'ask';
export function readAccess(
  spelled: string,
  ctx: FileAccessContext,
  tree = false,
  cwd?: string,
): { access: ReadAccess; realPath: string }

// apps/daemon/src/pictures/picture-files.ts
export type ScreenToKeep = Omit<NewTaskScreen, 'sha256' | 'size' | 'width' | 'height' | 'storedPath'> & {
  readonly png: Uint8Array;
};
export function keepScreen(state: StateStore, dataDir: string, screen: ScreenToKeep): TaskScreenDto | null
export function pngSize(bytes: Uint8Array): { width: number; height: number } | null

// apps/daemon/src/conversation/picture-budget.ts, picture-limits.ts
export function imagesWithinBudget(sizes: readonly number[], spent: number, limits: PictureLimits): number[]
export function pictureLimitsFor(
  kind: AccountKind, on?: { readonly accountId: AccountId; readonly launchId: string },
): PictureLimits                                  // PictureLimits.imageMaxSide: 3000 on every platform

// packages/db/src/store/task-screens.ts (card 1)
// NewTaskScreen gains, optional, so every caller outside a lane screen is unchanged:
  readonly lane?: { readonly url: string; readonly title: string; readonly note: string | null };
// packages/db/src/store/evidence.ts (card 1): NewEvidence gains
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Browser;
      readonly command: null;
      readonly exitCode: null;
      readonly screenId: TaskScreenId;
    })
```

`keepScreen` and `pngSize` are in `pictures/picture-files.ts`, which `pictures/index.ts` does not export. Export
both from `pictures/index.ts` (the module's entry point), unchanged; don't import the file directly.

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| any | `browser_upload` of a secret, or a path outside the copy, the temp dir and the setup reads | refused, naming the path; nothing uploaded (card 5) |
| any | `browser_screenshot` | PNG kept as a `lane` screen with URL, title and note; browser evidence written; a copy in the temp dir; the image sent when it fits the account's limits and budget, else its path only (card 5) |
| a lane screen's task done or cancelled 14 days | the prune round | the screen is pruned as turn pictures are; the evidence row stays (card 5) |

## Tests

- **The wiring test** (spec "Tests", core: sandbox reach): one test on the real pipeline, in a new
  `apps/daemon/test/lane-browser.test.ts`. No existing test drives a lane's MCP tools against a browser.
  - `createTestEngine` with a fake script whose lane calls `browser_open` twice.
  - The daemon gets `laneBrowser: { kind: 'given', launch, readers }`:
    - `launch` is a small `LaneDriver` whose `open` sends one real `http.request` to `127.0.0.1:<proxy port>` in
      absolute form (the port from the launch options' `--proxy-server` arg) and answers the status;
    - `readers` reports a listener on server A's port whose pid is the fake session's member, and one on server
      B's port whose pid is not.
  - A lane sandbox whose process table lists that member under the session, so `members()` holds it. Use the
    process `LaneProcessSetup` seam the lane sandbox already takes. The table is a boundary (a child process 10db
    doesn't own); the watch, the ledger rule, the proxy and the tool are real.
  - Assert on the lane's MCP results:
    - A's open answers A's 200, and A saw one request;
    - B's open answers a refusal naming B's port, and B saw none.
- Pruning gets no test: `prunableTurnScreens` has none today, and one more kind in its filter earns none.
- The upload rule and the budget get no test of their own. They are `readAccess` and `imagesWithinBudget`, which
  have theirs. Say so in the value card's `no_claim`.

## Done when

- The checks in Global Constraints pass.
- The wiring test is green and was seen red: break the ownership check in the proxy and B is reached.
- The coordinator can start review group 1.
