# Plan: approvals become precedent (P1)

**Size: Core** (the guard's judge and a permission the builder gives). Spec:
`docs/superpowers/specs/2026-11-25-failures-reach-you-only-when-you-can-act-design.md`, sections "Precedent",
"Provider parity" and "Trust". Decision:
`docs/architecture/decisions/2026-11-25-a-standing-approval-is-a-precedent-the-judge-weighs.md`.

## Brief

The spec's brief stands. This milestone builds its first point:

- The judge is shown `make t`'s recipe again (the Makefile reader dropped a recipe inside `ifdef`; running as
  tsk_01a2149e).
- One Inbox card per project proposes the kinds of command the judge keeps doubting. You approve, decline or
  report each, once.
- An approved kind is a standing approval the judge reads on every later call. It can't clear a limit.
- Settings › This Project › Trust lists standing approvals, with their uses and Remove.
- The skip card gains **Run and Make Routine**.

**It buys:** the 106 doubt skips and 77 low-floor allows of 24–25 Nov stop needing you per call, if the judge's
model reads `precedent_applies` well, which is unverified until the replay has the cases.
**Could go wrong:** a kind too broad. The limits are read first, the ceiling is one half, and three conflicts
pause it. **You might disagree with:** P1 retries nothing by itself (F2 does); Report to 10db only copies the
report until F2. **Needed from you:** screenshots of the card and the Settings list are shown before task 6
merges.

## Global Constraints

- The root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/daemon/src/trust/AGENTS.md`,
  `apps/daemon/src/inbox/AGENTS.md`; `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **A limit is read before a precedent, always.** No code path allows a call because text matched. The program
  key only picks which precedent the judge is shown. Nothing here writes a `trust_grants` row.
- **Auto mode gets no allow line, and 10db's judge gets no policy line.** A precedent reaches Claude's auto mode
  only through `TrustPolicy.autoModePrecedents`, which only `renderClaudeAutoMode` reads. `TrustPolicy.allow`
  and `TrustPolicy.environment` are untouched, so `stateOf` never carries a precedent line.
- **Only 10db's judge's rows make a candidate:** a skip with `source = 'tendb_judge'` and no limit, or a
  `crosses_limit` row answered `unsure`. An auto mode denial never does.
- **A precedent is withheld, never refused on:** no key, `CallRuns.differs`, or a changed `package.json` for a
  package runner's key, sends the call to the judge as it is judged today.
- **Examples are the agent's text.** They are quoted as JSON wherever a judge reads them, capped at 200
  characters, and never hold `$defaults` (the rule `grantTargetOf` keeps).
- **Nothing waits on the builder.** A paused, declined or revoked precedent returns calls to today's judging.
- The precedent's row is written in the same write as the answer that made it. Every write that rewords the card
  reads `listPrecedents` inside that write.
- P1 retries no run and files no task.
- One migration (`trust_precedents`; `judge_calls.precedent_id` and `program_key`; `skipped_actions.program_key`).
  Task 2 generates it so Track B's pull request is green in CI; task 7 regenerates it after the final merge of
  `main`. Before task 2 generates, check no other open pull request adds a migration.
- Tests: only those named on the cards.

## Provider parity

| | Claude plan | Bedrock or API key | ChatGPT/Codex plan |
| --- | --- | --- | --- |
| Reads a precedent | auto mode, as context lines from `autoModePrecedents`; 10db's judge where the session is on it | API key: same. Bedrock: auto mode only on a pinned model that has it (`auto-mode-models.ts`); else 10db's judge | 10db's hook judge |
| Limit-first reading, ceiling, uses, conflicts, candidates | 10db's judge only; auto mode's own denies are unchanged | same | 10db's judge |
| Remove takes effect | 10db's judge: the next call. Auto mode: the session's next start | same | the next call |
| No Decisions account | no rows of 10db's judge, so no card; Settings says standing approvals need a Decisions account | same | same |
| Card, Settings list, Remove | same | same | same |

## Interfaces

