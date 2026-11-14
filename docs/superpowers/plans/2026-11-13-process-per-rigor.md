# Process per rigor Implementation Plan (PR 2b)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief

**What changes for the builder**

- Each rigor's row on Settings › Models (global and per project) gains three process settings, editable in the row
  drawer field by field, each showing where its value comes from with "Use global" or Reset:
  - **Review rounds:** Light 1, Standard 1, Careful 2, Critical 2.
  - **A send-back is fixed by:** "the build session, resumed" for Light and Standard; "a fresh build session" for
    Careful and Critical.
  - **The builder approves the plan:** Critical only.
- The playbook table's row header shows the process, for example "2 rounds · fresh fix · you approve the plan".
- **A reviewer's send-backs count against the row's rounds,** apart from gate failures and your own send-backs.
  Those keep today's limit of 3. At the limit the work ships with its findings filed as a follow-up task, as today.
  A security or auth task fails instead.
- **Standard fixes resume the build session.** The reviewer's findings go to the session that wrote the code, on
  the same model. Careful and Critical keep today's fresh session, one model up.
- **Critical waits for you after Plan.** An Inbox card shows the plan with Approve and Send Back (with a note).
  Build starts when you approve.
- **Light runs no review unless the change needs one.** A big diff, a binary file, or a change to a hazard,
  manifest, lockfile, migration, CI or agent-instruction path adds a review after the gate passes.
- **"Skip review for small changes" goes away** from Settings › Decisions. Rigor decides review up front. Old
  logged calls still show.
- **Changing a started task's rigor** in the drawer changes only the steps still to come. The running step
  finishes on what it has.

**What it buys:** Standard tasks stop paying for a fresh session that re-reads everything to fix a two-line
finding. Small work no longer waits on a judge call to skip a review. Critical work gets your eyes before money
goes into the build.

**What could go wrong, and how we'd know**

- **A resumed session can't resume.** Its conversation may be gone, it may belong to another account, or the
  account no longer offers its model. In each case it falls back to today's fresh session. A test covers each
  case, and the step's reason says why.
- **A plan-approval card is lost on restart.** Recovery raises it again, as it does for the check card, and a
  real-SQLite recovery test covers it.
- **The round limit miscounts.** A table test runs each rigor through 0–3 rejections and checks that gate
  failures don't use rounds up.
- **A rigor change mid-run drops a step that already started.** A pure table test covers it: the current step and
  every earlier one are never touched.

**Calls you might disagree with**

- **Light's rounds and fix apply only to a review its safety net adds.** A Light row gets rounds and fix like the
  others, and the table shows "no review" while its steps have none.
- **Rounds count per reviewing step.** Review, QA and Plan Review each have their own, using the per-step count
  the board already keeps. Critical's QA therefore gets 2 rounds of its own after Review's 2.
- **A rigor change while a task waits for plan approval leaves the card standing.** You answer it.
- **Plan approval is a new Inbox kind, "plan".** It is not the check card, which approves finished work.

**Needed from you:** nothing.

---

**Goal:** PR 2b of `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md` (§7.1, §8.3 last
paragraph). Not in it: `rigorSource`, the judge, `resize_task`, ship by rigor, kinds' skills (PR 3).

**Architecture:** a row's process lives beside its steps in `playbook_rows`: nullable per field, resolved
project → global → default as cells are. The runner reads the live row of the task's effective rigor when a
reviewer rejects, so a rigor or playbook change applies to rounds still to come. A step remembers the provider
session that last ran it, so a send-back can resume it. Plan approval parks the workstream on a new `plan_approval`
next action and a `plan` Inbox card, modelled on the gateless check (`builder_review`).

**Tech stack:** TypeScript, zod, Drizzle + SQLite, Hono, React + Mantine, Vitest.

## Global constraints

- Follow `.claude/rules/code-style.md` and `.claude/rules/testing.md`. Each newly tested behaviour carries its value
  card in its commit.
