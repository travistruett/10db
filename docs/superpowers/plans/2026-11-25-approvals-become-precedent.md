# Plan: approvals become precedent (P1)

**Size: Core** (the guard's judge and a permission the builder gives). Spec:
`docs/superpowers/specs/2026-11-25-failures-reach-you-only-when-you-can-act-design.md`, sections "Precedent",
"Provider parity" and "Trust". Decision:
`docs/architecture/decisions/2026-11-25-a-standing-approval-is-a-precedent-the-judge-weighs.md`.

## Brief

The spec's brief stands. This milestone builds its first point:

- The judge is shown `make t`'s recipe again (the Makefile reader dropped a recipe inside `ifdef`).
- One Inbox card per project proposes the kinds of command the judge keeps doubting. You approve, decline or
  report each, once.
- An approved kind is a standing approval the judge reads on every later call. It can't clear a limit.
- Settings › This Project › Trust lists standing approvals, with their uses and Remove.
- The skip card gains **Run and Make Routine**.

**It buys:** the 106 doubt skips and 77 low-floor allows of 24–25 Nov stop needing you per call.
**Could go wrong:** a kind too broad. The limits are read first, the ceiling is one half, and three conflicts
pause it. **You might disagree with:** P1 retries nothing by itself (F2 does); Report to 10db only copies the
report until F2. **Needed from you:** screenshots of the card and the Settings list are shown before task 6
merges.

## Global Constraints

- The root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/daemon/src/trust/AGENTS.md`,
  `apps/daemon/src/inbox/AGENTS.md`; `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **A limit is read before a precedent, always.** No code path allows a call because text matched. The program
  key only picks which precedent the judge is shown.
- **A precedent is withheld, never refused on:** no key, or `CallRuns.differs`, sends the call to the judge as it
  is judged today.
- **Examples are the agent's text.** They are quoted as JSON wherever a judge reads them, capped at 200
  characters, and never hold `$defaults` (the rule `grantTargetOf` keeps).
- **Nothing waits on the builder.** A paused, declined or revoked precedent returns calls to today's judging.
- The precedent's row is written in the same write as the answer that made it.
- P1 retries no run and files no task.
- One migration (`trust_precedents`, `judge_calls.precedent_id`), generated last, after the final merge of `main`
  (task 7).
- Tests: only those named on the cards.

## Provider parity

| | Claude plan | Bedrock or API key | ChatGPT/Codex plan |
| --- | --- | --- | --- |
| Reads a precedent | auto mode, as an allow line; 10db's judge where the lane is on it | same | 10db's hook judge |
| Limit-first reading, ceiling, uses, conflicts | 10db's judge only; auto mode's hard denies hold the limits | same | 10db's judge |
| No Decisions account | the row (auto mode reads it) and quoted-call grants for the examples; the card says kinds need a Decisions account off auto mode | same | quoted-call grants; the card says so |
| Card, Settings list, Remove | same | same | same |

## Interfaces

```ts
// packages/contracts/src/ids.ts
TrustPrecedent: idSchema(['tpr'], 'TrustPrecedentId')

// packages/contracts/src/trust-policy.ts
export const PrecedentScope = { Copy: 'copy', Project: 'project' } as const;
export const PrecedentState = { Active: 'active', Paused: 'paused', Declined: 'declined', Revoked: 'revoked' } as const;
export const PrecedentChoice = { Approve: 'approve', KeepSkipping: 'keep_skipping', Report: 'report' } as const;
export const PRECEDENT_KIND_MAX = 200;
export const PRECEDENT_EXAMPLE_MAX = 200;
export const PRECEDENT_EXAMPLES_MAX = 5;
export const TrustPrecedentDto = z.object({
  id: TrustPrecedentId, projectId: ProjectId,
  programKey: z.string().min(1).max(300), scope: z.enum(['copy', 'project']),
  kind: z.string().min(1).max(PRECEDENT_KIND_MAX),
  examples: z.array(z.string().max(PRECEDENT_EXAMPLE_MAX)).max(PRECEDENT_EXAMPLES_MAX),
  runsHash: z.string().nullable(), state: z.enum(['active', 'paused', 'declined', 'revoked']),
  uses: z.number().int(), lastUsedAt: z.string().nullable(), conflicts: z.number().int(),
  sourceInboxId: InboxItemId.nullable(), createdAt: z.string(), endedAt: z.string().nullable(),
});
export const PrecedentCandidateDto = z.object({
  programKey: z.string(), scope: z.enum(['copy', 'project']), kind: z.string(),
  examples: z.array(z.string()), runs: z.string().nullable(),
  skips: z.number().int(), runCount: z.number().int(), taskCount: z.number().int(),
  topWorry: z.object({ limit: LimitName, p: z.number() }).nullable(),
  stoppedAtLimit: z.array(z.string()),
});
export const PrecedentAnswer = z.object({
  kinds: z.array(z.object({
    programKey: z.string().min(1), scope: z.enum(['copy', 'project']),
    choice: z.enum(['approve', 'keep_skipping', 'report']),
    kind: z.string().min(1).max(PRECEDENT_KIND_MAX).optional(),
  })).min(1).max(50),
});

// packages/db/src/store/trust-precedents.ts
export function insertPrecedent(ctx: WriteContext, input: PrecedentInput): TrustPrecedentDto; // an existing row for the project, key and scope is returned unchanged
export function listPrecedents(db: DbReader, projectId: ProjectId): TrustPrecedentDto[];
export function setPrecedent(ctx: WriteContext, projectId: ProjectId, id: TrustPrecedentId, change: { state?: PrecedentState; kind?: string; runsHash?: string | null }): TrustPrecedentDto | null; // `active` resets conflicts
export function countPrecedentUse(ctx: WriteContext, id: TrustPrecedentId): void;
export function countPrecedentConflict(ctx: WriteContext, id: TrustPrecedentId): number; // the new count

// apps/daemon/src/trust/program-key.ts
export function programKey(toolName: string, input: Readonly<Record<string, unknown>>, checkout: string, cwd: string): string | null;

// apps/daemon/src/trust/call-runs.ts
export interface CallRuns { readonly runs: readonly RunText[]; readonly cut: boolean; readonly differs: boolean }

// apps/daemon/src/trust/precedents.ts
export const PRECEDENT_LIMIT_CEILING = 0.5;
export const PRECEDENT_CONFLICTS_MAX = 3;
export const PRECEDENT_LINES_MAX = 30;
export interface ShownPrecedent { readonly id: TrustPrecedentId; readonly kind: string; readonly examples: readonly string[]; readonly approved: string; readonly changedSince: boolean }
export function precedentFor(precedents: readonly TrustPrecedentDto[], key: string | null, scope: PrecedentScope, runs: CallRuns): ShownPrecedent | null;
export function precedentLines(precedents: readonly TrustPrecedentDto[], scope: PrecedentScope): string[];
export function runsHash(runs: CallRuns): string | null;

// apps/daemon/src/trust/crosses-limit.ts
export const PRECEDENT_APPLIES = 'precedent_applies';
// CrossesLimitRequest gains:   readonly precedent?: ShownPrecedent;
// LimitReading's allow gains:  by: 'answers' | 'builder' | 'precedent'
// LimitVerdict's allow gains:  by: 'fast_path' | 'model' | 'precedent'
// LimitVerdict's limit gains:  readonly precedentConflict?: true
export function readLimitAnswers(probabilities: Readonly<Record<string, number>>, floor: number): LimitReading; // unchanged signature

// apps/daemon/src/trust/precedent-candidates.ts
export const PRECEDENT_MIN_SKIPS = 3;
export const PRECEDENT_MIN_RUNS = 2;
export const PRECEDENT_WINDOW_DAYS = 14;
export function precedentCandidates(db: DbReader, projectId: ProjectId, now: Date, read: CommittedReader | null): Promise<PrecedentCandidateDto[]>;

// apps/daemon/src/inbox/precedent-card.ts
export const precedentFoldKey = (projectId: ProjectId): string => `precedent:${projectId}`;
export function refreshPrecedentCard(ctx: WriteContext, projectId: ProjectId, candidates: readonly PrecedentCandidateDto[]): void; // raises, rewords or resolves
export function applyPrecedentAnswer(ctx: WriteContext, projectId: ProjectId, answer: PrecedentAnswer, candidates: readonly PrecedentCandidateDto[]): TrustPrecedentDto[];

// HTTP (apps/daemon/src/daemon/trust-services.ts)
// GET   /projects/:id/precedents            -> { precedents: TrustPrecedentDto[]; candidates: PrecedentCandidateDto[] }
// POST  /projects/:id/precedents/answer     body PrecedentAnswer
// PATCH /projects/:id/precedents/:pid       body { state?: 'active' | 'revoked'; kind?: string }
```

## State table (design, not a test list)

| State | Event | Next |
| --- | --- | --- |
| No candidate | a key reaches 3 skips in 2 runs, or stopped a run, or was approved once with Run these now | the card is raised or reworded |
| Offered | Approve | an `active` row; the kind leaves the card; the card resolves when it lists none |
| Offered | Keep Skipping | a `declined` row; the kind leaves the card |
| Offered | Report | the report is copied; the kind stays |
| Offered | 14 days with no new skip | the kind leaves the card |
| Active | a call of the kind; every limit under one half; `precedent_applies` ≥ f | allow by precedent; `uses` + 1; the row's `precedent_id` |
| Active | a call of the kind; a limit ≥ f | that limit; `conflicts` + 1; at 3, `paused` and the conflict card |
| Active | a call of the kind; the top limit from one half to f | unclear: the second opinion, same state |
| Active | `CallRuns.differs`, or no key | not shown; judged as today |
| Active | the committed text's hash differs from `runs_hash` | shown with `changed_since`; a notice with Remove and Keep |
| Active, paused | Remove | `revoked`; the memory key changes, so the next call is judged afresh |
| Paused | Keep or Edit | `active`, conflicts 0 |
| Any | two answers race | the unique index keeps one row; the second reads it |
| Any | the daemon restarts | the card is recomputed from rows at start |

## Tracks and tasks

Track A is one task and its own pull request; it can merge first. Track B is in order, one implementer per card.

| # | Track | Task | Size |
| --- | --- | --- | --- |
| 1 | A | The Makefile reader keeps a recipe inside a conditional | Core (the judge's reader), small |
| 2 | B | Contracts and the `trust_precedents` store | Core |
| 3 | B | `programKey` | Core (a pure parser) |
| 4 | B | The judge reads a precedent: the question, the reading, the hook judge, the allow lines | Core |
| 5 | B | Candidates, the card, its answer, Run and Make Routine, the conflict card, the routes | Core (a permission) |
| 6 | B | Desktop: the card, Standing Approvals, the decision label; the trust e2e extended | Feature |
| 7 | B | The migration, generated last; module notes | Small |
