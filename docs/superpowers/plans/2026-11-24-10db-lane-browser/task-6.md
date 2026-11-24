# Card 6: the lane prompt, the not-runnable skip, and Codex image parity

**Size:** Core (trust: what recovery offers; provider parity). Reviewed in group 2 (cards 6-7).
**Spec:** "Judging, prompt and recovery", "Provider parity".
**Track:** after card 5. May run beside card 7.

## Files

- **The prompt.** `apps/daemon/src/briefing/prompts.ts`:
  - `PromptInput.browser` and a `BROWSER_RULE` beside `PICTURES_RULE`, added to every step's rules when
    `browser === true`, read-only steps included (review and QA use the browser).
  - The paragraph, in a model's words:
    - The five tools reach only servers this lane started: a process of its own, or a Docker Compose stack
      started from its copy or temp dir, on `localhost`, `127.0.0.1` or `[::1]`.
    - Start the app first, sign in through its own pages as a test user you created, and say what you saw.
    - A screenshot is kept on the task as evidence; its PNG's path is in every answer.
    - A stack later steps should reuse is started from the copy: an archive goes in an ignored folder under it,
      not the temp dir.
    - This is the only browser a lane has: the builder's browser tools and skills (Aside, Chrome) don't run in a
      lane, so don't try them.
  - Codex (`input.provider === Provider.Codex`) gets one more sentence when the live check below shows Codex
    drops MCP images: "If a screenshot's image doesn't show, open its path with view_image."
  - `apps/daemon/src/runner/runner.ts` sets `browser: true` when the session has a lane sandbox and
    `RunnerOptions.endLaneBrowser` is given. Card 3's wiring gives it exactly when the daemon has lane browsers,
    so the two never differ.
