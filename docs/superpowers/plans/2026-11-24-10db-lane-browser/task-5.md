# Card 5: the five tools, the screenshot's records and the wiring test

**Size:** Core (what a lane may upload, what reaches its model, what is kept and pruned). Last card of review
group 1 (cards 1-5): the coordinator dispatches `code-reviewer` on the integration branch once it merges and its
smoke has run.
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
  - **`browser_upload`:** `readUploads(paths, session)` (`apps/daemon/src/mcp/browser-files.ts`, new), then
    `driver.upload(ref, files)`. The driver gets bytes, never a path, so nothing a lane swaps in after the check is
    ever opened. For each path, in order:
    1. `openSync(path, O_RDONLY | O_NOFOLLOW)`. A link as the last part fails here (ELOOP) and is refused.
    2. `fstat` the descriptor: a regular file, with its size counted against `UPLOAD_MAX_BYTES` for the whole
       call.
    3. A fresh `readAccess(path, session.fileAccess, false, session.copy)`. It passes when its access is
       `inside` or `allowed` and its real path is at or under the copy, the temp dir, or one of
       `fileAccess.setupReads`. Refused otherwise:
       - `protected` or `contains-protected` (a secret, 10db's own files);
       - `outside-copy`;
       - `ask`;
       - `allowed` elsewhere (a toolchain, a doc root).
    4. `statSync(realPath)` has the descriptor's `dev` and `ino`. A mismatch means a part of the path was swapped
       between the open and the check, and is refused.
    5. Read the bytes from the descriptor, and close it in a `finally`.
    Any refusal refuses the whole call, names the path and why, and uploads nothing. `name` is the path's
    basename, and `mimeType` comes from its extension (`application/octet-stream` otherwise). No judge model
    runs.
  - **`browser_screenshot`**, in order:
    1. `driver.screenshot(fullPage === true)`.
    2. **Cut and clean before anything is kept.** `url` is the page's origin and path only: the query and fragment
       are dropped, then it is cut to 2,048 characters. `title` is cut to 512. `route` is that path when it passes
       `PageRoute` (cut to 512), else `/`. The reporter brief and the drawer read these, so no query reaches
       Linear.
    3. **The model's budget**, decided before the write. The limits are the session's account's
       (`pictureLimitsFor`, as `design-check-tool.ts`'s `limitsOf` reads them; move `limitsOf` into a shared
       exported `sessionPictureLimits(db, sessionId)` in `mcp/`, and have both tools call it). The image goes as
       a block only when all three hold:
       - its longest side (`pngSize`) is at most `limits.imageMaxSide`;
       - `imagesWithinBudget([bytes], lanePicturesSpent(db, bytesOf, taskId, sessionId), limits)` keeps it;
       - the limits take pictures at all.
    4. **One write for the records.** As `keepScreen` does it, but with the evidence in the same write:
       - `writePicture` first;
       - then one `state.write` with `insertTaskScreen` (`kind: ScreenKind.Lane`, `turnId: null`,
         `keptSha: null`, `theme: ScreenTheme.Default`, `viewport` the driver's clamped into `ScreenViewport`'s
         bounds, and `lane: { url, title, note: note ?? null, sentSessionId: sent ? sessionId : null }`);
       - and `insertEvidence` (`kind: Browser`, `command: null`, `exitCode: null`, `logPath: null`,
         `commitShas: []`, the new `screenId`, `summary` `Screenshot of <url> (<title>)` plus `: <note>`).
       A failed write keeps neither row: `removeUnnamed` removes the file, and the call answers "the screenshot
       was not kept: <why>", with no image. Export `writePicture` and `removeUnnamed` from `pictures/index.ts`
       beside `keepScreen` and `pngSize`.
    5. **The copy**, `writeScreenCopy(tempDir, screenId, png)`, after the write:
       - `mkdirSync(<tempDir>/10db-screens, 0o700)` without `recursive`, with EEXIST tolerated;
       - then `lstatSync`: a real directory (not a link), owned by the daemon's user, whose `realpath` is directly
         under the temp dir's real path;
       - then the file opened `O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW`, mode 0600, and written.
       Any failure leaves the records as they are and answers `path: null` with why. The lane can still read the
       image when one was sent.
    6. The answer is `ToolImages`. Its text is JSON:
       `{ screenId, path, url, title, sent: boolean, why: string | null }`. `why` gives the reason when not sent:
       too big a side, the budget used up, or "this account's model takes no pictures; open the path".
  - **`lanePicturesSpent`** is the task's `check_design` bytes (move its loop over `listTaskDesignChecks` into
    this function), plus `laneScreenBytesSentTo(db, sessions)`. `sessions` is this session and every earlier
    session row with the same non-null `providerSessionId`, since a resumed conversation carries their images.
    `check_design` then counts lane screens too, so the two tools share one budget.
  - `bytesOf` is `deps.pictures?.bytesOf` when given; lane screens' own bytes come from their rows' `size`.
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

