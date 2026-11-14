# Sessions M2c: streaming and typed tool calls: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Both adapters emit live text and reasoning deltas, finished messages, typed tool calls with diffs, agent
commands and plan updates. The runner's live line and the files a turn touched come from `tool_call` alone. The
new events are only logged: no UI reads them until M3 and M4b.

**Architecture:**

- `ToolCallView` is a zod union in `@10db/contracts`.
- Pure mappers turn Claude `tool_use`/`tool_result` and Codex thread items into `ToolCallView`s.
- `hunks.ts` turns every edit into hunks: with `structuredPatch` for text pairs, and `parsePatch` for Codex
  diffs.
- `before-text.ts` reads a file's previous content only when it is a regular file inside the checkout.
- `tool-target.ts` derives the live line's `ToolTarget` and summary from a `ToolCallView`.
- The runner records activity on the first sighting of each call id.
- The old `activity` tool events are retired last, once both mappings and the fake emit `tool_call`.

**Tech Stack:**

- TypeScript, zod 4.6.7, Vitest
- `diff` (jsdiff), added to `@10db/daemon`
- `@anthropic-ai/claude-agent-sdk` 0.3.316: `includePartialMessages`, `SDKPartialAssistantMessage`,
  `supportedCommands()`, `SDKCommandsChangedMessage`
- `codex app-server` 0.167.0: `item/started`, the deltas, `turn/plan/updated`, `thread/compact/start` and
  `review/start`

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3):

- §3 S9 and S12
- §5.1 (events), §5.2 (`ToolCallView` and hunks), §5.4 (streaming and commands), §5.5 (streaming and commands on
  Codex)
