# Plan: acceptance checks each criterion

**Size: Core** (runner send-back, recovery mappings). Spec:
`docs/superpowers/specs/2026-11-25-acceptance-checks-each-criterion-design.md` (plan review: two rounds, folded
in).

## Brief

The spec's brief stands. In short:
- After the final gate passes, a cheap yes/no call per acceptance criterion, then a stronger call for any criterion
  that isn't clearly met.
- **Not met:** the run goes back to its build session, on the rigor's rounds and fix rule.
- **Unclear:** the reviewer gets it. With no reviewer, or at the round limit, the run ships and leaves one
  Acceptance card.
- The Board shows Completed, Sent back and Sent to you for the last 7 days.
- It ships switched off. It is turned on in Settings after the replay passes and the builder has seen screenshots.

Nothing is needed from the builder.

## Global Constraints

- The root `AGENTS.md` and `apps/daemon/AGENTS.md`; `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- **Nothing waits on the builder.** No path parks a run on the acceptance card.
- **Judge calls happen outside the write; every decision that reads state happens inside it.** That covers the
  steps after `withSafetyNet(withCurrentPlan(...))`, `rowProcess` with `ctx.tx`, and the fence.
- **Verdicts are keyed by criterion text**, never by position.
- **Only an Acceptance evidence row with `detail.sentBack === true` is fix evidence.**
- **The acceptance card is never a run's question.** It is never handed to `onParkedAnswer`, never parked on by
  `settle`, and never picked by recovery.
- Both decisions default to `enabled: false`.
- One migration: `evidence.detail`. It is generated last, after the final merge of `main` (task 8).
- Tests: only those named on the cards.

## Provider parity

- **Decisions:**
  - On an OpenRouter, Anthropic key or Bedrock decisions account, it runs as in the spec.
  - With no decisions account (the builder has only a Claude plan or a ChatGPT/Codex plan), `ready()` is false and
    runs go on as today. The Board says "Acceptance isn't checking: no account can answer decisions".
- **The fix:** it runs on the project's account like any fix: Claude Code resume on a Claude plan, Bedrock or an API
  key, or a Codex thread resume. Where it can't resume, it runs fresh, one rung up, once.

## Interfaces

```ts
// packages/contracts/src/judge.ts
JudgeDecision.Acceptance = 'acceptance'
JudgeDecision.AcceptanceSecond = 'acceptance_second'
export const OPENROUTER_ACCEPTANCE_SECOND_MODEL = 'anthropic/claude-sonnet-5.5';

// packages/contracts/src/acceptance.ts
export const AcceptanceVerdict = { Met: 'met', NotMet: 'not_met', Unclear: 'unclear', Unread: 'unread' } as const;
export type AcceptanceVerdict = (typeof AcceptanceVerdict)[keyof typeof AcceptanceVerdict];
export const AcceptanceCriterionResult = z.object({
  criterion: z.string().min(1),
  verdict: z.enum(['met', 'not_met', 'unclear', 'unread']),
  /** Which call read it, and how sure it was: "read as not met (0.86, second opinion)". */
  note: z.string(),
});
export const AcceptanceDetail = z.object({
  criteria: z.array(AcceptanceCriterionResult),
  /** Set when the change likely does something the task didn't ask for. */
  unasked: z.string().nullable(),
  /** True only on the pass that sent the run back: the one row that is fix evidence. */
  sentBack: z.boolean(),
});
export const AcceptanceChoice = { Accept: 'accept', SendBack: 'send_back' } as const;
export const AcceptanceChecking = z.discriminatedUnion('on', [
  z.object({ on: z.literal(true) }),
  z.object({ on: z.literal(false), reason: z.enum(['no_account', 'off']) }),
]);
export const AcceptanceFigures = z.object({
  days: z.number().int(),
  completed: z.number().int(),
  sentBack: z.number().int(),
  sentToYou: z.number().int(),
  checking: AcceptanceChecking,
});