// apps/daemon/src/lane-browser/driver.ts (card 3)
export interface UploadFile { readonly name: string; readonly mimeType: string; readonly buffer: Uint8Array }

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
```

`writePicture`, `removeUnnamed`, `keepScreen` and `pngSize` are in `pictures/picture-files.ts`, which
`pictures/index.ts` does not export. Export them from `pictures/index.ts` (the module's entry point), unchanged;
don't import the file directly. `writePicture(dataDir, png): { sha256; storedPath }` and
`removeUnnamed(db, dataDir, sha256, notNewerThan?): boolean` are as in that file.

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| any | `browser_upload` of a secret, or a path outside the copy, the temp dir and the setup reads | refused, naming the path; nothing uploaded (card 5) |
| any | `browser_upload` of a link, or a file swapped after the check | refused: opened without following a link, its dev and inode checked against a fresh real path (card 5) |
| any | `browser_upload` past 50 MB in one call | refused, naming the size (card 5) |
| the temp dir's `10db-screens` is a link, or not a directory | `browser_screenshot` | the screen and evidence are kept; no copy is written, and the answer's `path` is null with why (card 5) |
| any | `browser_screenshot` | the PNG's file, then one write with the `lane` screen (URL without its query, title, note, the session it went to) and its browser evidence; a copy in the temp dir; the image sent when it fits the account's limits and this session's budget, else its path only (card 5) |
| a screenshot | its write fails | nothing of it is kept: the file is removed when no row names it, and the answer says the screenshot was not kept (card 5) |
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
- **The file rules** (core: sandbox), in a new `apps/daemon/src/mcp/browser-files.test.ts` on a real temp dir.
  - `readUploads`:
    - a file in the copy is read;
    - a link in the copy to a file outside is refused;
    - a path through a linked directory that leads outside is refused;
    - a secret in the copy (`.env`, in `secretFiles`) is refused;
    - a call past 50 MB is refused.
    - The swap race itself: call the dev/inode check with a descriptor of one file and a real path of another,
      which is refused. Expose no test-only seam: write the check as its own small exported function the
      reader uses, and test that.
  - `writeScreenCopy`: `10db-screens` made in advance as a link to a folder outside writes nothing there and
    answers `path: null`; a planted file of the same name is never overwritten.
- The budget gets no test of its own: it is `imagesWithinBudget` and a sum. Say so in the value card's `no_claim`.

## Done when

- The checks in Global Constraints pass.
- The wiring test is green and was seen red: break the ownership check in the proxy and B is reached.
- **A smoke against the real daemon** (run before review: review group 1 waits for it). In the integration
  worktree, `make dev` (its data dir is `.dev/data`, never the installed app's), on a scratch project with
  loopback on. A lane on an account the dev data dir already has gets a task telling it to:
  - start `python3 -m http.server <port>` from its copy in the background;
  - `browser_open` it;
  - `browser_screenshot` it with a note;
  - `browser_open` the daemon's port and one other loopback server it didn't start (one you start by hand).
  Check, then report:
  - the first two answer;
  - the screenshot shows on the task (`GET /tasks/:taskId/screens`) with its evidence row;
  - the last two are refused with their reasons.
  If the dev data dir has no account a lane can run on, stop and report the smoke as blocked. Don't sign one in.
- The coordinator can start review group 1 once the smoke is reported.
