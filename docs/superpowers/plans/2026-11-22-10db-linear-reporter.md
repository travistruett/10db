# Plan: the Linear reporter

**Size:** Core (10db's Careful). It sends task data out of the laptop and adds a guard rule, so it gets this index,
one card per task and a plan review. Sub-steps inside a card (a route, a Settings row) get no process of their own.
**Spec:** `docs/superpowers/specs/2026-11-21-10db-linear-integration-design.md`: "Reporter" (every subsection),
"Data" (`linear_posts`), "Provider parity", "Sizes" item 3. Plus the two items moved here from part 2: the
per-project "How to update Linear" note and the reporter switch.
**Builds on:** part 2, `2026-11-21-10db-linear-link-and-import.md` (the binding, `tasks.external_*`,
`link_linear_team`).

## Brief

**What changes for you.** On a project linked to a Linear team, a task that carries a Linear issue keeps that issue
up to date:
- A run starting moves it to In Progress.
- A review verdict, a wait on you, the run's end and the PR opening or merging each get one comment with the
  attempt, the evidence and what is unverified.
- Once the PR opens, one "10db" link on the issue points at it.

You do nothing. The Linear card's project row in Settings › Integrations gains a **Report To Linear** switch and a
**How To Update Linear** note. Linking a team turns the switch on. The task drawer gains a **Linear** tab listing every update:
sent, waiting, withheld or failed.

**What it buys.** The pilot's hand steps are gone: no more copying the verification comment or moving the status
by hand.

**What could go wrong, and how we'd know.**
- **It writes to the wrong place.** The run starts in the wrong workspace, or it touches another issue. Its first
  step must report the workspace. 10db accepts that report only when the ids match the binding *and* appeared in
  a successful `get_workspace`/`get_team` result in that session. Until then every Linear write is refused.
  Afterwards it may write only the linked issue, named by Linear's own id (team keys repeat across workspaces),
  with an exact list of fields per tool. It reads no files, runs no commands, has no web, and any other MCP tool
  is denied. Card 2's rule table is the unit test. A refusal
  shows on the Linear tab and in the project's one Inbox item.
- **It leaks a secret.** Every Linear write's text is scanned with the outbound scan's secret patterns. A hit
  refuses the write, and the row is shown as withheld with the pattern's name.
- **It repeats itself.** Each comment carries a `10db · <event> · attempt N · <event id>` footer, and the brief
  makes the agent read the issue's comments first. A crash between posting and recording is recognized on the
  next run. That rests on the agent following its brief: a duplicate comment is the worst case, never a write
  elsewhere.
- **Linear or the account goes quiet.** A failed run retries with backoff (5 min, doubling up to 6 h), and after five
  tries the update is marked failed. One Inbox item per project counts what waits, failed or was withheld. Tasks
  are never held.
- **It claims too much.** It is handed 10db's recorded facts, never only the card's state. An open finding or a
  check that never ran is named and blocks Ready for Release. The wording is an agent's, by your earlier call.

**Calls you might disagree with.**
1. **The reporter is invisible.** It runs as its own kind of conversation, one per linked task, with no chat tab.
   A visible chat per update would bury your sessions. You see its results on the Linear tab, and its session ids
   are in the rows. Cost if wrong: a "show the reporter's transcript" link later.
2. **Report To Linear is on for a new link, and off for a project you linked before this lands.** Nothing posts to
   your Linear until you link a team or turn the switch on, so the first post is one you chose. Cost if wrong: one
   switch to flip on Ampsio.
3. **The reporter may only comment, set the status, and add one `10db` link** (`save_issue` with `id`, `state`
   and `links` only). It may not touch assignees, labels, parents or relations, and it never deletes. Linear's
   links are append-only, so the "10db" attachment is a link to the PR, added once, not a live card. The live
   state is in the comments. Cost if wrong: a later widening.
4. **10db uploads the screenshots itself**, to the signed URL Linear's `prepare_attachment_upload` returns (card 6).
   Pushing a PNG through the model as base64 would cost about a token per 3 bytes. 10db PUTs only to the signed
   URL of a `prepare_attachment_upload` call in that session, on Linear's storage host. Card 6 can be cut, and comments then go without pictures.
5. **A cancelled task keeps its Linear history,** and its cancel is reported like any other end. The spec said a
   deleted task's rows go too, but 10db never deletes tasks, only cancels them. There is also no way to unlink a
   task yet, so that spec row has nothing to act on.
6. **"Attempt N" is the run's number among the task's runs** (its workstream's position by creation, from 1). A
   Retry reuses its workstream, so it keeps its number.
7. **Each run is a short agent session on the project's account at its Efficient tier.** A busy task runs a few
   sessions a day; on a metered account they cost cents.

**What is needed from you.** Nothing to start. For the live QA once it lands: Ampsio linked to AMP (done in part 2,
or re-link), an optional note, and your agent signed in to Linear's workspace.

---

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the `AGENTS.md` of every
  directory you touch, once each. Keep notes in your scratch folder.
- **Live Linear is never called from an agent.** Agents never read 10db's ui-token, never write the real database
  (`~/Library/Application Support/10db`), and never sign in to anything. Tests use the fake adapter's scripted tool
  calls.
- **One migration, generated last.** Card 1 generates one migration to develop against. The coordinator deletes it
  and regenerates after the final merge of `main`; implementers never commit a second one.
- **No server-wide grant and no new trust switch.** Repo servers' grants stay bound to their hash. The reporter's
  own rule decides its Linear calls; nothing it adds reaches a chat or a lane.
- **The reporter is not a chat.** It is 10db's own errand. The chat judge decision
  (`decisions/2026-11-21-a-conversations-mcp-calls-go-to-its-judge.md`) does not apply to it, and its calls never go
  to a judge.
- Labels are Title Case (Knowledge rule pri_01a20402). Don't edit `views/sessions/plan/*`, `sessions-panel.tsx`,
  `from-linear-item.tsx` or `proposal-text.ts`: another session owns them.
- Tests: only those named on the card, each with a value card in its commit (`.claude/rules/testing.md`).
- While working, run `pnpm vitest related <files> --maxWorkers=2` plus typecheck and lint of the packages
  changed. Before you hand back, run `make precheck`. Never the full suite, never `make check-changed` (this is an
  integration branch). If lint runs out of memory, rerun it with `NODE_OPTIONS=--max-old-space-size=8192`.
- Commit after every green step, naming paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`.
- Use the clock injected through `Clock` (`apps/daemon/src/clock`), not `Date.now` or a bare `setTimeout`.

## Provider parity

| Account | Linear reached through | Linear tool prefix the guard matches | Signed out |
|---|---|---|---|
| Claude plan | claude.ai connector, or an `mcp.linear.app` entry | `mcp__claude_ai_Linear__`, or `mcp__<mcpToolPrefix(entry)>__` | run fails, retries; Inbox line is the sign-in row's `note` |
| Claude API key / Bedrock | `mcp.linear.app` entry | `mcp__<mcpToolPrefix(entry)>__` | same |
| ChatGPT/Codex plan | `codex mcp add` entry | `mcp__<entry>__` as Codex's hook names it (card 2 confirms against `codex-refused-calls.ts` and a real Codex if one is reachable; otherwise it is QA item 2) | same |

- Every provider runs the same rule: the reporter's own `preToolUse` (Claude's PreToolUse hook, Codex's
  hook socket to `judgeHookCall`). An allowed call is an explicit `allow`, so neither auto mode's classifier nor
  10db's judge sees it, and a refused call is a `deny`.
- The workspace is read from Linear's own tool result on every provider: from the session's `tool_call` events,
  which carry the MCP result for Claude and Codex alike. It is not read from Claude-only PostToolUse.
- On a Claude plan every connector loads (it can't be narrowed), so the rule denies every `mcp__` tool that is not
  Linear's or 10db's reporter tools. After a restart the connector list is unread, so the reporter treats an
  unchecked row as a maybe and goes ahead.
- Codex's web search runs at OpenAI with no hook call, so the reporter's Codex session sets `webSearch:
  'disabled'` whatever the Web switch says. On Claude the web tools are denied by the rule.
- Trust › **Your MCP servers** off (`trustSwitchesFor(...).yourMcpServers`) reads as the reporter off: pending
  rows are dropped and the card's row says why.

## Interfaces

```ts
// packages/contracts/src/ids.ts (card 1)
LinearPost: idSchema(['lnp'], 'LinearPostId') // ID_SCHEMAS, ID_PREFIX; export LinearPostId

// packages/contracts/src/conversation.ts (card 1)
export const ConversationOwnerKind = { Chat: 'chat', Task: 'task', Reporter: 'reporter' } as const;
// A reporter's conversation: ownerId is the TaskId; one per linked task, a new session per run.

// packages/contracts/src/linear-posts.ts (card 1)
export const LinearEventKind = {
  RunStarted: 'run_started', Waiting: 'waiting', Verdict: 'verdict',
  Ended: 'ended', PrOpened: 'pr_opened', PrMerged: 'pr_merged',
} as const;
export const LinearPostState = {
  Pending: 'pending', Recorded: 'recorded', Withheld: 'withheld', Failed: 'failed',
} as const;
export const LinearPostDto = z.strictObject({
  id: LinearPostId, taskId: TaskId, event: z.enum(LinearEventKind), attempt: z.number().int().min(1),
  /** What the event was: the verdict, the end state, the PR url, the Inbox card's title. */
  detail: z.record(z.string(), z.json()),
  state: z.enum(LinearPostState), tries: z.number().int().min(0),
  dueAt: z.iso.datetime().nullable(), lastError: z.string().nullable(), withheldPattern: z.string().nullable(),
  sessionId: SessionId.nullable(), commentIds: z.array(z.string()), statusSet: z.string().nullable(),
  attachmentUrl: z.string().nullable(), dismissedAt: z.iso.datetime().nullable(),
  createdAt: z.iso.datetime(), recordedAt: z.iso.datetime().nullable(),
});
/** `linear-reporter.<projectId>` in app_settings; absent reads as { on: false, note: '' }; a new link writes on. */
export const LinearReporterSettings = z.strictObject({ on: z.boolean(), note: z.string().max(4000) });
export const ReportLinearWorkspaceInput = z.strictObject({ workspaceId: z.string().min(1), teamId: z.string().min(1) });
export const ReportLinearPostInput = z.strictObject({
  postIds: z.array(LinearPostId).min(1),
  outcome: z.discriminatedUnion('state', [
    z.strictObject({ state: z.literal('recorded'), commentIds: z.array(z.string()),
      statusSet: z.string().nullable(), attachmentUrl: z.string().nullable() }),
    /** Only accepted when the guard refused a write with this pattern in this run. */
    z.strictObject({ state: z.literal('withheld'), pattern: z.string() }),
  ]),
});
// EventType.LinearPostChanged = 'linear_post.changed' (entityType 'task', entityId TaskId)

// packages/db/src/store/linear-posts.ts (card 1)
/** Inserts unless (taskId, dedupeKey) exists; returns the row or null for a repeat. */
export function enqueueLinearPost(ctx: WriteContext, input: {
  taskId: TaskId; projectId: ProjectId; event: LinearEventKind; dedupeKey: string; attempt: number;
  detail: Record<string, Json>; dueAt: string;
}): LinearPostDto | null;
export function listLinearPosts(db: DbReader, taskId: TaskId): LinearPostDto[];       // newest first
export function pendingLinearPosts(db: DbReader, filter?: { taskId?: TaskId; projectId?: ProjectId }): LinearPostDto[];
export function takeLinearPosts(ctx: WriteContext, ids: readonly LinearPostId[], sessionId: SessionId): void;
export function recordLinearPosts(ctx: WriteContext, ids: readonly LinearPostId[], outcome: ReportLinearPostInput['outcome']): void;
/** tries+1; at `maxTries` the row is failed, else due again at `dueAt`. */
export function failLinearPosts(ctx: WriteContext, ids: readonly LinearPostId[], error: string, dueAt: string, maxTries: number): void;
export function dropPendingLinearPosts(ctx: WriteContext, filter: { taskId?: TaskId; projectId?: ProjectId }): number;
export function dismissLinearPosts(ctx: WriteContext, projectId: ProjectId): void;   // failed + withheld, not yet dismissed
export function linearPostCounts(db: DbReader, projectId: ProjectId): { waiting: number; failed: number; withheld: number };
// waiting = pending with tries > 0; failed/withheld count undismissed rows only.

// apps/daemon/src/linear/reporter-guard.ts (card 2): pure
export interface ReporterRun {
  readonly linearPrefixes: readonly string[];         // e.g. ['mcp__claude_ai_Linear__']
  readonly binding: LinearBinding;
  readonly link: ExternalLink;                         // the task's
  workspaceConfirmed: boolean;
  readonly knownCommentIds: Set<string>;               // from this task's recorded rows, plus this run's
  readonly identityResults: string[];                  // successful whoami/get_workspace/get_team/list_teams result texts
  readonly uploads: { url: string; headers: Record<string, string>; assetUrl: string }[];  // card 7
  readonly withheld: Set<string>;                      // pattern names refused this run
}
/** Pure: card 4 applies `withheld` to the run. */
export function judgeReporterCall(run: Readonly<ReporterRun>, call: { toolName: string; input: unknown }):
  { verdict: GuardVerdict; withheld?: string };
export function confirmWorkspace(run: Readonly<ReporterRun>, input: ReportLinearWorkspaceInput):
  'confirmed' | 'not_seen' | 'mismatch';
export function linearToolPrefixes(via: { connector: boolean; entries: readonly string[]; harness: Provider }): string[];
/** The outbound scan's secret patterns only (no url, code_block, file_path). */
export function scanSecrets(text: string): string | null;                // first pattern name hit
// apps/daemon/src/stakeholders/outbound-scan.ts exports SECRET_PATTERN_NAMES (card 2)

// apps/daemon/src/linear/reporter-events.ts (card 3)
export function subscribeLinearEvents(bus: EventBus, deps: {
  state: StateStore; clock: Clock; reporter: Pick<LinearReporter, 'poke'>; log: Logger;
}): () => void;
/** The run's number among the task's runs (workstreams by created_at), from 1. */
export function attemptOf(db: DbReader, workstreamId: WorkstreamId): number;
/** Pure: which rows one event makes, from the event and what the listener read for it. */
export function linearRowOf(event: DaemonEvent, read: LinearEventRead): LinearRowDraft[];
/** Why the project doesn't report (no binding, switched off, Your MCP servers off), or null. */
export function reporterBlockedBy(db: DbReader, projectId: ProjectId): string | null;

// apps/daemon/src/linear/reporter.ts (card 4)
export interface LinearReporter {
  start(): void;                          // startup pickup: arms a timer per task with pending rows
  stop(): Promise<void>;                  // awaits in-flight settles
  poke(taskId: TaskId): void;             // a row was enqueued
  /** report_linear_workspace / report_linear_post, from a reporter session only. */
  reportWorkspace(sessionId: SessionId, input: ReportLinearWorkspaceInput): { ok: true };
  reportPost(sessionId: SessionId, input: ReportLinearPostInput): { ok: true };
  /** The reporter's preToolUse for its own session. */
  verdict(sessionId: SessionId, req: ShapeToolRequest): ShapeVerdict;
  /** A Linear tool result the session saw (tool_call event), for the workspace check and upload URLs. */
  observe(sessionId: SessionId, toolName: string, resultText: string): void;
  settings(projectId: ProjectId): LinearReporterSettings & { blockedBy: string | null };
  setSettings(projectId: ProjectId, input: LinearReporterSettings): void;   // off drops pending rows
}
export const REPORT_DELAY_MS = 30_000;
export const BACKOFF_MS = { first: 5 * 60_000, max: 6 * 60 * 60_000 } as const;
export const MAX_TRIES = 5;
export const RUN_DEADLINE_MS = 15 * 60_000;
export function createLinearReporter(deps: {
  state: StateStore; clock: Clock; log: Logger; dataDir: string;
  engine: Pick<ExploreEngine, 'queued' | 'retire' | 'unretire' | 'stop'>;
  conversations: { reporterOf(taskId: TaskId, projectId: ProjectId): ConversationId };  // get or create
  signIns: { list(): Promise<LinearSignInsDto> };
  inbox: InboxService;
}): LinearReporter;

// apps/daemon/src/conversation/explore-hooks.ts (card 4)
// ExploreLaunch gains: readonly observeToolCall?: (event: Extract<SessionEvent, { type: 'tool_call' }>) => void;

// packages/contracts/src/reporter-tools.ts (card 4; card 7 adds upload_linear_screen)
export const ReporterToolName = { ReportLinearWorkspace: 'report_linear_workspace', ReportLinearPost: 'report_linear_post' } as const;
// apps/daemon/src/mcp/server.ts: McpDeps gains `reporter?: Pick<LinearReporter, 'reportWorkspace' | 'reportPost'>`

// apps/daemon/src/linear/reporter-brief.ts (card 5): pure over read facts
/** The task, link, binding names, note, rows, and per workstream its report, verdicts, findings, evidence, gaps, PR and screens. */
export interface ReporterFacts { /* card 5 defines the fields */ }
export function reporterBrief(facts: ReporterFacts): string;
export function readReporterFacts(db: DbReader, dataDir: string, taskId: TaskId, posts: readonly LinearPostDto[]): ReporterFacts;

// apps/daemon/src/linear/reporter-inbox.ts (card 5)
export const linearReporterFoldKey = (projectId: ProjectId): string => `linear-reporter:${projectId}`;
export function refreshReporterCard(deps: { state: StateStore; inbox: InboxService }, projectId: ProjectId): void;

// API (card 6): GET /tasks/:taskId/linear-posts -> LinearPostDto[];
// GET/PUT /projects/:projectId/integrations/linear/reporter -> LinearReporterSettings & { blockedBy }
// 10db tool (card 7): upload_linear_screen({ screenId: TaskScreenId, uploadUrl: string, headers: Record<string,string> })
```

## State table (design, not a test list)

| State | Event | Next |
|---|---|---|
| idle | event on a linked task, reporter on | pending: row written, due in 30 s, unless a row of the task is due later on backoff, then that later time (card 3) |
| idle | event on an unlinked task, a task of an unbound project, reporter off, or Your MCP servers off | nothing written (card 3) |
| idle | the same event again (a repeat `batch.updated`, a second `step.changed` for one result) | nothing: the dedupe key exists (card 1, 3) |
| idle | a Retry of a FAILED run starts and ends DONE | two new rows: the keys carry the event's seq (card 3) |
| pending | due, no run for the task | running: takes every pending row of the task due now or earlier (card 4) |
| pending | due, account has no Linear (`LinearVia.None`, checked) | failure, as below; the Inbox line is the row's note (card 4) |
| pending | due, the sign-ins row is unchecked (after a restart) | runs: a maybe goes ahead (card 4) |
| running | new event | the row stays pending for the next run (card 4) |
| running | `report_linear_workspace` matches the binding and both ids were seen in successful identity results | writes open (card 2, 4) |
| running | the ids match but weren't seen yet | answered "not seen yet, call again"; writes stay refused (card 2, 4) |
| running | the ids don't match the binding | the reason "reaches <reported>, linked to <bound>" is kept; writes stay refused; the run fails at settle (card 2, 4) |
| running | a Linear write before the workspace is confirmed, to another issue, a relation field, a delete, or any other `mcp__` tool | denied with a reason; the run goes on (card 2) |
| running | a write's text hits a secret pattern | denied naming the pattern; the run records the row as withheld (card 2, 4) |
| running | `report_linear_post` for rows not taken by this session, or withheld with a pattern the guard didn't refuse | refused (card 4) |
| running | the turn ends | rows recorded or withheld stay so; unrecorded rows are withheld if the guard withheld a write, else they fail; the session closes off the effect chain (card 4) |
| running | the start fails, or the account pauses | settled from `onState` as a failure (card 4) |
| running | no turn end within 15 min | stopped; the rows fail (card 4) |
| running | the daemon stops | rows stay pending (the take only stamps the session); recovery cools the conversation, the rows are due now, and posts already made are found by their footer (card 4) |
| pending | failure, tries < 5 | due again after 5 min × 2^(tries−1), at most 6 h; the Inbox count rises (card 4, 5) |
| pending | its fifth failure | failed: shown on the Linear tab, counted in the Inbox (card 4, 5) |
| failed | a later event on the task | a new row starts fresh at tries 0 (card 3) |
| any | binding removed, reporter turned off, or Your MCP servers off at pickup | the project's pending rows are dropped; a running session's later writes are refused (card 3, 4) |
| any | task cancelled | nothing special: its workstream's CANCELLED end is reported, and its rows are kept (card 3) |
| any | task unlinked | no path exists yet (the link is written only at creation); nothing to do |
| any | the project has no waiting, failed or withheld rows left | the Inbox item is withdrawn (card 5) |
| any | the builder dismisses the Inbox item | the project's failed and withheld rows are marked dismissed and stop counting (card 5) |

## Tracks

Integration branch `feat/linear-reporter`, draft PR from the first push. Each implementer works in its own worktree
`../10db-worktrees/linear-reporter-<track>`, branched from the integration branch. The coordinator merges each card
in.

- **Track A** (sequential, worktree `linear-reporter-a`):
  - [Card 1](2026-11-22-10db-linear-reporter/task-1.md): contracts, the `linear_posts` table and store, the
    Reporter owner kind.
  - [Card 3](2026-11-22-10db-linear-reporter/task-3.md): events to rows, and the drop rules.
  - [Card 4](2026-11-22-10db-linear-reporter/task-4.md): the run: scheduler, the Reporter owner on the explore
    engine, its MCP subset and guard wiring, the two 10db tools, settle, startup pickup.
  - [Card 5](2026-11-22-10db-linear-reporter/task-5.md): what it is handed (the brief), the Inbox item, the
    decision record. *Review group 1: cards 1-5 with card 2.*
  - [Card 6](2026-11-22-10db-linear-reporter/task-6.md): Settings row, Linear tab, routes, the e2e extension,
    docs. Starts after #742 (Title Case sweep) lands and is merged in. *Review group 2.*
- **Track B** (worktree `linear-reporter-b`, beside track A from the start):
  - [Card 2](2026-11-22-10db-linear-reporter/task-2.md): the reporter's rule table, Linear tool naming per
    provider, secret-only scan. Pure, so it needs only card 1's contracts. It may start at once and stub the two
    zod types locally until card 1 merges.
  - [Card 7](2026-11-22-10db-linear-reporter/task-7.md): screenshots, uploaded by 10db to Linear's signed URL.
    After card 4. Cuttable. *Review group 3.*

Shared files: `linear/index.ts` and `daemon/start.ts` wiring (cards 3, 4, 5, 7). The coordinator merges them.