- §11 (Write cards' reads)
- §12 (M2c), §13 (pure, pipeline and live rows), §14 (the M2c record)

## Starting point: M1, M2a, M2b and the trust line's T3 have merged

- **T3** (`2026-11-12-10db-trust-t3-policy-and-auto-mode.md`): the limits, named in `trust/limits.ts` and exported
  from `@10db/contracts`, and auto mode on lanes and passes. Call 23 reads them. Find the names in T3's plan.

- **M2b** (`2026-11-12-10db-sessions-m2b-adapter-seam.md`):
  - `AgentAdapter.open(spec: AgentSessionSpec)`
  - `AgentCapabilities` and `capabilitiesOf`
  - `LaneSessionSpec` and `ExploreSessionSpec`
  - the fake's one-open-handle assertion
- **M2a** (`2026-11-12-10db-sessions-m2a-claude-core.md`):
  - **`claude-adapter.ts`** keeps the adapter surface. It is the only file that imports the Agent SDK at runtime.
  - **`claude-session.ts`** holds the session loop (`startClaudeSession`) and `startShapeSession`.
  - **`claude-query-options.ts`** holds `claudeQueryOptions(profile: ClaudeProfile, sandbox): ClaudeProfileOptions`
    and its pure table, `claude-query-options.test.ts`.
  - **`claude-session-hooks.ts`** holds `preToolUseHook` and `canUseToolBridge`.
  - **The tests.** `claude-adapter.test.ts` holds the lane tests and `fakeQuery`. `claude-shape.test.ts` holds the
    explore tests and its own `fakeQuery`. `claude-adapter.live.test.ts` is the live test.
  - **The fake.** `fake-script.ts` holds `FakeStep` and `TURN_STEPS`. `fake-session.ts` holds
    `createFakeSessionCore`, whose `emit` pushes an event, `runFakeLaneSession` and `runFakeExploreSession`.
    `fake-adapter.ts` holds the class.
  - **What M2a hands to M2c:** `includePartialMessages`, `supportedCommands()` and the fake's new events.
- **M1** (`2026-11-12-10db-sessions-m1-foundations.md`):
  - **`apps/daemon/src/sessions/codex-generated/`**, holding `ts/`, `schema/`, `fixtures/` and `STAMP`.
  - **`apps/daemon/scripts/codex-generate.ts`**, holding two tables:
    - `CODEX_SEED_TYPES`, the import-closure seeds. Its roots `ClientRequest`, `ServerRequest` and
      `ServerNotification` already reach every notification M2c reads.
    - `RUNTIME_SCHEMAS`, mapping each runtime export in `codex-protocol.ts` to a generated type. The generator copies
      that type's schema to `schema/<Type>.json` and samples it into `fixtures/<Type>.json`.
  - **`apps/daemon/src/sessions/codex-protocol.test.ts`**, holding the type test and the fixture test:
    - The type test has one line per row:
      `expectTypeOf<Wire<Generated>>().toExtend<z.input<typeof Runtime>>()`. That is everything Codex can send
      checked against the runtime schema's input. `Wire<T>` maps a ts-rs `bigint` to a JSON number.
    - The fixture test runs over `ROWS`: every sampled fixture passes `z.fromJSONSchema` of the generated schema,
      and the runtime schema.

## Global Constraints

- Root `AGENTS.md`, and the `AGENTS.md` of `apps/daemon` and `packages/contracts`. Also
  `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- Work in `../10db-worktrees/sessions-m2c` on branch `feat/sessions-m2c`, from `origin/main` after M2b merged.
  Run the tasks in order.
- Name every path in each commit, with single-quoted `-m`. Messages are Conventional Commits and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **The new events are only logged.** The runner and Plan log each new event at `debug`, with ids and sizes only,
  never the text. The one exception is `tool_call`: the runner turns it into the live line and the files touched,
  as `activity` did.
- **No UI change.** The UI keeps reading `session.activity`, whose shape doesn't change.
- **No disk writes.** The full output and patch on disk (§5.2) are the engine's (M4b), which owns the conversation
  and item ids that name the folder.
- zod parses every SDK and app-server payload at the boundary, with loose objects so added fields pass.
- Time comes from the injected `Clock` in the Claude session. Codex times come from the notification's own
  `startedAtMs` and `completedAtMs`.
- The guarded read in `before-text.ts` is the only file read this milestone adds. It runs in the daemon on a path
  the agent named, so it follows §11 with no window between check and read.
  - It takes the parent's `realpath` and requires it inside the checkout.
  - It opens `<realParent>/<basename>` with `O_NOFOLLOW`, and `fstat`s the descriptor: a regular file, at most 1 MB,
    the `lstat`'s inode, the checkout's device and one link.
  - It reads from that descriptor.
  - It requires the parent's `realpath` to be unchanged afterwards.
- Pin `diff` exactly at its latest stable version (`npm view diff version`). Its types ship with it.
- An agent in a 10db lane runs only the checks for what it changed. The last task runs `make gate` once.

## Calls made in this plan

Each is marked **(call)** where it is made.

1. **`ToolCallView` gains a common `harnessTool`.** It is the agent's own name for the tool: `Edit`, `Bash`,
   `apply_patch`, `command`, `10db.commit`. The live line has always named it, and `pass-lane.test.ts:366-379`
   asserts `tool: 'Edit'`. The spec's list has no field to carry it.
2. **Optional fields are `nullable`, not absent.** This covers `range`, `paths`, `matchCount`, `model`, `query`,
   `url`, `resultTail` and `error`, so every variant has a fixed JSON shape.
3. **The output tail is 4,096 characters** (`OUTPUT_TAIL_CHARS`), counted as JS string length. `outputBytes`
   counts UTF-8 bytes. Previews are 200 characters (`PREVIEW_CHARS`).
4. **`title` is the call's subject, not a sentence.** Each kind's title is in Task 4's table, at most 120
   characters. The kit (M3) adds the verb.
5. **Claude has no item id for text**, so a text or thinking block's `itemId` is `<message.id>:<block index>` from
   the stream. When a message arrived with no stream events, its text block's id is `<message.id>:a<n>`.
6. **Codex plan steps come from `turn/plan/updated`, not `item/plan/delta`.** In 0.167.0 `item/plan/delta` streams
   a proposed plan's text, and the generated type warns that its deltas may not concatenate. The step list with
   statuses is `turn/plan/updated` (`TurnPlanUpdatedNotification`). `item/plan/delta` is not read.
7. **A Codex `fileChange` with N changes becomes N `edit` calls**, with ids `<item.id>:<index>`. A `ToolCallView`
   edit names one path.
8. **A Codex command whose `commandActions` is exactly one `read` maps to a `read` call**, and one `search` maps to a
   `search` call. That lets the kit fold "Read 6 files" for Codex too. Any other command stays a `command`.
9. **Claude `TodoWrite` emits `plan_update` only**, not a `tool_call`.
10. **`NotebookEdit` maps to an `edit` call with no hunks.** Its path still counts as written.
11. **`exitCode` is null on Claude**, which reports none. `matchCount` is null on both, until a structured result
    is read.
12. **Status.**
    - A Codex command `completed` with a non-zero exit code is `failed`, and `declined` is `denied`.
    - A Claude call is `denied` when 10db's hook or `canUseTool` denied its `tool_use_id`.
    - An unknown Codex status string reads as `running` on `item/started` and `done` on `item/completed`.
13. **Reasoning summaries.** A new `summaryIndex` starts with `\n\n` inside the delta's text, so offsets stay one
    sequence per item.
14. **A `tool_call` from a Codex output delta carries `appended`**, the text that delta added. That way M4b's live
    frame can send only appended output (§6.5) without diffing tails.
15. **Edit hunks carry real line numbers when they can.** An `Edit` or `MultiEdit` hunk starts at the line where
    `old_string` is found in the guarded before-text. Without one, the hunks number from 1.
16. **Codex commands.**
    - `/compact` and `/review [instructions]` are sent as their RPCs, and wait for a running turn to end, because
      they never steer.
    - `/model` is the composer's (M5a) and goes to Codex as ordinary text.
    - A command's uuid is reported `consumed` once Codex answers the request, accepted or refused. A refusal is
      logged at `warn`, and is not retried.
17. **The `activity` event keeps only its `text` kind.** Its `tool` kind is replaced by `tool_call`, from which
    `toolCallActivity` derives the same data. The spec says `SessionEvent` keeps every variant. Keeping a second
    path for tool activity would let the two drift.
18. **The claim test is a new row in `pass-lane.test.ts`.** The file's `openPage` fixture is the cheapest way to get
    a pass turn. §13 lists the file as "unchanged" through M4c, and this row is added before that.
19. **`ToolCallView` is registered in `CONTRACT_SCHEMAS` now**, so the generated schema exists when M3 and M4 put it
    on an item DTO.
20. **The before-text read refuses a file with more than one hard link.** Without that check, a hard link inside
    the checkout to a file outside it would pass the inode comparison.
21. **`refusal` and `deniedBy`.**
    - Who denied a call travels on the decision itself. The deny branch of `ToolDecision` gains `by: DeniedBy`
      (Task 7).
    - The broker sets `builder` only on a card's Deny answer (`permission-broker.ts:423-426`), which is also how a
      question answered as a refusal comes back. Every other deny is `10db`: the guard, the billing gate, the
      broker's own refusals, and Plan's. Stored rules only ever allow.
    - On Codex both stay null until the guard socket's verdict is joined to the item. A follow-up task does that
      join, once the hook input is shown to name the call.
22. **jsdiff is bounded** by `maxEditLength: 10_000` and `timeout: 100` ms. Past either bound, the card shows the
    whole new text as added, `truncated`.
23. **`deniedBy` gains `judge`, and the view gains `limit` and `soft`** (spec §5.2, trust line §5). A call the
    session's judge denied is `judge`.
    - **Soft:** every classifier denial in an attended session (the orchestrator's ruling, by the builder's parity
      rule: T3 offers Allow this on each one, as Claude Code lets the user approve what auto mode blocked). A
      reason that names a limit maps to a `LimitName` by that name, through `sessions/judge-denial.ts`; one that
      names none has `limit: null`. Against a hard deny the go-ahead is denied again, and the notice says so.
    - **Hard:** a lane's denial (no one is in it to clear one) and one of Claude Code's own safety checks.
      `soft: false`. No Allow This.
    - The event that carries an auto-mode denial is the one T3's plan records. Task 7's row is written from it once
      T3 has merged; if T3 records none, `deniedBy` stays `10db` for these calls and a follow-up task joins them.
    - 10db's own judge (T5) sets all three later. Codex leaves them null, as in call 21.

## Review Focus

1. **A `Write` to a path that is a symlink to a file outside the checkout** (`~/.ssh/config`, `../other-repo/.env`),
   or one swapped for a link between check and read. The daemon never reads it, and the card shows the whole new
   content as added. Tests in Task 3, including the three swap rows.
2. **A command that prints megabytes.** Only a 4,096-character tail is kept, `outputBytes` counts every byte, and
   each delta event carries only its own text. Tests in Tasks 5 and 8.
3. **Text with characters outside ASCII, streamed in pieces** (`é`, emoji). Each `offset` is the item's JS length
   before the delta, and the deltas concatenate to the finished `message`. Tests in Tasks 7 and 8.
4. **A call first seen already finished.** A Codex `item/completed` with no `item/started` (after a resume), or a
   Claude result for an id never seen. The runner records activity once, and an unknown result id maps to
   nothing. Tests in Tasks 5 and 6.
5. **A Codex `fileChange` whose `diff` isn't a unified diff** (an `add` carrying the file's text). The card shows
   the text as added, and the parse never throws. Tests in Tasks 2 and 8.

---

### Task 1: The `ToolCallView` contract

**Files:**

- Create: `packages/contracts/src/tool-call-view.ts`, `packages/contracts/src/tool-call-view.test.ts`
- Modify: `packages/contracts/src/index.ts`, plus `packages/contracts/src/json-schema.ts` (`'tool-call-view'`,
  call 19)
- Create: `packages/contracts/generated/tool-call-view.schema.json` (generated)

**Interfaces:**

- Produces, in `@10db/contracts`:
  - **Constants:**
    - `ToolCallStatus = { Running: 'running', Done: 'done', Failed: 'failed', Denied: 'denied' } as const`
    - `ToolCallKind = { Command, Edit, Read, Search, Mcp, Subagent, Web, Other }` (values `'command'` … `'other'`)
    - `EditChange = { Add: 'add', Delete: 'delete', Update: 'update', Move: 'move' } as const`
    - `DeniedBy = { Builder: 'builder', TenDb: '10db', Judge: 'judge' } as const` (call 23)
    - `OUTPUT_TAIL_CHARS = 4_096` and `PREVIEW_CHARS = 200` (call 3)
  - **`ToolCallHunk`:** `z.object({ oldStart, oldLines, newStart, newLines })`, each `z.int().nonnegative()`, plus
    `before: z.string()` and `after: z.string()`.
  - **`ToolCallView`:** `z.discriminatedUnion('kind', …)`. Every variant has these common fields:
    - `id: z.string().min(1)`
    - `harnessTool: z.string().min(1)` (call 1)
    - `status: z.enum(ToolCallStatus)`
    - `title: z.string()`
    - `startedAt: z.iso.datetime()`
    - `durationMs: z.int().nonnegative().nullable()`
    - `parentId: z.string().min(1).nullable()`
    - `refusal: z.string().nullable()`: 10db's reason, when the guard or the broker denied the call
    - `deniedBy: z.enum(DeniedBy).nullable()`: `builder` only when the builder answered Deny on a card, `judge`
      when the session's judge stopped it at a limit, `10db` for every other denial (the guard's coordination rules
      and the `rules` floor). It is set only when `status` is `denied`, and null when the agent gives no way to
      tell (calls 21, 23).
    - `limit`: T3's limit name, nullable; set only with `deniedBy: 'judge'` (call 23)
    - `soft: z.boolean().nullable()`: set only with `deniedBy: 'judge'`; whether the builder's go-ahead clears it
  - **The variants:**

| `kind` | fields |
| --- | --- |
| `command` | `command: string`, `cwd: string \| null`, `outputTail: string` (max `OUTPUT_TAIL_CHARS`), `outputBytes: int ≥ 0`, `exitCode: int \| null` |
| `edit` | `path: string(min 1)`, `change: EditChange`, `movePath: string \| null`, `hunks: ToolCallHunk[]`, `addedLines`, `removedLines: int ≥ 0`, `truncated: boolean` |
| `read` | `path`, `range: { offset: int ≥ 0, limit: int > 0 \| null } \| null` |
| `search` | `pattern: string`, `paths: string[] \| null`, `matchCount: int ≥ 0 \| null` |
| `mcp` | `server`, `tool`, `argumentsPreview` (max `PREVIEW_CHARS`), `resultTail: string \| null` (max tail), `error: string \| null` |
| `subagent` | `agent`, `promptPreview` (max `PREVIEW_CHARS`), `model: string \| null` |
| `web` | `query: string \| null`, `url: string \| null` |
| `other` | `name`, `inputPreview` (max `PREVIEW_CHARS`) |

- [ ] **Step 1: Write the failing test** in `tool-call-view.test.ts`. It is a table with one valid row per kind,
  each of which parses and round-trips with `toEqual`. Add these rejecting rows:
  - an `outputTail` of 4,097 characters
  - `kind: 'shell'`
  - an `edit` with no `hunks`
  - a `startedAt` that isn't ISO
  - `durationMs: -1`
  - `deniedBy: 'agent'`
  - a `limit` with `deniedBy: '10db'`

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @10db/contracts exec vitest run src/tool-call-view.test.ts`
Expected: FAIL, because `./tool-call-view` does not exist.

- [ ] **Step 3: Implement the schema, export it, register it, then run `pnpm --filter @10db/contracts generate`.**

- [ ] **Step 4: Run the test**

Run: `pnpm --filter @10db/contracts exec vitest run src/tool-call-view.test.ts src/contracts.test.ts`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/tool-call-view.ts packages/contracts/src/tool-call-view.test.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated/tool-call-view.schema.json && git commit -m 'feat(contracts): a tool call as one typed view per kind

Value: protects=the wire shape of a tool call that cards render; fails_when=a kind loses a field, the tail cap goes, or an unknown kind parses; why_new=no DTO carried a tool call; no_claim=that adapters fill it correctly (their mapping tables do)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: `hunks.ts`: every edit as hunks

**Files:**

- Modify: `apps/daemon/package.json`, `pnpm-lock.yaml` (add `diff`, exact)
- Create: `apps/daemon/src/sessions/hunks.ts`, `apps/daemon/src/sessions/hunks.test.ts`

**Interfaces:**

- Produces:
  - `CONTEXT_LINES = 3` and `EDIT_LINES_CAP = 1_500`
  - `interface EditHunks { readonly hunks: readonly ToolCallHunk[]; readonly addedLines: number; readonly removedLines: number; readonly truncated: boolean }`
  - `DIFF_MAX_EDIT_LENGTH = 10_000` and `DIFF_TIMEOUT_MS = 100`
  - `hunksOfTexts(before: string, after: string, firstLine = 1): EditHunks`. It uses `structuredPatch` with
    `{ context: CONTEXT_LINES, maxEditLength: DIFF_MAX_EDIT_LENGTH, timeout: DIFF_TIMEOUT_MS }`. `firstLine` is
    the file line where `before` begins: every `oldStart` and `newStart` is shifted by `firstLine - 1`.
  - **When jsdiff gives up**, past either bound, it returns `undefined`. The result is then the whole of `after` as
    added, through the same cap, with `truncated: true`. `removedLines` counts `before`'s lines. This runs on the
    daemon's event loop for every edit on every lane, so neither bound is optional (call 22).
  - `hunksOfPatch(patch: string): EditHunks | null`. It uses `parsePatch`, accepting a diff with or without
    `---`/`+++` headers, and returns `null` when the text holds no `@@` hunk. It never throws: a parse error is
    `null`.
- **Each hunk's text.**
  - `before` is its ` ` and `-` lines, and `after` its ` ` and `+` lines, each without the prefix and joined with
    `\n`.
  - `\ No newline at end of file` lines appear in neither.
  - The numbers are jsdiff's: an empty side reads `oldStart: 0, oldLines: 0`.
- **The cap.** Hunks are kept in order while the changed lines (`+` and `-`) kept stay within `EDIT_LINES_CAP`.
  - The hunk that would cross it is cut after its last changed line within the cap. Its `oldLines` and `newLines`
    count only the lines kept.
  - Every later hunk is dropped, and `truncated` is `true`.
  - `addedLines` and `removedLines` always count the whole edit.

- [ ] **Step 1: Add the dependency.** Run `npm view diff version`, then
  `pnpm --filter @10db/daemon add --save-exact diff@<that version>`.

- [ ] **Step 2: Write the failing table** in `hunks.test.ts`. One row per case, named:
  - **One line changed** in the middle of a 10-line text. The result is one hunk,
    `{ oldStart: 2, oldLines: 7, newStart: 2, newLines: 7 }`, with `before` and `after` as exact strings,
    `addedLines: 1`, `removedLines: 1`.
  - **The same with `firstLine: 41`.** `oldStart` and `newStart` are 42.
  - **A new file** (`''` to three lines). The result is `{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 3 }`,
    `before: ''`, `addedLines: 3`.
  - **No change.** No hunks, zeros, `truncated: false`.
  - **1,600 added lines.** `addedLines: 1600`, `truncated: true`, and the kept `+` lines number 1,500.
  - **Two far-apart edits that cross the cap in the second.** The first hunk is whole, and the second is cut.
  - **A two-hunk unified diff with headers.** Two hunks whose numbers equal their `@@` lines.
  - **The same diff without `---`/`+++`.** The same result.
  - **A diff ending in `\ No newline at end of file`.** The marker appears in neither text.
  - **`hunksOfPatch('export const a = 1;\n')`.** `null`.
  - **Two 6,000-line texts with no line in common.** Their edit length is past `DIFF_MAX_EDIT_LENGTH`. The result
    is `truncated: true`, the kept hunk is the new text as added, cut at 1,500 lines, and `removedLines` is 6,000.
    The row also asserts that the call returns within 1 s.

- [ ] **Step 3: Run it and watch it fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/hunks.test.ts`
Expected: FAIL, because `./hunks` does not exist.

- [ ] **Step 4: Implement `hunks.ts`.**

- [ ] **Step 5: Run it**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/hunks.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/package.json pnpm-lock.yaml apps/daemon/src/sessions/hunks.ts apps/daemon/src/sessions/hunks.test.ts && git commit -m 'feat(daemon): every edit becomes hunks with three lines of context, capped at 1,500 changed lines

Value: protects=the hunks a diff card draws, from text pairs and from unified diffs, in bounded time; fails_when=line numbers drift, a marker leaks into the text, the cap stops cutting, a non-diff throws, or an unbounded diff blocks the daemon; why_new=no diff path existed; no_claim=that the right before-text is read (before-text.test.ts)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 3: `before-text.ts`: the guarded read of a file's previous content

The daemon runs outside every sandbox and reads a path an agent named, so this read goes through a descriptor.
No check is ever followed by a second lookup of the path. This is a security boundary (§11), so it is taken red
first, and it has exhaustive rows.

**Files:**

- Create: `apps/daemon/src/sessions/before-text.ts`, `apps/daemon/src/sessions/before-text.test.ts`

**Interfaces:**

- Produces:
  - `BEFORE_TEXT_MAX_BYTES = 1_048_576`
  - `type BeforeText = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'absent' } | { readonly kind: 'unread' }`
  - `interface CheckoutFs`: the `node:fs` sync calls the read uses (`lstatSync`, `openSync`, `fstatSync`,
    `readSync`, `closeSync`, `realpathSync`). Its production default is `node:fs` itself. A test passes a wrapper
    that swaps a path between two calls. This is an injected dependency with a production default, not a test-only
    branch.
  - `readCheckoutText(checkout: string, path: string, fs: CheckoutFs = nodeFs): BeforeText`. `path` is resolved
    against `checkout` when it is relative. The steps run in this order:
    1. **Find the parent.** Take `realCheckout = realpath(checkout)` and its `dev` (from `lstat`), and
       `realParent = realpath(dirname(path))`. `realParent` must be `realCheckout` or inside it, else `unread`. A
       missing parent gives `absent`.
    2. **`lstat` `<realParent>/<basename>`**, never the path as given. `ENOENT` gives `absent`. Anything but a
       regular file gives `unread`. Its `dev` and `ino` are kept.
    3. **`open` `<realParent>/<basename>` with `O_RDONLY | O_NOFOLLOW`.** A link swapped in since step 2 fails
       `ELOOP`, giving `unread`.
    4. **`fstat` the descriptor.** Any of these gives `unread`:
       - it isn't a regular file, or is over `BEFORE_TEXT_MAX_BYTES`
       - its `dev` or `ino` differs from step 2
       - its `dev` differs from the checkout's
       - its `nlink` isn't 1. A hard link to a file outside the checkout has `nlink > 1` (call 20).
    5. **Read from the descriptor** as UTF-8, up to the `fstat` size.
    6. **Take `realpath(dirname(path))` again.** It must equal step 1's `realParent`, or the result is `unread`.
       That catches a parent swapped to a link and back between the steps. Otherwise the result is `text`.

    The descriptor is closed in a `finally`. Any other error gives `unread`. It never throws.

- [ ] **Step 1: Write the failing table** on a real temp directory (`mkdtempSync(join(tmpdir(), …))`). On macOS that
  directory sits behind `/var` → `/private/var`, so the realpath comparison is exercised on every run. One row per
  case:

| row | setup | result |
| --- | --- | --- |
| a regular file inside | `a.ts` with `x\n` | `{ kind: 'text', text: 'x\n' }` |
| relative and absolute paths name the same file | `a.ts` and `<checkout>/a.ts` | both `text` |
| a missing file | `new.ts` | `absent` |
| a link inside to a file inside | `l.ts` → `a.ts` | `unread` |
| a link to a file outside | `l.ts` → `<outside>/secret` | `unread` |
| a path that climbs out | `../outside/secret` | `unread` |
| an absolute path outside | `<outside>/secret` | `unread` |
| a file under a linked directory that points outside | `d` → `<outside>`, `d/secret` | `unread` |
| a hard link to a file outside (same volume) | `h.ts` hard-linked to `<outside>/secret` | `unread` |
| a directory | `src` | `unread` |
| a file over 1 MB | 1,048,577 bytes | `unread` |
| **a file swapped for a link after `lstat`** | the `fs` wrapper's `lstatSync` returns, then replaces `a.ts` with a link to `<outside>/secret` | `unread` (`O_NOFOLLOW`) |
| **a parent directory swapped for a link after `lstat`** | `d/a.ts` exists. After `lstatSync`, the wrapper renames `d` away and links `d` → `<outside>`, which holds an `a.ts` | `unread` (inode differs, and the parent is outside) |
| **a file replaced by another regular file after `lstat`** | after `lstatSync`, the wrapper writes a new `a.ts` (a new inode) | `unread` |
| **a parent linked outside before the read, then swapped back** | `d/a.ts` exists. Before the first `realpathSync`, the wrapper renames `d` away and links `d` → `<outside>`, which holds an `a.ts`. After `readSync`, it restores the real `d` | `unread` (step 1's parent is outside; were it checked only after the read, it would pass) |
| **the parent's realpath differs after the read** | after `readSync`, the wrapper swaps `d` for a link to another directory inside the checkout | `unread` (step 6) |

The `<outside>` file holds `SECRET`. Every row also asserts that no result's text contains `SECRET`.

- [ ] **Step 2: Run it and watch it fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/before-text.test.ts`
Expected: FAIL, because `./before-text` does not exist.