- Migrations: change `schema.ts`, then run `pnpm --filter @10db/db generate`. Generated SQL is never edited. After
  contract changes, run `pnpm --filter @10db/contracts generate`.
- Runner, recovery and claim behaviour is built red-first in small steps, one commit per behaviour, through the
  real pipeline (`createTestEngine`, fake adapter). Delivery tests are their own vitest project:
  `pnpm exec vitest run -c vitest.delivery.config.ts <files>` from `apps/daemon`.
- Every `switch` over `NextAction['kind']` and `InboxKind` stays exhaustive. The linter finds them all.

## Provider parity

| Piece | Claude plan, API key, Bedrock | ChatGPT/Codex plan |
| --- | --- | --- |
| Process settings, rounds, plan approval, safety net | yes | yes |
| Resumed fix | `resume:` with the session's own model (`claude-session.ts`) | `thread/resume` with the thread's own model (`codex-session.ts` passes `model` on resume and checks `thread.model`) |
| Resumed fix when the account no longer offers that model, or the session ran on another account | fresh session, as today | fresh session, as today |

A resumed fix always launches on the model the resumed session ran on. Neither adapter is asked to move a
conversation to another model, so the Codex question in the spec (§7.1) does not arise. Codex has resumed threads
on their own model for crash recovery and builder messages since the Workbench.

## Review focus

1. Reviewer send-backs never touch `attempt`, and gate and builder send-backs never touch rounds.
2. A resumed fix is never launched on a model other than the session's own, nor on another account.
3. A workstream parked for plan approval survives a restart with exactly one live card. An answer to a stale card
   is refused.
4. A rigor change never alters the current step or any earlier one.
5. `review_size` stays parseable in logged calls and keeps its label. It is never asked again, and a stored config
   that still holds it parses.

---

### Task 1: Row process: contracts, storage, resolver (shared; lands first)

**Files:** `packages/contracts/src/rigor.ts`, its test, and the generated contracts; `packages/db/src/schema.ts`,
the generated migration, `store/playbook.ts` and its test; `apps/daemon/src/routing/playbook-defaults.ts`,
`playbook.ts`, `playbook-view.ts` and tests; the playbook routes' contract tests in `apps/daemon` if they pin the
DTO.

**Produces:**

- `FixBy = { Resumed: 'resumed', Fresh: 'fresh' } as const`.
- `PlaybookInput.rows[]` becomes `{ rigor; steps: Steps | null; reviewRounds: int 0–3 | null; fixBy: FixBy | null;
  approvesPlan: boolean | null }`. Each process field defaults to "left out", meaning untouched, and null clears
  it. Keep it a partial patch per field, as cells are: a row form that sends only `reviewRounds` leaves `steps`
  as it is.
- `PlaybookRowDto` gains `reviewRounds`, `fixBy` and `approvesPlan`, each `sourced(...)` like `steps`.
- `playbook_rows`: `steps` becomes nullable and gains `review_rounds` (int), `fix_by` (text) and `approves_plan`
  (int boolean), all nullable. A row whose fields are all null is deleted.
- `DEFAULT_PROCESS: Record<Rigor, { reviewRounds; fixBy; approvesPlan }>`:
  - Light: 1, resumed, false.
  - Standard: 1, resumed, false.
  - Careful: 2, fresh, false.
  - Critical: 2, fresh, true.
- `rowProcess(rigor, playbook): { reviewRounds; fixBy; approvesPlan }`, resolved project → global → default per
  field, in `routing/playbook.ts`. Export it through `routing/index.ts`.

**Value:** `protects=a row's process per scope, field by field; fails_when=a process write clobbers steps or the
other scope, or a stored row without process fields stops parsing; why_new=rows had only steps; no_claim=that the
runner obeys them`

- [ ] Write the tests and see them go red:
  - a table for `rowProcess` (default; global overrides one field; project overrides another);
  - on real SQLite, setting `reviewRounds` alone keeps `steps`;
  - clearing every field deletes the row;
  - a pre-existing row with steps only parses.
