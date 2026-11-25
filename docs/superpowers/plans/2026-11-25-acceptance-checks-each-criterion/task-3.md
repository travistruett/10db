# Task 3: reading and asking

**Size: Core.** Read the index's Brief and Global Constraints first. Needs task 1.

## Files

- `apps/daemon/src/acceptance/read.ts`: pure.
- `apps/daemon/src/acceptance/ask.ts`.
- `apps/daemon/src/acceptance/index.ts`: the entry point.
- `apps/daemon/src/acceptance/AGENTS.md`: a short note on the rule and where it runs.

## Interfaces (implement exactly)

```ts
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
export async function checkAcceptance(
  deps: { readonly judge: Judge; readonly floors: { readonly first: number; readonly second: number } },
  input: AcceptanceInput,
  signal: AbortSignal,
): Promise<Omit<AcceptanceDetail, 'sentBack'> | null>;
```

## The rule (spec "The questions")

- Floors are clamped to at least 0.5.
- **Probability maps are keyed by criterion text.** `ask.ts` maps question ids (`met_0`, `met_1`, …) to and from the
  text.
- **Accepted** criteria are met, with the note "accepted by the builder".
- **`acceptance` (the first call):**
  - `p ≥ f` is met.
  - Anything else goes to `secondQuestions`.
  - A null first (a fallback) sends every criterion that isn't accepted to the second call.
- **`acceptance_second`:**
  - `p ≥ f` is met;
  - `p ≤ 1 − f` is not met;
  - anything else is unclear.
  - A null second leaves the asked criteria `unread`.
- **The note** names the call and the probability, for example "read as not met (0.86, second opinion)".
- **`acceptanceMove`:**
  - any `not_met` and not `atLimit` gives SendBack;
  - any `not_met` at the limit, or any `unclear` with `!reviewFollows`, gives GoOnWithCard;
  - otherwise GoOn. `unread` never counts against the run.
- **`checkAcceptance`:**
  - Returns null when `judge.ready(Acceptance)` is false.
  - Otherwise it calls `judge.assess` for `Acceptance` with `timeoutMs: ACCEPTANCE_TIMEOUT_MS` (20 s). The second
    call, `AcceptanceSecond`, is made only for `secondQuestions`, with `ACCEPTANCE_SECOND_TIMEOUT_MS` (60 s) and
    `secondary: true`. Both get the signal.
  - The state: `{task, criteria, diff, gate}`. The diff is cut to `ACCEPTANCE_DIFF_CAP` (60,000 characters).
    Past it, send the file list and each file's first hunks, with `truncated: true`.
  - The questions follow the spec's "The questions" wording, plus `unasked`. `unasked ≥ firstFloor`, from either
    call that asked it, sets `unasked` to a one-line note.
  - It never throws: a fallback is null for that call.
- The `read` callback passed to `assess` (for the judge log) uses `readAcceptance` on that call's probabilities.

## Spec sections

"The questions" and "What the run does next" (its ordering).

## Tests

One pure table test, `acceptance/read.test.ts`, covering `readAcceptance`, `secondQuestions` and `acceptanceMove`
with rows for each verdict, each null call, an accepted criterion and the floor clamp.
- Value card: `why_new=pure rule table (core: decides send-back)`.
- Prove it red first.