- [ ] **Step 3: Implement `readCheckoutText`** as above. Then run two mutations, reverting each:
  - Read with `readFileSync(path)` in place of the descriptor. Expected: the swap rows FAIL.
  - Drop step 1's parent check, keeping only step 6. Expected: the swap-back row FAILs.

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions/before-text.ts apps/daemon/src/sessions/before-text.test.ts && git commit -m 'feat(daemon): read a written file'"'"'s previous text through one no-follow descriptor inside the checkout

Value: protects=spec 11: the unsandboxed daemon reads no file an agent pointed outside the checkout, through a link, a hard link or a swap between check and read; fails_when=a link, a climbing path, a linked or swapped parent, a hard link, a swapped file or a large file is read; why_new=the daemon read no agent-named path before; no_claim=what the card shows for each answer (claude-tool-calls.test.ts)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 4: The new events in the seam, the live line from a `ToolCallView`, and logging

**Files:**

- Modify: `apps/daemon/src/sessions/types.ts` (`SessionEvent`, plus new types)
- Modify: `apps/daemon/src/sessions/tool-target.ts`, `tool-target.test.ts`
- Create: `apps/daemon/src/sessions/stream-log.ts`, `apps/daemon/src/sessions/stream-log.test.ts`
- Modify: `apps/daemon/src/sessions/index.ts`
- Modify: `apps/daemon/src/runner/runner.ts:2535-2990` (the event switch), `apps/daemon/src/shape/service.ts:697-767`
  (`onEvent`)

**Interfaces:**

- Produces, in `sessions/types.ts`:
  - `PlanStepStatus = { Pending: 'pending', InProgress: 'in_progress', Completed: 'completed' } as const`
  - `interface PlanStep { readonly text: string; readonly status: PlanStepStatus }`
  - `interface AgentCommand { readonly name: string; readonly description: string; readonly argumentHint?: string }`
  - New `SessionEvent` variants:
    - `{ type: 'text_delta'; itemId: string; offset: number; text: string }`
    - `{ type: 'reasoning_delta'; itemId: string; offset: number; text: string }`
    - `{ type: 'message'; itemId: string; text: string }`
    - `{ type: 'tool_call'; call: ToolCallView; appended?: string }` (call 14)
    - `{ type: 'commands'; commands: readonly AgentCommand[] }`
    - `{ type: 'plan_update'; steps: readonly PlanStep[] }`

    Every field is `readonly`. `offset` is the item's JS string length before the delta.
- Produces, in `sessions/tool-target.ts` (next to the existing functions, which Task 10 removes):
  - `TITLE_CHARS = 120`
  - `type UntitledToolCall`: the distributive `Omit<ToolCallView, 'title'>` over the union
  - `titled(call: UntitledToolCall): ToolCallView`
  - `toolCallTarget(call: ToolCallView): ToolTarget`
  - `toolCallActivity(call: ToolCallView): { readonly summary: string; readonly tool: ToolTarget }`. Its summary is
    `` `${harnessTool} ${title}` ``, cut to 200.
- Produces: `streamEventLogFields(event: StreamEvent): Readonly<Record<string, string | number>>`, where
  `StreamEvent` is the `Extract` of the six new variants. The fields are `type`, plus `itemId`, `offset` and
  `chars`, or `callId`, `kind` and `status`, or `count`. Never text.

**The title and target table** (call 4). Every title and target is cut to its length (`TITLE_CHARS`, and
`TARGET_CHARS` = 300 for targets):

| kind | `title` | `target` | `written` |
| --- | --- | --- | --- |
| `command` | the command's first line | `firstWord(command)` (past `VAR=` words) | `[]` |
| `edit` | `path`, or `` `${path} → ${movePath}` `` | `path` | `[path]`, plus `movePath` when set |
| `read` | `path` | `path` | `[]` |
| `search` | `pattern` | `pattern` | `[]` |
| `mcp` | `` `${server}.${tool}` `` | `null` | `[]` |
| `subagent` | `agent` | `null` | `[]` |
| `web` | `query ?? url ?? harnessTool` | `url ?? query` | `[]` |
| `other` | `name` | `null` | `[]` |

`ToolTarget.name` is always `harnessTool`.

- [ ] **Step 1: Write the failing tests.**
  - **`tool-target.test.ts`, a new `describe('toolCallTarget')` table.** It has one row per kind above, plus these
    rows, which keep what the old rows checked:
    - a `command` `CI=1 pnpm test` gives target `pnpm`
    - an `edit` of `n.ipynb` writes `['n.ipynb']`
    - a `search` with pattern `**/*.ts` gives target `**/*.ts`
    - a 400-character path is cut to 300

    Each row also checks `toolCallActivity(call).summary`.
  - **`stream-log.test.ts`.** One row per new event type gives its exact fields. One assertion runs over all rows:
    no value equals or contains the event's text, and no key is `text`.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/tool-target.test.ts src/sessions/stream-log.test.ts`
Expected: FAIL, because `toolCallTarget` and `./stream-log` are missing.

- [ ] **Step 3: Implement** the types, the three functions and `stream-log.ts`.
  - In `runner.ts`, add a grouped `case` for the six new types. It calls
    `log.debug(streamEventLogFields(event), 'session stream event')` and does nothing else yet. Task 6 gives
    `tool_call` its real handling.
  - In `shape/service.ts` `onEvent`, add the same six cases beside `activity` (`:763`), logged the same way through
    the service's logger.