- [ ] Implement. Generate. Make it green. Commit `feat: a rigor's row says how many review rounds it runs, how a
      send-back is fixed and whether the builder approves the plan`.

### Task 2: Review rounds (Track A)

**Files:** `apps/daemon/src/runner/runner.ts` (`finishReadOnlyStep`, `case 'send_back'`), `limit-ship.ts` if its
inputs change, `runner.test.ts`, and `packages/contracts/src/review-rounds.ts` doc comments.

**Behaviour:**

- A reviewer rejection (Review, QA or Plan Review) is at the limit when `step.sentBack + 1 > rounds`, where
  `rounds` is `rowProcess(task.effectiveRigor, playbook).reviewRounds`, read live at the rejection.
- Below the limit it sends back as today, but does not increment `attempt`.
- At the limit, today's at-limit branch runs unchanged: ship with a follow-up when `shipsAtRetryLimit`, else fail
  with `RejectedAtLimit`. The reason names the rounds: "rejected the work and the review rounds (N) are used up".
- Gate failures, uncommitted ends, merge sends and the builder's send-back keep `attempt` and
  `FIX_ATTEMPT_LIMIT` exactly as today.
- `FIX_ATTEMPT_LIMIT`'s comment becomes "Times the gate or the builder may send the work back".
- Rounds 0 means the first rejection is already at the limit.

**Tests (red first, through `createTestEngine`):**

- Standard: one rejection goes back to build. A second rejection ships with a follow-up.
- Careful: two rejections go back. A third ships.
- A security task at the limit fails.
- Two gate failures, then a review rejection: the work still goes back, because the gate used `attempt` and not
  rounds.