```ts
// packages/contracts/src/ids.ts
TrustPrecedent: idSchema(['tpd'], 'TrustPrecedentId')

// packages/contracts/src/trust-policy.ts
export const PrecedentScope = { Copy: 'copy', Project: 'project' } as const; // project covers copies too
export type PrecedentScope = (typeof PrecedentScope)[keyof typeof PrecedentScope];
export const PrecedentState = { Active: 'active', Paused: 'paused', Declined: 'declined', Revoked: 'revoked' } as const;
export type PrecedentState = (typeof PrecedentState)[keyof typeof PrecedentState];
export const PrecedentChoice = { Approve: 'approve', KeepSkipping: 'keep_skipping', Report: 'report' } as const;
export type PrecedentChoice = (typeof PrecedentChoice)[keyof typeof PrecedentChoice];
export const PRECEDENT_KIND_MAX = 200;
export const PRECEDENT_EXAMPLE_MAX = 200;
export const PRECEDENT_EXAMPLES_MAX = 5;
export const PROGRAM_KEY_MAX = 300;
// Each is GrantTarget's chain with its own bound: trim, min 1, max, one line (no Cc, Cf, U+2028, U+2029), no `$defaults`.
export const PrecedentKind = /* … */.max(PRECEDENT_KIND_MAX);
export const PrecedentExample = /* … */.max(PRECEDENT_EXAMPLE_MAX);
export const ProgramKey = /* … */.max(PROGRAM_KEY_MAX);
/** Drops any naming `$defaults`, turns each run of refused characters into a space, trims, cuts to 200, keeps what `PrecedentExample` accepts, keeps 5. Never throws; idempotent. */
export function fitPrecedentExamples(raw: readonly string[]): string[];
export const TrustPrecedentDto = z.object({
  id: TrustPrecedentId, projectId: ProjectId,
  programKey: ProgramKey, scope: z.enum(PrecedentScope),
  kind: PrecedentKind,
  examples: z.array(PrecedentExample).max(PRECEDENT_EXAMPLES_MAX),
  runsHash: z.string().nullable(), state: z.enum(PrecedentState),
  uses: z.number().int(), lastUsedAt: z.string().nullable(), conflicts: z.number().int(),
  sourceInboxId: InboxItemId.nullable(),
  approvedAt: z.string().nullable(), // set on every move to active; null for a kind only ever declined
  createdAt: z.string(), endedAt: z.string().nullable(),
});
export const PrecedentCandidateDto = z.object({
  programKey: z.string(), scope: z.enum(PrecedentScope), kind: z.string(),
  examples: z.array(z.string()), runs: z.string().nullable(), runsHash: z.string().nullable(), // raw summaries, fitted on approval
  skips: z.number().int(), runCount: z.number().int(), taskCount: z.number().int(),
  topWorry: z.object({ limit: z.enum(LimitName), p: z.number() }).nullable(),
  stoppedAtLimit: z.array(z.string()),
});
export const PrecedentAnswer = z.object({
  kinds: z.array(z.object({
    programKey: z.string().min(1), scope: z.enum(PrecedentScope),
    choice: z.enum(PrecedentChoice),
    kind: PrecedentKind.optional(),
  })).min(1).max(50),
});
export const PrecedentPatch = z.object({
  state: z.enum([PrecedentState.Active, PrecedentState.Revoked]).optional(), // active approves again, from any state
  kind: PrecedentKind.optional(),
  runsHash: z.string().optional(), // Keep on the changed-script notice
});
export const PrecedentAllowedCall = z.object({ call: z.string(), at: z.string() });
export const ProjectPrecedentsDto = z.object({
  precedents: z.array(TrustPrecedentDto.extend({ lastAllowed: z.array(PrecedentAllowedCall).max(5) })), // every state
  candidates: z.array(PrecedentCandidateDto),
});
// JudgeCallDto gains: precedentId: TrustPrecedentId.nullable(); programKey: z.string().nullable()
// SkippedActionDto gains: programKey: z.string().nullable()

// packages/db/src/store/trust-precedents.ts
export interface PrecedentInput {
  readonly projectId: ProjectId; readonly programKey: string; readonly scope: PrecedentScope;
  readonly kind: string; readonly examples: readonly string[]; readonly runsHash: string | null;
  readonly state: typeof PrecedentState.Active | typeof PrecedentState.Declined;
  readonly sourceInboxId: InboxItemId | null;
}
/** Inserts the row, or moves the one the project, key and scope already have to `input.state` with its kind, examples and hash; `active` sets conflicts to 0. */
// It fits the examples (drops any naming `$defaults`, flattens each to one line, cuts to 200, keeps what
// `PrecedentExample` accepts, keeps 5) and never refuses on them; a bad kind or key throws and stores nothing.
export function approvePrecedent(ctx: WriteContext, input: PrecedentInput): TrustPrecedentDto;
export function listPrecedents(db: DbReader, projectId: ProjectId): TrustPrecedentDto[];
export function setPrecedent(ctx: WriteContext, projectId: ProjectId, id: TrustPrecedentId, change: { state?: PrecedentState; kind?: string; runsHash?: string | null }): TrustPrecedentDto | null; // `active` resets conflicts
export function countPrecedentUse(ctx: WriteContext, id: TrustPrecedentId): void;
export function countPrecedentConflict(ctx: WriteContext, id: TrustPrecedentId): number; // the new count
export function lastAllowedByPrecedent(db: DbReader, id: TrustPrecedentId, limit: number): { call: string; at: string }[]; // from judge_calls.precedent_id

// packages/db/src/store/skipped-actions.ts, judge-calls.ts
// SkipInput gains: readonly programKey?: string | null   (written to skipped_actions.program_key)
export function listDoubtSkips(db: DbReader, projectId: ProjectId, since: string): DoubtSkip[]; // source tendb_judge, kind classifier, summary not cut, program_key set; each with limitName, workstreamId, taskId, inCopy
export function listUnclearLimitCalls(db: DbReader, projectId: ProjectId, since: string): UnclearCall[]; // crosses_limit, answer unsure, program_key set, joined to the project through workstream_id; each with the call's command, probabilities, workstreamId, taskId, inCopy

// apps/daemon/src/trust/program-key.ts
export function programKey(toolName: string, input: Readonly<Record<string, unknown>>, checkout: string, cwd: string): string | null;
/** The repository path of the package.json that names a package runner key's script, from `cwd` up to the checkout; null for any other key. */
export function keyPackageFile(key: string, checkout: string, cwd: string): string | null;

// apps/daemon/src/trust/call-runs.ts
export interface CallRuns { readonly runs: readonly RunText[]; readonly cut: boolean; readonly differs: boolean } // differs: a file the walk read is changed in, or new to, the checkout

// apps/daemon/src/trust/precedents.ts
export const PRECEDENT_LIMIT_CEILING = 0.5;
export const PRECEDENT_CONFLICTS_MAX = 3;
export const PRECEDENT_LINES_MAX = 30;
export interface ShownPrecedent { readonly id: TrustPrecedentId; readonly kind: string; readonly examples: readonly string[]; readonly approved: string; readonly changedSince: boolean; readonly hash: string | null } // `approved` is `approvedAt`'s day
/** The active row for the key: in a copy the `copy` row, else the `project` row; outside a copy the `project` row only. Null for a null key or `withheld`. */
export function precedentFor(precedents: readonly TrustPrecedentDto[], key: string | null, inCopy: boolean, hash: string | null, withheld: boolean): ShownPrecedent | null;
export function precedentLines(precedents: readonly TrustPrecedentDto[], inCopy: boolean): string[]; // for TrustPolicy.autoModePrecedents
export function runsHash(runs: CallRuns, packageScript: string | null): string | null;

// apps/daemon/src/trust/crosses-limit.ts
export const PRECEDENT_APPLIES = 'precedent_applies';
// CrossesLimitRequest gains:   readonly precedent?: ShownPrecedent; readonly programKey?: string | null;
// LimitReading's allow gains:  by: 'answers' | 'builder' | 'precedent'
// LimitVerdict's allow gains:  by: 'fast_path' | 'model' | 'precedent'
// LimitVerdict's limit gains:  readonly precedentConflict?: true
export function readLimitAnswers(probabilities: Readonly<Record<string, number>>, floor: number): LimitReading; // unchanged signature

// apps/daemon/src/judge/judge.ts
// AssessReading gains:   readonly byPrecedent?: true;
// the assess request gains: readonly precedentId?: TrustPrecedentId; readonly programKey?: string | null;
//   programKey is written on every row; precedentId only on a row whose reading has byPrecedent.

// apps/daemon/src/inbox/hook-judge.ts — HookJudgeContext gains:
readonly precedents: () => readonly TrustPrecedentDto[];
readonly inCopy: boolean;
readonly onPrecedentPaused: (id: TrustPrecedentId) => void; // task 5 raises the conflict card
readonly onPrecedentChanged: (id: TrustPrecedentId, hash: string) => void; // task 5 posts the notice; called once per id and hash per session

// apps/daemon/src/trust/policy.ts
// TrustPolicyInput gains: readonly precedents?: readonly string[];
// packages/contracts/src/trust-policy.ts — TrustPolicy gains: autoModePrecedents: z.array(z.string()).max(30).default([])
//   buildTrustPolicy copies the input there, never into `allow` or `environment`.
// apps/daemon/src/sessions/claude-auto-mode.ts — renderClaudeAutoMode appends policy.autoModePrecedents to the
//   environment it renders; nothing else reads the field (stateOf in crosses-limit.ts does not).

// apps/daemon/src/trust/precedent-candidates.ts
export const PRECEDENT_MIN_SKIPS = 3;
export const PRECEDENT_MIN_RUNS = 2;
export const PRECEDENT_WINDOW_DAYS = 14;
export const PRECEDENT_REFRESH_MS = 60 * 60_000;
export function precedentCandidates(db: DbReader, projectId: ProjectId, now: Date, read: CommittedReader | null): Promise<PrecedentCandidateDto[]>;

// apps/daemon/src/inbox/precedent-card.ts
export const precedentFoldKey = (projectId: ProjectId): string => `precedent:${projectId}`;
/** Raises, rewords or resolves the card; drops every candidate whose key and scope have a row, read inside this write. */
export function refreshPrecedentCard(ctx: WriteContext, projectId: ProjectId, candidates: readonly PrecedentCandidateDto[]): void;
export function applyPrecedentAnswer(ctx: WriteContext, projectId: ProjectId, answer: PrecedentAnswer, candidates: readonly PrecedentCandidateDto[]): TrustPrecedentDto[];

// HTTP (apps/daemon/src/daemon/trust-services.ts)
// GET   /projects/:id/precedents            -> ProjectPrecedentsDto
// POST  /projects/:id/precedents/answer     body PrecedentAnswer
// PATCH /projects/:id/precedents/:pid       body PrecedentPatch
```