- [ ] **Step 4: Run the tests and the switches' lint**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/tool-target.test.ts src/sessions/stream-log.test.ts && pnpm --filter @10db/daemon typecheck && pnpm exec eslint apps/daemon/src/sessions apps/daemon/src/runner/runner.ts apps/daemon/src/shape/service.ts`
Expected: PASS. `switch-exhaustiveness-check` is satisfied in both switches.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions/types.ts apps/daemon/src/sessions/tool-target.ts apps/daemon/src/sessions/tool-target.test.ts apps/daemon/src/sessions/stream-log.ts apps/daemon/src/sessions/stream-log.test.ts apps/daemon/src/sessions/index.ts apps/daemon/src/runner/runner.ts apps/daemon/src/shape/service.ts && git commit -m 'feat(daemon): sessions gain text, reasoning, message, tool call, command and plan events, logged by id

Value: protects=the live line'"'"'s name, target and written files read from a typed tool call, and logs that never hold agent text; fails_when=a kind loses its target or written path, or a log line carries text; why_new=the old rows read raw tool input, not a ToolCallView; no_claim=that the runner uses it (the claim test, Task 6)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 5: Claude tool calls as `ToolCallView`s

**Files:**

- Create: `apps/daemon/src/sessions/claude-tool-calls.ts`, `apps/daemon/src/sessions/claude-tool-calls.test.ts`

**Interfaces:**

- Consumes:
  - `titled` (Task 4)
  - `hunksOfTexts` (Task 2)
  - `BeforeText` (Task 3)
  - `PlanStep` and `SessionEvent` (Task 4)