- A playbook row set to 0 rounds ships on the first rejection.
- Extend the existing tests that count send-backs against 3. `runner.test.ts` near 3941 ("counts only the
  send-backs before the limit") and the fix-limit test near 4550 change to round semantics. Say which in the
  commit.

**Value:** `protects=reviewer send-backs are bounded by the rigor's rounds and apart from gate/builder attempts;
fails_when=a review rejection uses an attempt or the limit ignores the row; why_new=one shared counter existed;
no_claim=the resumed fix`

- [ ] Red, green, commit `feat(daemon): a reviewer's send-backs count against the rigor's review rounds, apart
      from the gate's`.

### Task 3: A Standard fix resumes the build session (Track A)

**Files:** `packages/contracts/src/steps.ts` (`WorkstreamStep.providerSessionId`) and `entities.ts` (`revise`
gains `providerSessionId: string | null`, default null so stored actions parse); `runner/next-action.ts` and its
test; `runner.ts` (the send-back write, the session-start write that records the step's provider session,
`escalated` skipped when resuming); `briefing/prompts.ts` (revise text for a resumed session); `recovery/**`
where `revise` is handled; tests.

**Behaviour:**

- Each step records the provider session that last ran it (`WorkstreamStep.providerSessionId`, default null), in
  the write that marks a session started (`markSessionStarted`).
- On a send-back whose target step has a recorded session and whose row says `fixBy: resumed`:
  - the write sets `nextAction: { kind: 'revise', reviewStep, providerSessionId }`;
  - there is no escalation, so the step keeps its model and effort, and `reason` gains "fixing in its own
    session";
  - otherwise the write is today's fresh revise, with `escalated`.
- At launch, a resumed revise runs fresh, with today's escalation, and the reason says why, when:
  - the session ran on another account (the existing guard via `getSessionByProviderId`;
    `nextActionOnAnotherAccount` sets the id to null for `revise`); or
  - `resolveOn` resolves the step to a model other than the recorded session's model.
- Crash: `nextActionAfterCrash` handles a revise with an id the way it handles `feedback`. A resumed revise that
  crashed goes fresh. One with null stays as it is.
- The prompt to a resumed session: "<by> rejected the work. Its findings are below. Address each one, commit,
  and end your turn." It is followed by the rejection's findings (`findingNotes`), since the resumed session never
  saw the review. The fresh revise prompt is unchanged. Check `prompts.ts:600-620` (`fromHandoff` predicate):
  a resumed revise never takes the handoff.
- The builder's retry (`team/steps.ts:356`) stays fresh.

**Tests:**

- Pipeline, extending `runner.test.ts` "sends a rejection back to the implement step, one profile up" near 3528:
  - on Standard, the fix session's spec has `resumeProviderSessionId` equal to the build session's, the same
    model, and no escalation;
  - on Careful, a fresh session one profile up, as today.
  Check that the fake adapter records the resume id. If it doesn't, extend the fake: it is a boundary.
- `next-action.test.ts` rows: crash and another account, for revise with and without an id.
- The model-drift case: the account's list changes between build and fix, and the fix goes fresh.
- The briefing table row: the resumed revise prompt carries the findings.

**Value:** `protects=a Standard send-back is fixed by the session that wrote the code, on its model;
fails_when=the fix starts fresh, escalates, or resumes across accounts/models; why_new=revise was always fresh;
no_claim=that the model fixes better resumed`

- [ ] Red-first, one commit per behaviour:
  - (a) record the step's session;
  - (b) resumed revise at send-back;
  - (c) fallbacks to fresh;
  - (d) the prompt.

### Task 4: Light's review safety net; retire `review_size` (Track A)

**Message 10db-0f before this task's commit is pushed** (the controller does this).

**Files:**

- `runner/review-size.ts`, renamed `runner/forced-review.ts`: keep the pure rule, drop the judge state, question
  and diff cap.
- `runner.ts`: delete `reviewSkippedByJudge`. Add the safety net on the gate-pass path (near 3788) and on the
  gateless path where the implement step ends with no step after it (`finishWithoutGate`).
- `routing/plan-steps.ts`: plan one extra step for a role (below).
- `packages/contracts/src/judge.ts`: `review_size` leaves `JudgeConfig.decisions`, the default and the patch. The
  `JudgeDecision.ReviewSize` value stays.
- `apps/daemon/src/judge/judge.ts`, wherever it names the decision.
- Desktop:
  - `decision-catalogue.ts` keeps `DECISIONS[review_size]` for its label;
  - the `decisions-section.test.tsx`, `decision-drawer.test.tsx` and `judge-fixtures.ts` rows change;
  - `e2e/settings.spec.ts` drops "Delivery" from the groups, and its Recent decisions filter on "Skip review for
    small changes" stays.
- Every test that lists the decision (the `git grep review_size` list), and the generated contracts.

**Behaviour:**

- `forcedReview(kinds, changes, hazards): string | null` returns the first reason a review is forced, in words
  ("changes `pnpm-lock.yaml`", "412 changed lines", "a binary file", "an always-reviewed kind (security)"), else
  null. It is the old `reviewSizeRule`'s checks, without the pinned and earlier-result cases, which only made sense
  for skipping.
- When the implement step passes (gate passed, or the gateless end), no Review step follows, and `forcedReview`
  gives a reason:
  - a Review step is inserted after it, planned through `planSteps` for that role (the cell of the lowest stronger
    rigor that runs Review, as a kind's added step gets);
  - its reason reads "review added: <reason>";
  - the workstream goes on to it.
- An unreadable diff adds the review: unlike the old skip, failing safe now means reviewing.
- The review runs with the task's own row's rounds and fix (Task 2, Task 3).
- The diff read uses `git.diffSince` as today. A cancel during the read is honoured as the old judge call was.
- A stored judge config that still holds `review_size` parses, and the key is dropped.

**Tests:**

- A table for `forcedReview`, adapting `review-size.test.ts`.
- Pipeline: a Light task changing `package.json` gets a review step, and the review runs. A Light task changing
  one small file ships with no review.
- `judge.test.ts`: an old stored config with `review_size` parses.
- Remove the tests of the judge skip. Say so in the commit.

**Value:** `protects=Light work that touches risky paths is still reviewed; fails_when=a Light lockfile change
ships unreviewed; why_new=the rule only fed the judge's skip; no_claim=that the forcing paths are complete`

- [ ] Red, green, commit `feat: light work gets a review only when the change forces one, and the review-size
      judge is retired`.

### Task 5: Critical plan approval (Track B)

**Files:**

- Contracts:
  - `InboxKind.Plan = 'plan'`, "A plan waiting for the builder to approve it or send it back";
  - `NextAction` `{ kind: 'plan_approval', inboxId }`;
  - choices `PlanChoice = { Approve: 'approve', SendBack: 'send_back' }`.
- Daemon:
  - new `runner/plan-approval.ts`, modelled on `builder-check.ts` (`raisePlanApproval`, `livePlanCard`,
    `waitsForPlanApproval`);
  - `runner.ts`, in `finishReadOnlyStep` `case 'advance'`: when the step is Plan, the row says `approvesPlan`, and
    the next step is not Plan Review, park instead of `advanceTo`;
  - `Runner.approvePlan(ctx, id)` and `Runner.sendBackPlan(ctx, id, note)`;
  - `runner/check-answer.ts` (or a sibling `plan-answer.ts`), wired where check answers are applied;
  - `recovery/recover.ts`: keep the card, or raise it again;
  - the scheduler's waiting filter (`runner.ts:4166`);
  - `next-action.ts`: pass it through, as `builder_review` is.
- Desktop: `views/inbox/plan-card.tsx` (new), `inbox-card.tsx`, `inbox-rows.ts`, `card-answer.ts`, and the
  `system-cards.ts` entry if kinds are listed there; tests.

**Behaviour:**

- **When the card is raised.** The Plan step approves itself by recording its plan. With Plan Review in the row,
  the card waits until Plan Review approves, so it is raised when the step before Build is done. In one write:
  - raise the card, with the plan text (the plan step's result summary) and Approve / Send Back;
  - transition to `WAITING_HUMAN`;
  - set `nextAction: plan_approval`;
  - clear the lease;
  - keep the claims.
- **Approve** does what `advanceTo(Build)` does, from the parked state. It throws `ConflictError` unless the
  workstream waits on this card.
- **Send Back** needs a note, as the check card's does:
  - it records builder evidence with the note;
  - the Plan step reruns as a revise, with the note under Earlier steps;
  - it counts `attempt`, because it is the builder's send-back and `FIX_ATTEMPT_LIMIT` applies;
  - a Plan Review in the row runs again after it.
- **Recovery** keeps exactly one live card. A missing card is raised again, and the workstream is reported
  parked.
- **Cancel or stop** while parked behaves as for `builder_review`.

**Tests:**

- Pipeline: a Critical task parks after Plan Review with one `plan` card. Approve runs Build. Send Back reruns
  Plan with the note in its prompt.
- A Careful task does not park.
- Recovery, on real SQLite: a parked task with its card deleted gets one card back.
- An answer to an answered card gets a 409.
- Desktop: `plan-card.test.tsx`. It renders the plan. Send Back needs a note. Approve calls the route.

**Value:** `protects=Critical build waits for the builder's approval of the plan; fails_when=Build starts
unapproved, the card is lost on restart, or a stale answer acts; why_new=no plan gate existed; no_claim=the
card's layout`

- [ ] Red-first, one commit per behaviour:
  - (a) park;
  - (b) approve;
  - (c) send back;
  - (d) recovery;
  - (e) the card UI.

### Task 6: A rigor change on a started task (Track B)

**Files:** `apps/daemon/src/team/replan-steps.ts` (new, pure) and its test; `daemon/services.ts` (`patchTask`);
`daemon/task-rigor-services.test.ts`.

**Behaviour:**

- `replanSteps(steps, stepIndex, planned): WorkstreamStep[]` keeps `steps[0..stepIndex]` as they are. The tail
  becomes the planned steps whose role comes after the current step's role in role order, each newly routed.
- A tail step whose role was already in the old tail keeps its record (`earlier`, `sentBack`) but takes its new
  model.
- `patchTask` applies the change in the same write when the task's effective rigor or kinds change and its
  workstream is active (not `DONE`, `FAILED` or `CANCELLED`). It plans through `planSteps` with the task's new
  rigor and kinds on the project's account, and saves `steps`.
- A workstream parked on a plan-approval card keeps its card.
- The review rounds of the new row apply from the next rejection, through Task 2's live read.

**Tests:**

- A table for `replanSteps`:
  - Standard → Careful at Build: Review stays. Plan is not added, because it comes before Build.
  - Careful → Light at Build: Review is dropped.
  - Light → Critical at Build: Review and QA are added.
  - At Review, → Light: nothing after it, and the current step is kept.
- A services test on real SQLite: the patch rewrites the active workstream's tail.

**Value:** `protects=a rigor change mid-run changes only steps still to come; fails_when=a running or earlier step
is replaced or rerun; why_new=steps were planned once at start; no_claim=resize_task (PR 3)`

- [ ] Red, green, commit `feat(daemon): changing a started task's rigor changes only the steps still to come`.

### Task 7: The row drawer and table (Track B)

**Files:** `apps/desktop/src/views/settings/playbook-row-drawer.tsx`, `playbook-table.tsx`, `playbook-edits.ts`,
their tests, and the e2e `settings.spec.ts` if it opens the row drawer.

**Behaviour:** the drawer, titled "<Rigor>: process" (it was "…: steps"):

- **Steps:** as today.
- **Review rounds:** a `SegmentedControl` of 0 to 3.
- **A send-back is fixed by:** a `Select` with "The build session, resumed" and "A fresh build session".
- **The builder approves the plan:** a `Switch`, disabled with "Needs a Plan step" when the row's steps lack Plan.
- Rounds and fix show "Only for a review the change forces" under them when the row has no reviewing step.
- Each field shows its source ("default", "global" or "this project"). Each has its own Reset, or in a project
  "Use global", which sends that field null.
- The table's row header shows a short line under the rigor name: steps, then "N rounds", "resumed fix" or
  "fresh fix", and "you approve the plan" when set. With no reviewing step it reads "no review".

**Tests:** `playbook-table.test.tsx`: the header line per default row. The drawer: changing rounds sends only
`reviewRounds`, and a project's "Use global" sends null.

- [ ] Commit `feat(desktop): a rigor's drawer sets its review rounds, how a send-back is fixed and plan approval`.

### Task 8: Docs (controller)

- `apps/daemon/src/runner/AGENTS.md`: rounds, resumed revise, the safety net and plan approval.
- The spec's §12 parity row for the resumed fix, citing this plan's table.
- The decision `docs/architecture/decisions/2026-11-13-work-is-sized-by-rigor-and-one-playbook.md` gains PR 2b's
  calls (the brief's "Calls you might disagree with").
- `apps/desktop` Settings docs if they describe the row drawer.

## Order and tracks

1. **Task 1**, one implementer, on `feat/process-per-rigor`.
2. Then two tracks, each in its own worktree branched from it:
   - **A:** Tasks 2, 3, 4 (runner: send-backs, sessions, gate path).
   - **B:** Tasks 5, 6, 7 (plan approval, replanning, UI).
   Both edit `runner.ts` in different functions. The controller merges B into A's branch, then A into
   `feat/process-per-rigor`.
3. Code review (opus) per track, round 1 lists everything, at most two fix rounds. A click-through on a dev daemon
   covers the row drawer, a Critical task's plan card and a Light lockfile change. Then `make gate` and the PR.