- **The not-runnable skip.**
  - `packages/contracts/src/skipped-actions.ts`: `SkipKind.CantRunInLane: 'cant_run_in_lane'`. `approvalOf` maps
    it to `Approval.None`.
  - Every exhaustive switch the typecheck then names gets a case:
    - `delivery/skipped-card.ts` words it "can't run in a lane: its program is outside what lanes may read. Use
      10db's browser, or run it yourself";
    - `inbox/permission-broker.ts`;
    - any other.
  - `apps/daemon/src/trust/program-reach.ts` (new): `programRunnable(command, path, ctx)`.
    - Take the first word of the command after leading `NAME=value` assignments. Only plain words count: a
      command it can't read that way (a subshell, a pipe's later stage, a quoted program) answers true.
    - Find it: an absolute or relative path as written (relative to the checkout), else each `path` entry in
      order.
    - Take its real path, then `readAccess(real, ctx)`. False only when the program file exists and its access
      is neither `inside` nor `allowed`. A program not found answers true: the shell would say so itself.
  - `apps/daemon/src/trust/skip-recorder.ts`: `createSkipRecorder` takes `runnable`. In `record`, a skip of a
    shell call (`toolName` `Bash`, or Codex's command tool name as `trust/call-summary.ts` keys it) whose summary
    isn't cut and for which `runnable(summary)` is false is recorded as `CantRunInLane`, with that reason in place
    of the original.
  - `apps/daemon/src/runner/runner.ts`, where it calls `createSkipRecorder`: with a lane session, pass
    `runnable: (command) => programRunnable(command, <the lane's PATH>, laneSession.fileAccess)`. The lane's PATH
    is `laneSession.spec.shellEnv.PATH` (Codex), else `laneSession.commandEnv.PATH`, else the session env's.
- **Codex image parity.**
  - `apps/daemon/test/fake-responses.ts`: `FakeRequest` gains `outputImages`, the `input_image` parts inside tool
    call outputs (`function_call_output` and `custom_tool_call_output` items whose `output` is a content list).
    `images` keeps counting user messages only.
  - `apps/daemon/test/codex.live.test.ts`, one case (`TENDB_LIVE_CODEX=1`, on the Mac, not CI):
    - a Codex lane with `laneBrowser: { kind: 'given' }`, whose driver answers a fixed 1×1 PNG from
      `screenshot`;
    - it calls `browser_screenshot` from code mode (`tools.mcp__10db__browser_screenshot({})`);
    - it records whether the next model request's `outputImages` is 1 or 0 with `report(...)`, as the file's
      other rows do;
    - it asserts that the answer's text names the PNG's path either way.
  - The "offers the model only the tools a lane uses" case filters tool names containing `browser`. If 10db's
    `mcp__10db__browser_*` trips it, narrow that filter to Codex's own `browser` tool by its exact name. Don't drop
    the check.
  - **The outcome decides the prompt.**
    - Images arrive: no Codex sentence.
    - Images are dropped, or the live case can't run tonight (no pinned Codex on the Mac, say): add the Codex
      sentence, and say in your report that the coordinator should file the follow-up task "Codex lanes see MCP
      images".
- **Module notes.** `apps/daemon/src/trust/AGENTS.md` (or the nearest one that lists skip kinds): the new kind and
  its rule. `apps/daemon/src/sessions/AGENTS.md`: one sentence on what the live check found about MCP images in
  Codex.

## Interfaces it implements

From the index, word for word:

```ts
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

## Interfaces it calls

From the index, word for word:

```ts
// packages/contracts/src/skipped-actions.ts
export function approvalOf(kind: SkipKind, summaryCut: boolean): Approval

// apps/daemon/src/trust/skip-recorder.ts
export function createSkipRecorder(
  deps: { readonly state: StateStore; readonly log: Logger },
  run: { readonly workstreamId: WorkstreamId; readonly sessionId: SessionId | null },
): SkipRecorder

// apps/daemon/src/sandbox/file-access.ts
export type ReadAccess =
  'inside' | 'allowed' | 'protected' | 'contains-protected' | 'outside-copy' | 'ask';
export function readAccess(
  spelled: string,
  ctx: FileAccessContext,
  tree = false,
  cwd?: string,
): { access: ReadAccess; realPath: string }

// apps/daemon/src/sandbox/lane-sandbox.ts (LaneSession, the fields the browser reads)
  readonly spec: LaneSandboxSpec;          // spec.checkout: the checkout's real path
  readonly fileAccess: FileAccessContext;
  readonly tmpDir: string;
  readonly commandEnv: Readonly<Record<string, string>>;
  endProcesses(): Promise<void>;

// apps/daemon/src/briefing/prompts.ts (PromptInput)
  readonly pictures?: boolean;

// apps/daemon/src/daemon/start.ts (card 3): DaemonOptions gains
  readonly laneBrowser?:
    | { readonly kind: 'pinned' }
    | { readonly kind: 'given'; readonly launch: LaunchLaneDriver; readonly readers: PortReaders };
```

## State-table rows

| State | Event | Next |
| --- | --- | --- |
| a skipped shell call | its program's real path is outside the lane's reads | recorded `cant_run_in_lane`, no Run these now; the card says "use 10db's browser, or run it yourself" (card 6) |

## Tests

- `approvalOf` gets no test: its switch is exhaustive, so the typecheck holds the new row.
- **One test** of `programRunnable` on real files in a temp dir (core: trust; the AMP-56 skip that offered Run
  these now for the Aside CLI is the escaped bug). It needs:
  - a program file inside the lane's reads, which answers true;
  - one under a directory outside them (a stand-in for `~/.aside`), which answers false;
  - a compound command, which answers true.
  Build the `FileAccessContext` the way `sandbox/file-access.test.ts` does. The value card names the escaped bug.
- **The live Codex case** above. It runs on the Mac only. Report its result.
- No prompt test: the copy is not core.

## Done when

- The checks in Global Constraints pass.
- Your report states what the live Codex case found (or that it could not run, and why), and whether the Codex
  sentence is in.