// packages/contracts/src/states.ts
EvidenceKind.Acceptance = 'acceptance'
InboxKind.Acceptance = 'acceptance'

// packages/contracts/src/entities.ts
z.object({ kind: z.literal('fix'), evidenceId: EvidenceId,
  providerSessionId: z.string().min(1).nullable().default(null) })
EvidenceDto.detail: AcceptanceDetail.nullable()

// packages/contracts/src/steps.ts
WorkstreamStep.acceptanceSentBack?: number

// packages/db/src/store/acceptance-figures.ts
export function acceptanceFigures(
  db: DbReader, projectId: ProjectId, days: number, now: Date,
): { completed: number; sentBack: number; sentToYou: number };

// apps/daemon/src/acceptance/read.ts (pure)
export function secondQuestions(
  criteria: readonly string[], accepted: ReadonlySet<string>,
  first: Readonly<Record<string, number>> | null, floor: number,
): string[];
export function readAcceptance(input: {
  criteria: readonly string[];
  accepted: ReadonlySet<string>;
  first: Readonly<Record<string, number>> | null;
  second: Readonly<Record<string, number>> | null;
  firstFloor: number;
  secondFloor: number;
}): AcceptanceCriterionResult[];
export const AcceptanceMove = { GoOn: 'go_on', SendBack: 'send_back', GoOnWithCard: 'go_on_with_card' } as const;
export function acceptanceMove(input: {
  results: readonly AcceptanceCriterionResult[]; reviewFollows: boolean; atLimit: boolean;
}): AcceptanceMove;

// apps/daemon/src/acceptance/ask.ts
export interface AcceptanceInput {
  readonly task: { readonly title: string; readonly why: string; readonly description: string };
  readonly criteria: readonly string[];
  readonly accepted: ReadonlySet<string>;
  readonly diff: DiffSince;
  readonly gate: { readonly command: string; readonly summary: string };
  readonly workstreamId: WorkstreamId;
  readonly taskId: TaskId;
}
/** Null when the first call can't run (`ready()` false); unread criteria otherwise. Never throws. */
export async function checkAcceptance(
  deps: { readonly judge: Judge; readonly floors: { readonly first: number; readonly second: number } },
  input: AcceptanceInput,
  signal: AbortSignal,
): Promise<Omit<AcceptanceDetail, 'sentBack'> | null>;

// apps/daemon/src/acceptance/card.ts
export function raiseAcceptanceCard(ctx: WriteContext, input: {
  workstreamId: WorkstreamId; projectId: ProjectId; taskTitle: string; detail: AcceptanceDetail;
}): InboxItemDto;
export function applyAcceptanceAnswer(
  ctx: WriteContext, item: InboxItemDto, answer: { choice: AcceptanceChoice; note?: string },
): void;
export function acceptedCriteria(db: DbReader, workstreamId: WorkstreamId): Set<string>;
```

## State table

The spec's §State table is the design. Each card names the rows it handles.

## Tracks and tasks

Track A runs in order. B and C start once task 1 has merged into the branch.

| #   | Task                                                                                | Track | Size     |
| --- | ----------------------------------------------------------------------------------- | ----- | -------- |
| 1   | Contracts and schema: the types above, the `fix` field, step and evidence fields     | A     | Core     |
| 2   | The decisions: config, defaults, `testKind`, decision-offer, catalogue, allowlist    | B     | Feature  |
| 3   | `acceptance/read.ts` and `ask.ts`                                                   | B     | Core     |
| 4   | A `fix` that resumes: next-action, recovery, drift, escalation, fix evidence, prompt | A     | Core     |
| 5   | The runner pass: verify wiring, send-back, the card, rigor-figures, Review brief     | A     | Core     |
| 6   | The card's answer path and its exclusions, plus desktop card plumbing                | A     | Core     |
| 7   | Board counts: store, API, Board header, Factory link, e2e                            | C     | Feature  |
| 8   | Migration, replay script, click-through screenshots                                 | A     | Feature  |