## State table (design, not a test list)

| State | Event | Next |
| --- | --- | --- |
| No candidate | a key reaches 3 skips in 2 runs, or stopped a run, or was approved once with Run these now | the card is raised or reworded |
| Offered | Approve | an `active` row; the kind leaves the card; the card resolves when it lists none |
| Offered | Keep Skipping | a `declined` row; the kind leaves the card |
| Offered | Report | the report is copied; the kind stays |
| Offered | 14 days with no new skip, seen at the hourly refresh | the kind leaves the card |
| Offered | a refresh computed before an answer writes after it | it filters against the rows inside its write; the answered kind stays off |
| Declined, revoked | Approve in Settings, or Run and Make Routine | `active` with the new examples and hash, conflicts 0 |
| Active | a call of the kind; every limit under one half; `precedent_applies` ≥ f | allow by precedent; `uses` + 1; the row's `precedent_id` |
| Active | a freshly judged call of the kind; a limit ≥ f | that limit; `conflicts` + 1; at 3, `paused` and the conflict card |
| Active | the same stopped call again in the session | answered from memory; nothing counted |
| Active | a call of the kind; the top limit from one half to f | unclear: the second opinion, same state |
| Active | `CallRuns.differs`, a changed `package.json` for a runner's key, or no key | not shown; judged as today |
| Active | the committed text's hash differs from `runs_hash` | shown with `changed_since`; a notice with Remove and Keep |
| Active, paused | Remove | `revoked`; 10db's judge's memory key changes, so its next call is judged afresh; a running auto mode session keeps the line until its next start |
| Paused | Keep or Edit | `active`, conflicts 0 |
| Any | two answers race | the unique index keeps one row; the second reads it |
| Any | the daemon restarts | the card is recomputed from rows at start |

## Tracks and tasks

Track A is filed and running as its own 10db task, tsk_01a2149e, and is not built from this plan; its card is
kept as that task's record. Track B is in order, one implementer per card.

| # | Track | Task | Size |
| --- | --- | --- | --- |
| 1 | A | The Makefile reader keeps a recipe inside a conditional (tsk_01a2149e, running) | Core (the judge's reader), small |
| 2 | B | Contracts, the `trust_precedents` store, the `program_key` columns, the migration | Core |
| 3 | B | `programKey` | Core (a pure parser) |
| 4 | B | The judge reads a precedent: the question, the reading, the hook judge, the allow lines | Core |
| 5 | B | Candidates, the card, its answer, Run and Make Routine, the conflict card, the routes | Core (a permission) |
| 6 | B | Desktop: the card, Standing Approvals, the decision label; the trust e2e extended | Feature |
| 7 | B | The migration regenerated after the final merge; module notes | Small |