- Produces:
  - **The input and result shapes:**
    - `interface ClaudeToolUse { readonly id: string; readonly name: string; readonly input: unknown; readonly parentId: string | null }`
    - `interface ClaudeDenial { readonly by: DeniedBy; readonly reason: string; readonly limit: LimitName | null; readonly soft: boolean | null }`
      (`LimitName` is T3's; `limit` and `soft` are set only when `by` is `judge`, call 23)
    - `interface ClaudeToolResult { readonly isError: boolean; readonly denial: ClaudeDenial | null; readonly content: unknown }`.
      Its `content` is a string, or an array of blocks of which only `{ type: 'text', text }` is read.
  - **`claudeToolCall(use, ctx: { readonly startedAt: Date; readonly before: (path: string) => BeforeText }): ToolCallView`.**
    The tracker passes `before` as `(path) => deps.before(use.id, path)`.
    It is pure given `before`, and it never throws: an input that fails its zod shape becomes `other`.
  - **`claudeToolResult(call: ToolCallView, result: ClaudeToolResult, endedAt: Date): ToolCallView`.**
    - The status is `denied` with `refusal` and `deniedBy` from `result.denial` when there is one, else `failed` if
      `isError`, else `done`.
    - `durationMs` is `endedAt - startedAt`.
    - On a `command`, `outputTail` is the last `OUTPUT_TAIL_CHARS` of the text and `outputBytes` its UTF-8 length.
    - On an `mcp` call, `resultTail` is set, or `error` when `isError`.
  - **`claudePlanSteps(input: unknown): readonly PlanStep[] | null`.** It reads `TodoWrite`'s
    `todos[].{content, status}` and returns null when the input isn't that shape.
  - **`createBeforeTexts(read: (cwd: string, path: string) => BeforeText): BeforeTexts`**, which keeps the newest 256
    entries (C2):
    - `capture(toolUseId: string, toolName: string, input: unknown, cwd: string): void` reads the before-text of a
      `Write`, `Edit` or `MultiEdit` target, and ignores every other tool.
    - `take(toolUseId: string): BeforeText` returns it and forgets it. An id with nothing captured gives `unread`.
  - **`createClaudeToolCalls(deps: { now(): Date; before(toolUseId: string, path: string): BeforeText })`.** It
    returns a `ClaudeToolCalls`:
    - `use(u: ClaudeToolUse): SessionEvent[]`. `TodoWrite` gives `[plan_update]`. Any other tool gives
      `[tool_call running]`, and the call is kept.
    - `result(toolUseId: string, r: Omit<ClaudeToolResult, 'denial'>): SessionEvent[]`. A kept id gives
      `[tool_call final]`, and the call is forgotten. An unknown id gives `[]`.
    - `deny(toolUseId: string, denial: ClaudeDenial): void`

**The mapping table** (`harnessTool` is always the SDK tool name):

| tool | input | `ToolCallView` |
| --- | --- | --- |
| `Bash` | `{ command }` | `command`, `cwd: null`, `outputTail: ''`, `outputBytes: 0`, `exitCode: null` (call 11) |
| `Edit` | `{ file_path, old_string, new_string }` | `edit` `update`, `hunksOfTexts(old, new, line)`. `line` is where `old_string` starts in the before-text when that is `text` and contains it, else 1 (call 15) |
| `MultiEdit` | `{ file_path, edits[] }` | `edit` `update`. Each edit's hunks are concatenated in order, located in the before-text with the earlier edits applied |
| `Write` | before `absent` | `edit` `add`, `hunksOfTexts('', content)` |
| `Write` | before `text` | `edit` `update`, `hunksOfTexts(before, content)` |
| `Write` | before `unread` | `edit` `update`, `hunksOfTexts('', content)`: the whole file as added (§5.2) |
| `NotebookEdit` | `{ notebook_path }` | `edit` `update`, no hunks (call 10) |
| `Read` | `{ file_path, offset?, limit? }` | `read`, with `range` only when `offset` or `limit` is given |
| `Grep` | `{ pattern, path? }` | `search`, `paths: path ? [path] : null` |
| `Glob` | `{ pattern, path? }` | `search` |
| `mcp__<server>__<tool>` | any | `mcp`, `argumentsPreview` = JSON cut to `PREVIEW_CHARS`. The server is the text before the first `__` after `mcp__` |
| `Task` or `Agent` | `{ subagent_type, prompt, model? }` | `subagent` |
| `WebFetch` | `{ url }` | `web` with `url` |
| `WebSearch` | `{ query }` | `web` with `query` |
| anything else, or an input of the wrong shape | any | `other`, `name` = the tool, `inputPreview` = JSON cut |

- [ ] **Step 1: Write the failing tables** in `claude-tool-calls.test.ts`.
  - One `claudeToolCall` row per table line, with a stub `before` per row and a fixed `startedAt`.
  - `claudeToolResult` rows:
    - a Bash success, with a string content
    - a Bash failure
    - block-array content
    - a 10,000-character output: the tail is the last 4,096 characters, and `outputBytes` is 10,000
    - `é` output: `outputBytes` 2
    - a denial wins over `isError`, and carries `refusal` and `deniedBy`
    - an mcp success and an mcp error
  - Tracker rows:
    - a use and then its result give two events, the second final
    - a result for an unknown id gives `[]`
    - a deny before the result gives `denied`, with the denial's reason and `by`
    - `createBeforeTexts`: a `Write` captured and then taken gives the read's answer, a second `take` gives
      `unread`, a `Read` is never read, and the 257th capture drops the oldest
    - `TodoWrite` gives one `plan_update`, and its later result gives `[]`
    - a subagent's use carries `parentId`

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-tool-calls.test.ts`
Expected: FAIL, because `./claude-tool-calls` does not exist.

- [ ] **Step 3: Implement** with loose zod shapes per tool (SDK tool input is untyped).

- [ ] **Step 4: Run it.** Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions/claude-tool-calls.ts apps/daemon/src/sessions/claude-tool-calls.test.ts && git commit -m 'feat(daemon): a Claude tool use and its result become one typed tool call

Value: protects=the Claude tool call table of spec 5.2 with hunks, tails and statuses; fails_when=a tool maps to the wrong kind, an edit loses its line numbers, a tail grows past 4 KB, a denial reads as a failure, or an unknown result id emits; why_new=Claude tool activity was a 200-character summary; no_claim=that claude-session feeds it the SDK messages (claude-adapter.test.ts and claude-shape.test.ts, Task 7)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 6: The live line and claims from `tool_call` alone, and the fake's new events

**Files:**

- Modify: `apps/daemon/src/runner/runner.ts:2598-2631` (the `activity` case) and Task 4's grouped case
- Modify: `apps/daemon/src/sessions/fake-script.ts` (`FakeStep`, `TURN_STEPS`)
- Modify: `apps/daemon/src/sessions/fake-session.ts`: the lane driver's steps, among them the `tool` step (today
  `fake-adapter.ts:527-571`), and the explore driver's reply
- Modify: `apps/daemon/src/sessions/fake-adapter.test.ts`
- Modify: `apps/daemon/src/runner/pass-lane.test.ts` (one new row in `describe("a working turn's live line")`,
  `:344`)

**Interfaces:**

- Consumes:
  - `toolCallActivity` (Task 4)
  - `createClaudeToolCalls` (Task 5)
  - `readCheckoutText` (Task 3)
  - `ToolCallView` (Task 1)
- **The runner.**
  - A local `noteActivity(kind: 'text' | 'tool', summary: string, tool: ToolTarget | null)` holds today's
    `activity` body, unchanged.
  - `case 'activity'` calls it.
  - `case 'tool_call'` calls it with `toolCallActivity(event.call)`, once per `event.call.id` (a per-session
    `Set<string>`). Every `tool_call` is also logged as in Task 4.
- **New `FakeStep`s** in `fake-script.ts`, validated by the existing zod `FakeStep` union. The lane driver emits
  them through `FakeSessionCore.emit`:
  - `{ do: 'say', text: string }`: two `text_delta`s (the text split at its middle), then `message`, with itemId
    `fake-msg-<n>`
  - `{ do: 'think', text: string }`: one `reasoning_delta`
  - `{ do: 'plan', steps: { text: string, status: 'pending' | 'in_progress' | 'completed' }[] }`: `plan_update`
  - `{ do: 'commands', names: string[] }`: `commands`, each with the description `/<name>`
  - `{ do: 'tool_call', call: ToolCallView }`: that event as it is (the contracts schema validates it)
- **The fake's `tool` step** emits the tracker's `use` events instead of `activity`. After the guard and the
  permission decision it emits `result`. A denial is `deny` then `result`: `{ by: '10db', reason }` for a guard
  deny, and `{ by: decision.by, reason: decision.message }` for a `canUseTool` deny. An allowed call is `result` with
  `isError: false`. Its id is `fake-tool-<index>`, and its `before` reads through `readCheckoutText(spec.cwd, …)`.
- **The fake's explore reply** (`runFakeExploreSession`) emits two `text_delta`s and a `message` for its reply
  text before its `turn_complete`.
- `TURN_STEPS` gains `say`, `think`, `plan` and `tool_call`.

- [ ] **Step 1: Write the failing claim test** in `pass-lane.test.ts`, inside `describe("a working turn's live line")`:

```ts
it('names the tool and counts the files written from tool calls alone, once per call', async () => {
  const at = '2026-11-12T00:00:00.000Z';
  const edit = (status: 'running' | 'done'): ToolCallView => ({
    kind: 'edit', id: 'fc_1:0', harnessTool: 'apply_patch', status, title: PAGE_FILE, startedAt: at,
    durationMs: status === 'done' ? 5 : null, parentId: null, refusal: null, deniedBy: null,
    path: PAGE_FILE, change: 'update',
    movePath: null, hunks: [], addedLines: 1, removedLines: 0, truncated: false,
  });
  const command: ToolCallView = {
    kind: 'command', id: 'cmd_1', harnessTool: 'command', status: 'running', title: 'pnpm test',
    startedAt: at, durationMs: null, parentId: null, refusal: null, deniedBy: null, command: 'pnpm test',
    cwd: null, outputTail: '',
    outputBytes: 0, exitCode: null,
  };
  const { pass, id } = await openPage([[
    { do: 'consume' },
    { do: 'tool_call', call: edit('running') },
    { do: 'tool_call', call: edit('done') },
    { do: 'tool_call', call: command },
    { do: 'await_message', contains: 'never sent' },
  ]]);

  const activity = await waitFor(() => {
    const now = passView(engine.store.db, pass.id).pages[0]?.turn?.activity;
    return now?.tool === 'command' ? now : undefined;
  });
  expect(activity).toMatchObject({ tool: 'command', target: 'pnpm', filesTouched: [PAGE_FILE] });
  const rows = listEventsAfter(engine.store.db, 0, 1000).filter(
    (e) => e.type === 'session.activity' && e.data['workstreamId'] === id,
  );
  expect(rows.map((e) => SessionActivityData.parse(e.data).tool)).toEqual([
    { name: 'apply_patch', target: PAGE_FILE },
    { name: 'command', target: 'pnpm' },
  ]);
});
```

Also write `fake-adapter.test.ts` rows. Each new step emits its events, with exact `offset`s for `say`. The `tool`
step emits two `tool_call`s and no `activity`: `running` then `done`, `denied` on a guard deny.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/runner/pass-lane.test.ts -t 'tool calls alone'`, then
`pnpm --filter @10db/daemon exec vitest run src/sessions/fake-adapter.test.ts` as a second command, so `-t` doesn't
filter out the fake's new rows.
Expected: FAIL in both. The fake rejects the unknown step `tool_call`. Once the step exists and the runner change does
not, `waitFor` times out with no `command` activity.

- [ ] **Step 3: Implement** the fake's steps, then the runner's `tool_call` case.

- [ ] **Step 4: Run the live-line tests, old and new, and the fake**

Run: `pnpm --filter @10db/daemon exec vitest run src/runner/pass-lane.test.ts src/sessions/fake-adapter.test.ts src/runner/runner.test.ts`
Expected: PASS. The existing row "names the tool and the file it aims at, and counts the files the turn wrote"
(`:345`) now passes through `tool_call`, unchanged.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/runner/runner.ts apps/daemon/src/sessions/fake-script.ts apps/daemon/src/sessions/fake-session.ts apps/daemon/src/sessions/fake-adapter.test.ts apps/daemon/src/runner/pass-lane.test.ts && git commit -m 'feat(daemon): the runner names a turn'"'"'s tool and its written files from tool calls, once per call

Value: protects=claims and the live line once activity comes only from tool_call (spec 13 pipeline row); fails_when=tool-target stops returning a written path, or the runner records every update of a call (one row per Codex output delta); why_new=the live-line row drives Claude-shaped steps only and never sees one call twice; no_claim=that the real adapters emit these calls (their mapping tables)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 7: Claude streams: deltas, messages, tool calls and commands

**Files:**

- Create: `apps/daemon/src/sessions/claude-stream.ts`, `apps/daemon/src/sessions/claude-stream.test.ts`
- Modify: `apps/daemon/src/sessions/claude-mapping.ts` (`mapSdkMessage`), `claude-mapping.test.ts`
- Modify, in `apps/daemon/src/sessions/`:
  - `claude-query-options.ts` and `claude-query-options.test.ts`: `ClaudeProfileOptions` gains
    `'includePartialMessages'`
  - `claude-session.ts`: the ctx, and the commands after init
  - `claude-session-hooks.ts`: the deny marking, and `by: '10db'` on the billing denies
  - `claude-adapter.ts`: `by: '10db'` on the probe's and `complete`'s denies
  - `types.ts`: `ToolDecision`'s deny branch gains `by: DeniedBy`
  - `claude-adapter.test.ts` (lane) and `claude-shape.test.ts` (explore)
- Modify: `apps/daemon/src/inbox/permission-broker.ts` (every deny gets `by`) and `permission-broker.test.ts`
- Modify: `apps/daemon/src/shape/service.ts:1147`, `apps/daemon/src/daemon/shape-session-tools.ts:180`
- Modify: every test that builds or expects a deny decision (`git grep -l "behavior: 'deny'" apps/daemon`)
  - `claude-test-support.ts`

**Interfaces:**

- Produces:
  - **`ClaudeStreamState`**, holding:
    - `messageId: string | null`
    - `blocks: Map<number, { kind: 'text' | 'thinking'; itemId: string; text: string }>`
    - `streamed: Set<string>` (message ids)
  - **`createClaudeStreamState()`**
  - **`mapClaudeStreamEvent(msg: SDKPartialAssistantMessage, state: ClaudeStreamState): SessionEvent[]`:**
    - `message_start` sets `messageId` and adds it to `streamed`.
    - `content_block_start` of `text` or `thinking` opens a block with itemId `` `${messageId}:${index}` ``
      (call 5).
    - A `text_delta` gives a `text_delta` event, and a `thinking_delta` a `reasoning_delta`. The offset is the
      block's length before it.
    - `content_block_stop` of a text block gives `message { itemId, text }`.
    - A frame with `parent_tool_use_id !== null`, and every other event type, gives `[]`.
- **`mapSdkMessage(msg, ctx)`** keeps its name. `ctx` becomes
  `{ readonly pid: number | null; readonly stream: ClaudeStreamState; readonly calls: ClaudeToolCalls }`, and the
  function adds:
  - `type: 'stream_event'` goes to `mapClaudeStreamEvent`.
  - `system/commands_changed` gives `commands`. An empty `argumentHint` is left out.
  - **On `assistant`:**
    - A frame with `parent_tool_use_id !== null` (a subagent's) emits no `message`, as the stream path does (C8).
      Its `tool_use` blocks still become calls, with `parentId`.
    - A text block still emits `activity` text.
    - A text block also emits `message` with itemId `` `${message.id}:a${n}` `` only when
      `!stream.streamed.has(message.id)`. `n` counts that message's text frames.
    - A `tool_use` block becomes `calls.use({ id, name, input, parentId: msg.parent_tool_use_id })`, in place of
      `activity` tool.
  - **On `user`:** each `tool_result` block in `message.content` becomes
    `calls.result(tool_use_id, { isError: is_error === true, content })`.
- **`claude-query-options.ts`:** `claudeQueryOptions` sets `includePartialMessages: true` on both profiles and both
  sandbox states.
- **`claude-session.ts`:**
  - **Each session** makes one `createClaudeStreamState()`, one
    `createBeforeTexts((cwd, p) => readCheckoutText(spec.cwd, resolve(cwd, p)))` and one
    `createClaudeToolCalls({ now: () => clock.now(), before: (id, _p) => beforeTexts.take(id) })`. It passes the
    stream state and the tool calls in `ctx`.
  - **The before-text is captured in the PreToolUse hook (C2),** keyed by `tool_use_id`. Claude Code runs a tool as
    soon as the hook allows it, so by the time the pump reads the assistant frame the file may already be written.
    `preToolUseHook` gains `beforeCall: (input: PreToolUseHookInput) => void`. It calls it once per call, before
    judging, with the hook's `cwd`. That call is `beforeTexts.capture(tool_use_id, tool_name, tool_input, cwd)`.
  - **After `started`** it calls `q.supportedCommands()` and pushes `commands`. A rejection is logged at `debug`
    and pushes nothing.
  - **Every place that denies** calls `calls.deny(tool_use_id, denial)` when the id is known. In
    `claude-session-hooks.ts`, `preToolUseHook` and `canUseToolBridge` each gain
    `onDenied: (toolUseId: string, denial: ClaudeDenial) => void`:
    - The hook calls it when its output denies, with `{ by: '10db', reason }` from the verdict and the id from the
      input's `tool_use_id`. That includes the billing gate's `BILLING_UNVERIFIED` deny.
    - The bridge calls it when the decision is `deny`, with `{ by: decision.by, reason: decision.message }` and the
      id from `ToolRequest.toolUseId`. Its own `BILLING_UNVERIFIED` denies carry `by: '10db'`.
- **`ToolDecision`'s deny branch** (`sessions/types.ts:39-41`) gains a required `by: DeniedBy`. It is required so
  that typecheck lists every deny site. The values:
  - **`builder`:** only the card's Deny answer, `permission-broker.ts:423-426`. A question answered as a refusal
    returns through the same branch.
  - **`10db`:** everything else:
    - `permission-broker.ts:189` (`UNJUDGED_PATH`), `:299` (unreadable AskUserQuestion input), `:437` (no host),
      `:494` (a host pending a card), `:573`, `:579` (protected and outside-copy reads), `:584`, and `:633`
      (parked until the builder answers)
    - `shape/service.ts:1147` and `daemon/shape-session-tools.ts:180`
    - the bridge's billing denies, and the "runs no tools" denies of the probe and of `complete` in
      `claude-adapter.ts`
  - Tests that build or expect a deny decision gain `by` with the value above (`git grep -l "behavior: 'deny'"`:
    11 test files). A changed expectation that adds `by` is the new attribution, asserted.
- **`claude-test-support.ts`** gains these builders:
  - `streamEvent(event, parent = null)`
  - `messageStart(id)`, `blockStart(index, type)`, `textDelta(index, text)`, `thinkingDelta(index, text)`,
    `blockStop(index)`
  - `toolResultMessage(toolUseId, content, isError = false)`

  `assistantMessage` takes an optional message id. In both test files, `fakeQuery`'s `Script` gains
  `commands?: readonly SlashCommand[] | 'reject'` for `supportedCommands()`.

- [ ] **Step 1: Write the failing tests.**
  - **`claude-stream.test.ts`** rows:
    - a text block in two deltas: offsets 0 and 3, then `message`
    - `é😀` then `x`: the second offset is 3, and the message is `é😀x`
    - a thinking block gives `reasoning_delta` and no `message`
    - two text blocks give itemIds `msg_1:0` and `msg_1:2`
    - a subagent frame gives `[]`
    - a `tool_use` block start and its `input_json_delta` give `[]`
  - **`claude-mapping.test.ts`** rows:
    - a stream event is routed
    - an assistant text whose message streamed gives `activity` only
    - one whose message didn't stream gives `activity` and `message msg_9:a0`
    - a subagent's assistant text (`parent_tool_use_id: 'toolu_9'`) gives no `message`
    - a `tool_use` gives `tool_call running` and no `activity` tool
    - `TodoWrite` gives `plan_update`
    - a `user` tool_result gives `tool_call done`
    - `commands_changed` gives `commands`
  - **`claude-query-options.test.ts`:** each row of M2a's table expects `includePartialMessages: true`.
  - **`claude-adapter.test.ts`, with the explore twin in `claude-shape.test.ts`:**
    - **A streamed lane turn through `fakeQuery`.** Its script is init, message_start `msg_1`, a text block with
      deltas `Hel` and `lo`, block stop, the assistant frame `textBlock('Hello')` for `msg_1`, an assistant
      `toolUseBlock('Bash', { command: 'ls' })`, its `toolResultMessage`, and a result. The events include, in
      order:
      1. `text_delta(msg_1:0, 0, 'Hel')` and `text_delta(msg_1:0, 3, 'lo')`
      2. exactly one `message(msg_1:0, 'Hello')`
      3. `tool_call` `running` then `done` for `toolu_1`
      4. `turn_complete`
    - **The same turn on the explore profile**, in `claude-shape.test.ts`, gives the same events.
    - **Commands.** A script with `commands: [{ name: 'compact', description: 'Compact', argumentHint: '' }]`
      gives `commands([{ name: 'compact', description: 'Compact' }])` after `started`. With `commands: 'reject'`
      there is no `commands` event, and the turn completes.
    - **A guard deny.** `preToolUse` denies `Bash` with reason `R`, and the result frame has `is_error: true`. The
      `tool_call` is `denied`, `refusal: 'R'`, `deniedBy: '10db'`.
    - **A card deny.** `canUseTool` answers `{ behavior: 'deny', message: 'M', by: 'builder' }`. The call is
      `denied`, `refusal: 'M'`, `deniedBy: 'builder'`.
    - **A broker refusal.** `canUseTool` answers a 10db refusal (`by: '10db'`). The call is `denied` with
      `deniedBy: '10db'`.
    - **An auto-mode soft deny** (call 23), in the shape T3's plan records for it, whose reason names the "sends
      data out" line. The call is `denied`, `deniedBy: 'judge'`, `limit` that limit, `soft: true`.
    - **A `$defaults` hard deny.** The call is `denied`, `deniedBy: 'judge'`, `limit: null`, `soft: false`.
    - **`judge-denial.test.ts`** (pure): one row per limit line T3 writes, plus a reason naming none (hard).
  - **`inbox/permission-broker.test.ts`:**
    - **A protected-path read** gives a decision with `by: '10db'`.
    - **A card answered Deny** gives `by: 'builder'`.

    Mutating the card branch to `by: '10db'` makes the second row fail.
    - **The before-text is the hook's (C2).** The script holds an assistant `Write` of `a.ts` and its tool_result.
      Its `fakeQuery` runs the PreToolUse hook, then writes `a.ts` to its new content, and only then yields the
      assistant frame. The call's hunks diff the old content against the new, not new against new.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-stream.test.ts src/sessions/claude-mapping.test.ts src/sessions/claude-query-options.test.ts src/sessions/claude-adapter.test.ts src/sessions/claude-shape.test.ts`
Expected: FAIL. `./claude-stream` is missing, and the session emits no deltas, `tool_call` or `commands`.

- [ ] **Step 3: Implement** `claude-stream.ts`, the `mapSdkMessage` changes and the session wiring.

- [ ] **Step 4: Run the Claude suites and Plan's**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions src/shape`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/daemon/src/sessions/claude-stream.ts apps/daemon/src/sessions/claude-stream.test.ts apps/daemon/src/sessions/claude-mapping.ts apps/daemon/src/sessions/claude-mapping.test.ts apps/daemon/src/sessions/claude-query-options.ts apps/daemon/src/sessions/claude-query-options.test.ts apps/daemon/src/sessions/claude-session.ts apps/daemon/src/sessions/claude-session-hooks.ts apps/daemon/src/sessions/claude-adapter.test.ts apps/daemon/src/sessions/claude-shape.test.ts apps/daemon/src/sessions/claude-test-support.ts apps/daemon/src/sessions/claude-adapter.ts apps/daemon/src/sessions/types.ts apps/daemon/src/inbox/permission-broker.ts apps/daemon/src/inbox/permission-broker.test.ts apps/daemon/src/shape/service.ts apps/daemon/src/daemon/shape-session-tools.ts <each test file that gained by> && git commit -m 'feat(daemon): Claude sessions stream text and reasoning, and report tool calls and commands

Value: protects=Claude streaming per spec 5.1 and 5.4: offsets, one message per text block, a tool call from use to result, commands after init, a guard denial read as denied; fails_when=partial messages are off, a block'"'"'s offsets drift, a streamed message is emitted twice, or a denial reads as a failure; why_new=nothing streamed; no_claim=that a real Claude Code sends these frames (the live test, Task 10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 8: Codex streams: deltas, messages, typed tool calls and plan steps

**Files:**

- Modify: `apps/daemon/src/sessions/codex-protocol.ts`, `codex-protocol.test.ts`
- Modify: `apps/daemon/scripts/codex-generate.ts` (`RUNTIME_SCHEMAS`). Then regenerate
  `apps/daemon/src/sessions/codex-generated/` (`schema/`, `fixtures/` and `STAMP`).
- Create: `apps/daemon/src/sessions/codex-tool-calls.ts`, `apps/daemon/src/sessions/codex-tool-calls.test.ts`
- Modify: `apps/daemon/src/sessions/codex-mapping.ts`, `codex-mapping.test.ts`

**Interfaces:**

- **`codex-protocol.ts` gains loose schemas.** Each carries `threadId`, `turnId` and the fields below:
  - `ItemStarted`: `item` (`{ type, id? }`, loose) and `startedAtMs: number`
  - `ItemCompleted` gains `completedAtMs: z.number().optional()`
  - `AgentMessageDelta`: `{ itemId, delta }`
  - `ReasoningSummaryDelta`: `{ itemId, delta, summaryIndex }`
  - `CommandOutputDelta`: `{ itemId, delta }`
  - `TurnPlanUpdated`: `{ plan: { step: string, status: string }[] }`. The status is a string, so a new value
    doesn't fail the parse.
- **The new methods join `SHAPES`:** `item/started`, `item/agentMessage/delta`,
  `item/reasoning/summaryTextDelta`, `item/commandExecution/outputDelta` and `turn/plan/updated`.
- **`RUNTIME_SCHEMAS` gains these rows:**
  - `ItemStarted` → `v2/ItemStartedNotification`
  - `AgentMessageDelta` → `v2/AgentMessageDeltaNotification`
  - `ReasoningSummaryDelta` → `v2/ReasoningSummaryTextDeltaNotification`
  - `CommandOutputDelta` → `v2/CommandExecutionOutputDeltaNotification`
  - `TurnPlanUpdated` → `v2/TurnPlanUpdatedNotification`

  `CODEX_SEED_TYPES` needs nothing new: the `ServerNotification` root already reaches all five.
- **`codex-tool-calls.ts`:**
  - `codexToolCalls(item: unknown, times: { readonly startedAtMs: number; readonly completedAtMs: number | null }): readonly ToolCallView[]`
    returns `[]` for an item that isn't a tool call.
  - `withCommandOutput(call: ToolCallView, delta: string): ToolCallView` changes only a `command`: it appends to
    the tail, keeps the last `OUTPUT_TAIL_CHARS` and adds the delta's UTF-8 bytes.
  - `codexPlanSteps(plan): readonly PlanStep[]`: `inProgress` becomes `in_progress`, and an unknown status
    becomes `pending`.
- **`CodexTurnState` gains:**
  - `texts: Map<string, number>`
  - `reasoning: Map<string, { length: number; summaryIndex: number }>`
  - `calls: Map<string, readonly ToolCallView[]>`

  All three are cleared at `turn/started`.

**The item table:**

| item | `ToolCallView` | `harnessTool` |
| --- | --- | --- |
| `commandExecution` | `command` (`cwd`, `exitCode`, `durationMs` from the item, the tail from `aggregatedOutput`) | `command` |
| … whose `commandActions` is one `read` | `read { path }` (call 8) | `command` |
| … whose `commandActions` is one `search` | `search { pattern: query ?? command, paths: path ? [path] : null }` | `command` |
| `fileChange` | one `edit` per change, id `<id>:<i>` (call 7). `kind.type` maps to `add`, `delete` or `update`, and `move` when `move_path` is set. Hunks are `hunksOfPatch(diff)`; when that is null, `hunksOfTexts('', diff)` for an add, `hunksOfTexts(diff, '')` for a delete, and `[]` for an update | `apply_patch` |
| `mcpToolCall` | `mcp`, with `resultTail` from `result.content` text blocks and `error` from `error.message` | `` `${server}.${tool}` `` |
| `webSearch` | `web`, with `query`, and `url` from an `openPage` or `findInPage` action | `web_search` |
| `collabAgentToolCall` with `tool: 'spawnAgent'` | `subagent`, `agent: 'subagent'`, `promptPreview` and `model` | `spawnAgent` |
| `collabAgentToolCall`, any other tool | `other` | its `tool` |
| `dynamicToolCall` | `other`, `name` = its `tool` | its `tool` |
| `imageView` | `read { path }` | `view_image` |
| anything else | none | — |

Status (call 12):

- `inProgress` is `running`.
- `completed` is `done`, or `failed` for a command with a non-zero exit code.
- `failed` and `interrupted` are `failed`.
- `declined` is `denied`. `refusal` and `deniedBy` stay null: the Codex item doesn't say whether the guard
  socket or the builder declined it (call 21).

**Changes to `mapCodexNotification`:**

- `item/started` of a tool item stores its calls and emits one `tool_call` (`running`) each.
- `item/agentMessage/delta` gives a `text_delta`, with `offset` from `texts`.
- `item/reasoning/summaryTextDelta` gives a `reasoning_delta`. A higher `summaryIndex` on a non-empty item
  prefixes `\n\n` (call 13).
- `item/commandExecution/outputDelta` gives `tool_call` with `withCommandOutput` and `appended: delta`. An unknown
  item gives `[]`.
- `turn/plan/updated` gives `plan_update`.
- **`item/completed`:**
  - **A tool item** gives its final `tool_call`(s). Each one's id is kept, and `startedAt` comes from the stored
    call, else from the item's `startedAtMs`, else from `completedAtMs`. A command keeps its streamed tail when
    `aggregatedOutput` is null.
  - **An `agentMessage`** adds `message { itemId: item.id, text }`, beside today's `lastText` and `activity` text.
  - Today's `activity` tool events for commands, patches and MCP calls are no longer emitted.

- [ ] **Step 1: Write the failing protocol tests.**
  - **`codex-protocol.test.ts`.** Add one type line per new row, in M1's direction:
    `expectTypeOf<Wire<ItemStartedNotification>>().toExtend<z.input<typeof ItemStarted>>()`, and so on for the five.
    Add the five rows to `ROWS`.
  - Run `pnpm --filter @10db/daemon typecheck`. Expected: FAIL, because the runtime schemas don't exist.

- [ ] **Step 2: Add the five runtime schemas and the `RUNTIME_SCHEMAS` rows, then regenerate on a Mac.**

Run: `pnpm --filter @10db/daemon generate:codex && pnpm --filter @10db/daemon drift && pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/daemon exec vitest run src/sessions/codex-protocol.test.ts`
Expected: PASS. The sampled fixtures of every `ThreadItem` branch parse with the loose `ItemStarted`.

- [ ] **Step 3: Write the failing mapping tests.**
  - **`codex-tool-calls.test.ts`:** one row per item-table line and status rule, plus these:
    - an `add` whose diff is plain text
    - an `update` with `move_path`
    - `withCommandOutput` over 10,000 characters
    - `withCommandOutput` on an `edit`, which is unchanged
    - **every sampled payload** in `codex-generated/fixtures/ItemStartedNotification.json` and
      `ItemCompletedNotification.json`, read through `codexToolCalls(payload.item, …)`:
      - each `commandExecution` gives at least one call of kind `command`, `read` or `search`, with a non-empty
        `command`, `path` or `pattern`
      - each `fileChange` with changes gives one `edit` per change, each with a non-empty `path`
      - each `mcpToolCall` gives one `mcp` call with a non-empty `server` and `tool`

      Mutating `codexToolCalls` to return `[]` for any of these types makes its rows fail.
  - **`codex-mapping.test.ts`:**
    - **Rewrite the rows "a command", "a patch" and "an MCP call"** to expect `tool_call` events.
    - **A command's whole life:** `started`, two deltas (each carrying `appended`), then `completed`. The
      `tool_call` statuses are `running`, `running`, `running`, `done`, and the tail is the deltas' text.
    - **Two agent-message deltas, `é` then `😀x`:** offsets 0 and 1, then `message` `é😀x` on completion.
    - **Reasoning across `summaryIndex` 0 and 1:** the second part's first delta starts with `\n\n`.
    - **A `turn/plan/updated`** gives a `plan_update`.
    - **A tool item completed with no `item/started`** gives one final `tool_call`.
    - **An unknown item's output delta** gives `[]`.

- [ ] **Step 4: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-tool-calls.test.ts src/sessions/codex-mapping.test.ts`
Expected: FAIL. `./codex-tool-calls` is missing, and the old rows still emit `activity`.

- [ ] **Step 5: Implement.**

- [ ] **Step 6: Run the Codex suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-tool-calls.test.ts src/sessions/codex-mapping.test.ts src/sessions/codex-session.test.ts src/sessions/codex-adapter.test.ts src/sessions/codex-protocol.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/sessions/codex-protocol.ts apps/daemon/src/sessions/codex-tool-calls.ts apps/daemon/src/sessions/codex-tool-calls.test.ts apps/daemon/src/sessions/codex-mapping.ts apps/daemon/src/sessions/codex-mapping.test.ts apps/daemon/src/sessions/codex-generated apps/daemon/src/sessions/codex-protocol.test.ts apps/daemon/scripts/codex-generate.ts && git commit -m 'feat(daemon): Codex sessions stream text and reasoning, and report typed tool calls and plan steps

Value: protects=Codex streaming per spec 5.5: delta offsets, a command'"'"'s output from start to end, one edit per changed file with hunks, plan steps; fails_when=an offset drifts, the tail grows past 4 KB, a non-diff add throws, a fileChange loses a file, or a late item/completed emits nothing; why_new=Codex reported only item/completed as activity; no_claim=that the pinned Codex sends these payloads (the live test, Task 10)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 9: Codex commands: the list, and `/compact` and `/review` sent as their calls

Concurrent state in `codex-session.ts`: take each step red first.

**Files:**

- Create: `apps/daemon/src/sessions/codex-commands.ts`, `apps/daemon/src/sessions/codex-commands.test.ts`
- Modify: `apps/daemon/src/sessions/codex-session.ts` (`Outgoing` at `:118`, `deliver` at `:637`, `send` at
  `:894`, the `started` push at `:851`), `codex-session.test.ts`
- Modify: `codex-protocol.ts`:
  - `ReviewStarted`: `{ turn }`, loose
  - `CompactStarted`: `z.looseObject({})`
- Modify: `codex-protocol.test.ts` (two type lines and two `ROWS`)
- Modify: `apps/daemon/scripts/codex-generate.ts`:
  - `CODEX_SEED_TYPES` gains `v2/ReviewStartResponse` and `v2/ThreadCompactStartResponse`, because no root reaches
    a response
  - `RUNTIME_SCHEMAS` gains `ReviewStarted` → `v2/ReviewStartResponse` and
    `CompactStarted` → `v2/ThreadCompactStartResponse`

  Then regenerate on a Mac, as in Task 8, Step 2.

**Interfaces:**

- Produces:
  - **`CODEX_COMMANDS: readonly AgentCommand[]`:**
    - `{ name: 'compact', description: 'Summarize the conversation so far to free context' }`
    - `{ name: 'review', description: 'Review the changes in the checkout', argumentHint: '[instructions]' }`
    - `{ name: 'model', description: 'Choose the model for the next turn' }`
  - **`type CodexCommandCall`:**
    - `{ readonly method: 'thread/compact/start' }`
    - or `{ readonly method: 'review/start'; readonly target: { readonly type: 'uncommittedChanges' } | { readonly type: 'custom'; readonly instructions: string } }`
  - **`codexCommandOf(text: string): CodexCommandCall | null`.** It reads the trimmed text's first word, matched
    case-sensitively:
    - `/compact` maps to compact, whatever follows.
    - `/review` maps to `uncommittedChanges`, or to `custom` with the rest when the rest is not empty.
    - Anything else, `/model` included, is null (call 16).
- **The session.**
  - `Outgoing` gains `command: CodexCommandCall | null`, set by `send` through `codexCommandOf`.
  - **In `deliver`, a command waits for the active turn to end and never steers.** Because sends are chained, every
    later message waits behind it. It then calls its method with the thread id: `review/start` with `target` and
    `delivery: 'inline'`.
    - `review/start`'s reply turn is handled as `startTurn`'s is (`startTurn` at `:502`, its turn bookkeeping at `:531`).
    - After the call answers, accepted or refused, a uuid gives `consumed [uuid]`.
    - A refusal is logged at `warn` with the method only.
  - **After `started`** the session pushes `commands(CODEX_COMMANDS)`.
  - **An interrupt's receipt** names a held command in `stillQueued`, as it does any held message.

- [ ] **Step 0: Add the two response schemas the same way as Task 8, Steps 1-2.** The type lines go red first,
  then regenerate.

- [ ] **Step 1: Write the failing pure table** in `codex-commands.test.ts`. Rows:
  - `/compact` gives compact
  - `'  /compact  '` gives compact
  - `/compact now` gives compact
  - `/review` gives `uncommittedChanges`
  - `/review focus on auth` gives `custom 'focus on auth'`
  - `/model` gives null
  - `/Compact` gives null
  - `please /compact` gives null
  - `/unknown` gives null

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-commands.test.ts`
Expected: FAIL, because the module is missing. Implement `codex-commands.ts`. Run: PASS.

- [ ] **Step 2: Write the first failing session row** in `codex-session.test.ts`, on its fake app server. After
  `started`, the session emits `commands` equal to `CODEX_COMMANDS`. Run it: FAIL. Implement the push. Run: PASS.

- [ ] **Step 3: Write the second failing session row.** Between turns, `send('/compact', [], U1)` makes exactly one
  `thread/compact/start` request with the thread id, sends no `turn/start`, and emits `consumed [U1]`. Run it:
  FAIL. Implement the command path in `deliver`. Run: PASS.

- [ ] **Step 4: Write the third failing session row.** During a turn, `send('/review focus', [], U2)` sends no
  `turn/steer`. After the fake server sends `turn/completed`, it sends one `review/start` with
  `target: { type: 'custom', instructions: 'focus' }`. A message sent after it reaches Codex after the review
  request. Run it: FAIL, because it steers. Implement the wait. Run: PASS.

- [ ] **Step 5: Write the last two session rows, each proved red by a named mutation.**
  - **An interrupt during the turn names `U2` in `stillQueued`**, and the review is sent once the turn ends, never
    twice. Run it: it should pass, because the held command is in `waiting`. Mutate `send` so a command never
    enters `waiting`, run it, and watch it FAIL with `U2` missing from `stillQueued`. Revert.
  - **`send('/model', [], U3)` goes out as a `turn/start`** with that text and `clientUserMessageId: U3`. Mutate
    `codexCommandOf` to map `/model` to compact, run it, and watch it FAIL with a `thread/compact/start`. Revert.

  The commit body names both mutations.

- [ ] **Step 6: Run the Codex suites**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-commands.test.ts src/sessions/codex-session.test.ts src/sessions/codex-mapping.test.ts src/sessions/codex-guard.test.ts`
Expected: PASS, with every existing `codex-session.test.ts` row unchanged.

- [ ] **Step 7: Commit**

```bash
git add apps/daemon/src/sessions/codex-commands.ts apps/daemon/src/sessions/codex-commands.test.ts apps/daemon/src/sessions/codex-session.ts apps/daemon/src/sessions/codex-session.test.ts apps/daemon/src/sessions/codex-protocol.ts apps/daemon/src/sessions/codex-protocol.test.ts apps/daemon/scripts/codex-generate.ts apps/daemon/src/sessions/codex-generated && git commit -m 'feat(daemon): a Codex session lists its commands and sends /compact and /review as their calls

Value: protects=the Codex command map of spec 5.5 and its delivery: a command never steers, waits for the turn, keeps order and is reported consumed; fails_when=a command goes to the model as text, steers a running turn, overtakes a later message, or is sent twice after an interrupt; why_new=Codex had no command path; no_claim=that the composer offers them (M5a)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 10: Retire `activity` tool events, the docs, the decision and the live checks

**Files:**

- Modify: `apps/daemon/src/sessions/types.ts`, where `activity` becomes
  `{ type: 'activity'; kind: 'text'; summary: string }` (call 17)
- Modify: `apps/daemon/src/sessions/tool-target.ts`, removing `claudeToolTarget`, `codexCommandTarget`,
  `codexPatchTarget`, `WRITERS` and `AIMED`, and `tool-target.test.ts`, removing their rows. Task 4's rows cover
  each one.
- Modify: `apps/daemon/src/runner/runner.ts`, where the `activity` case passes `tool: null`
- Modify: `apps/daemon/src/pictures/before-rule.ts:33` (its comment cites the removed functions)
- Modify: `apps/daemon/src/sessions/claude-adapter.live.test.ts`, `apps/daemon/test/codex.live.test.ts`
- Create: `docs/architecture/decisions/./2026-11-12-agent-output-streams-as-live-frames.md`
- Modify: `apps/daemon/AGENTS.md`:
  - `:105`: the Codex mapping sentence, "`item/completed` is activity", becomes deltas, `tool_call` and
    `plan_update`
  - `:279`: the tool and its target come from `toolCallActivity` over `tool_call`
  - add the Claude streaming line under the Claude adapter's bullet

**Interfaces:** nothing new. Only removals.

- [ ] **Step 1: Remove the tool kind.** Delete the old functions and their rows, then run
  `pnpm --filter @10db/daemon typecheck && pnpm knip`. Expected: PASS. No file emits or reads `activity` tool.

- [ ] **Step 2: Add the live checks.** They are opt-in and run only with the env flag.
  - **Claude** (`TENDB_LIVE_CLAUDE=1`), on its existing one-turn session:
    - at least one `text_delta`
    - the deltas of the first `message`'s item concatenate to its text
    - a `commands` event naming `compact`
  - **Codex** (`TENDB_LIVE_CODEX=1`), on its existing turn that runs a command:
    - at least one `text_delta`, whose concatenation equals the `message`
    - the command's `tool_call` goes `running` → `done` with `exitCode: 0`
    - a `commands` event equal to `CODEX_COMMANDS`

  The builder runs these. List them in the PR body.

- [ ] **Step 3: Write the decision record**, `docs/architecture/decisions/./2026-11-12-agent-output-streams-as-live-frames.md`.
  Rename it to the day the PR opens if that is later.

```markdown
# Agent output streams as live frames that are never stored, and an early end keeps partial text

- **Date:** 2026-11-12

## Decision

- Both adapters stream. A session emits `text_delta` and `reasoning_delta` (`itemId`, `offset`, `text`), a
  `message` for each finished text item, a `tool_call` carrying a `ToolCallView` (`@10db/contracts`) from start to
  end, `commands` and `plan_update` (`apps/daemon/src/sessions/types.ts`). `offset` is the item's text length
  before the delta, so a reader drops a frame it has already applied.
- Claude Code streams through the Agent SDK's partial messages; Codex through `item/started`, the
  `item/*/delta` notifications and `item/completed`. A Codex plan's steps come from `turn/plan/updated`.
- Every edit becomes hunks with three lines of context (`sessions/hunks.ts`), cut past 1,500 changed lines. A
  written file's previous text is read only when it is a regular file inside the checkout, up to 1 MB
  (`sessions/before-text.ts`).
- The runner's live line and the files a turn touched come from `tool_call` alone, through
  `sessions/tool-target.ts`.
- A call's `harnessTool` is the agent's own name for the tool. A Codex command that only reads a file is shown as a
  `read` card, but its `harnessTool` stays `command`. The earlier picture rule (`pictures/before-rule.ts`) counts
  any command as a tool that may change a file, and a command that looks like a read can still write.
- A call the guard or the builder denied carries 10db's `refusal` and who denied it (`deniedBy`).
- Every Claude account kind (a Claude plan, Bedrock, an API key, a gateway) streams exactly as the plan does: the
  same SDK, the same options and the same events.
- These events reach the UI as `conversation.delta` frames, sent with `live: true`, never written to `events`
  and never advancing the replay seq, coalesced to one every 50 ms per item. Only finished items are stored. A turn
  that ends early (Stop, error, rate limit, restart) stores what streamed as an agent message marked partial, and
  its running tool calls as failed. The adapter events above are built with this record; the frames, the stored
  items and the partial capture are the conversation engine's
  (`docs/superpowers/specs/2026-11-11-10db-sessions-design.md` §6.3, §6.5), and until it lands the events are
  logged by id and size, never by text.

## Why

- Words that arrive only at a turn's end make a chat feel dead; streaming makes it feel alive (spec S9).
- Storing every delta would flood the events table and every replay; storing finished items keeps the store the
  size of the transcript.
- Dropping streamed text on Stop would throw away words the builder has already read, so an early end keeps them,
  marked partial.
- One `ToolCallView` for both agents gives one card and one diff path (S12). Codex patches and Claude edits both
  become hunks; a tail and a byte count keep each event small.
- Turned down: storing deltas and compacting later (the flood happens first), a second socket for live frames (one
  socket with a `live` flag keeps reconnect simple), and keeping the old `activity` tool events beside
  `tool_call` (two sources of the live line would drift).
```

- [ ] **Step 4: Update `apps/daemon/AGENTS.md`** as listed under Files.

- [ ] **Step 5: Run the checks for what changed**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions src/runner/pass-lane.test.ts src/runner/runner.test.ts src/shape src/pictures && pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/daemon typecheck && pnpm exec eslint apps/daemon/src packages/contracts/src && pnpm --filter ./tests/repo exec vitest run src/architecture-docs.test.ts src/agent-docs.test.ts`
Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/daemon/src/sessions/types.ts apps/daemon/src/sessions/tool-target.ts apps/daemon/src/sessions/tool-target.test.ts apps/daemon/src/runner/runner.ts apps/daemon/src/pictures/before-rule.ts apps/daemon/src/sessions/claude-adapter.live.test.ts apps/daemon/test/codex.live.test.ts docs/architecture/decisions/./2026-11-12-agent-output-streams-as-live-frames.md apps/daemon/AGENTS.md && git commit -m 'refactor(daemon): tool activity comes only from tool calls; record that agent output streams as live frames

Value: protects=streaming against the real pinned agents: Claude deltas that concatenate to the message and its commands, Codex deltas, a command call from running to done, and the Codex command list; fails_when=a pinned bump renames a stream event or an item field, or partial messages stop arriving; why_new=the mapping tables run on fixtures and builders, never on the real binaries; no_claim=anything while TENDB_LIVE_CLAUDE and TENDB_LIVE_CODEX are unset (opt-in, the builder runs them)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```


---

### Task 11: Run it, gate it, open the PR

**Files:** none new.

- [ ] **Step 1: Run the Workbench and Plan end to end on the fake.** The live line now comes from `tool_call`, and
  Plan's fake replies stream.

Run: `pnpm --filter @10db/desktop e2e -- workbench.spec.ts shape.spec.ts`
Expected: PASS.

- [ ] **Step 2: Run a dev daemon on the fake and read its log.** Start a pass page turn through `scripts/dev.sh`
  with `TENDB_FAKE_SCRIPTS`. Check that `daemon.log` has `session stream event` lines with ids and sizes, and no
  agent text.

- [ ] **Step 3: Review.** Dispatch `code-reviewer` (opus) with this plan, Tasks 1-10 and the base commit. Point it
  at Review Focus items 1 and 2 (the guarded read and the output cap). Round 1 lists every finding. Round 2 checks
  only those findings and what the fixes broke. Allow at most two fix rounds.

- [ ] **Step 4: Gate**

Run: `make gate`
Expected: `GATE PASS`. `make gate` includes the `STAMP` check.

- [ ] **Step 5: Open the PR**

```bash
git push -u origin feat/sessions-m2c && gh pr create --base main --title 'feat(daemon): sessions stream text and typed tool calls with hunks on Claude and Codex' --body 'Sessions M2c (docs/superpowers/specs/2026-11-11-10db-sessions-design.md §5.1, §5.2, §5.4, §5.5). Both adapters emit text and reasoning deltas, messages, ToolCallView tool calls with hunks, commands and plan steps; the runner'"'"'s live line comes from tool_call; Codex sends /compact and /review as their calls. The new events are only logged until M3 and M4b. Decision: docs/architecture/decisions/./2026-11-12-agent-output-streams-as-live-frames.md.

What you will see change:
- In a Codex Workbench thread, /compact and /review now run Codex'"'"'s compaction and review, not a message to the model.
- TodoWrite no longer moves the live line or a lane'"'"'s last-activity time; it becomes a plan update.
- A Codex command that only reads a file shows that file'"'"'s path on the live line, not the command'"'"'s first word.
- daemon.log gets a debug line per stream event (ids and sizes, never text).

For the builder to run (opt-in, one turn each): TENDB_LIVE_CLAUDE=1 and TENDB_LIVE_CODEX=1 live tests, which now check streaming.

🤖 Generated with [Claude Code](https://claude.com/claude-code)'
```

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| C1: check, then read, in `before-text.ts` | Task 3 is rewritten: one `O_NOFOLLOW` descriptor, `fstat` with the same dev and inode as the `lstat`, `nlink === 1` (call 20), the parent's realpath inside, a read from the descriptor. Three swap rows go through an injected `CheckoutFs`, and a `readFileSync` mutation proves them red. Global Constraints and Review Focus 1 are updated. |
| C2: before-text read too late on Claude | Task 5 adds `createBeforeTexts`, keyed by `tool_use_id`. Task 7 captures in `preToolUseHook` (`beforeCall`) before judging, with a row where the file is written before the frame arrives. |
| C3: unbounded `structuredPatch` | Task 2 adds `maxEditLength` and `timeout`, falling back to the whole text as added, `truncated`, with a 6,000-line row (call 22). |
| C4: "without throwing" can't go red | Task 8: every sampled command, fileChange and mcpToolCall gives a call of its kind with a non-empty field, proved by a mutation. |
| C5: Task 9 Step 5 passes at once | Two named mutations, each watched failing: a held command left out of `waiting`, and `/model` routed through `codexCommandOf`. |
| C6: the live checks have no value card | Task 10's commit carries one. |
| C7: `-t` skips the fake rows | Task 6, Step 2 runs the two files as separate commands. |
| C8: subagent assistant text becomes `message` | Task 7: frames with `parent_tool_use_id` set emit no `message`, with a mapping row. |
| C9: changes the builder will see | Task 11's PR body lists all four. |
| C10: why `harnessTool` stays `command`, and the Claude kinds | The decision record states both. |
| Spec field: `refusal` and `deniedBy` | Task 1 adds both fields, nullable, with a rejecting row. Task 5's `ClaudeDenial` sets them. Task 7's hook and bridge `onDenied` set them, with rows. The fake sets them (Task 6). Codex leaves them null (call 21). |
| Line ref: `startTurn` | Task 9 cites `codex-session.ts:502`. |
| Round 2, 1: `deniedBy` read every `canUseTool` deny as `builder` | `ToolDecision`'s deny branch gains a required `by`. The broker sets `builder` only on a card's Deny answer (`:423-426`). Every other deny is `10db`: the broker's own refusals, Plan's two, and the billing, probe and `complete` denies. Task 7 lists `permission-broker.ts` and the deny sites in Files. New rows: a protected-path deny gives `10db`, and a card deny gives `builder`. The fake and the bridge pass `decision.by` through. Call 21 and Task 1's field text are corrected. |
| Round 2, 2: the parent swapped out and back in `before-text.ts` | Task 3: the parent's realpath is taken first, and checked again after the read. Both must be inside the checkout and equal. The file is reached and opened as `<realParent>/<basename>` with `O_NOFOLLOW`, and the descriptor's `dev` must equal the checkout's. Two new `CheckoutFs` rows (swap out then back, and a parent that differs after the read), and a second mutation that proves the swap-back row red. |

### Coordinator's follow-up (after round 2, not blocking)

**The residual race.** `before-text.ts` can still race. An agent could swap a directory component *inside* `realParent`
for a link after the first `realpath`, then swap it back before the second. `O_NOFOLLOW` guards only the last
component, and an outside file on the same device passes the `dev` check.

**Why it doesn't block.** What leaks reaches only the builder's own cards and data folder. It never goes back to
the agent.

**The fix.** Close it with one of these:

- Walk the path from the checkout's descriptor, one component at a time, with `O_NOFOLLOW` (this needs a small
  native helper, since Node has no `openat`).
- For a tracked file, take the before-text from git (`git show HEAD:<path>` plus the index), which reads no
  agent-writable link.

Filed as a QA item for the M2c review.
