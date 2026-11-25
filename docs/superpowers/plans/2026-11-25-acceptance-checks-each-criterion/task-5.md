# Task 5: the runner's acceptance pass

**Size: Core.** Read the index's Brief and Global Constraints first. Needs tasks 2, 3 and 4.

## Files

- `apps/daemon/src/runner/runner.ts`.
- `apps/daemon/src/team/step-flow.ts`: `clearSendBacks` also resets `acceptanceSentBack`.
- `packages/db/src/store/rigor-figures.ts`: reviewer send-backs leave out `sentBackBy === 'acceptance'`.
- `apps/daemon/src/acceptance/card.ts`: `raiseAcceptanceCard` and `acceptedCriteria` only. Task 6 adds the answer.

## Interfaces

Calls (as the index quotes them):
- `checkAcceptance`;
- `acceptanceMove`;
- `raiseAcceptanceCard(ctx, {workstreamId, projectId, taskTitle, detail})`;
- `acceptedCriteria(db, workstreamId)`;
- the `fix` variant.

## What to build

**1. Outside the write.** In `verify`, after a passing gate, beside `reviewForcedAfter` and
`testValueFollowUpsAfter`, add `acceptanceAfter(id, ctl, row, checkout)`. It returns null unless all of these hold
(each is a state-table row):
- the current step is Implement;
- no implement step follows;
- no step has `fixedPlan`;
- the task has criteria.

It reads the diff with `ownWork` and `diffOfRanges`, as `reviewForcedAfter` does, and the gate's command and summary
from the evidence it just wrote. It calls `checkAcceptance` with a signal tied to `ctl`, so a stop aborts it.

**2. Inside the step-ending write**, after the fence check, with `now = withSafetyNet(withCurrentPlan(...))`:
- `reviewFollows` comes from `now.steps`.
- `atLimit` is `atRoundLimit(step.acceptanceSentBack ?? 0, rowProcess(ctx.tx, ...).reviewRounds)`.
- Drop any result whose criterion text is no longer in the task's criteria.
- **SendBack:**
  - insert the Acceptance evidence with `detail.sentBack: true`;
  - target the implement step that just ended, by its index;
  - `acceptanceSentBack + 1`;
  - with `fixBy` Resumed and a session to resume: `nextAction {kind: 'fix', evidenceId, providerSessionId}`.
    Otherwise use null and escalate one rung, as a reviewer's send-back does;
  - emit `step.changed` with `sentBackBy: 'acceptance'`;
  - don't advance the steps. The gate runs again after the fix.
- **GoOnWithCard:** insert the evidence (`sentBack: false`), `raiseAcceptanceCard`, then today's path (`moveAfter`).
- **GoOn or null:** insert the evidence when there is a result (`sentBack: false`), then today's path.

**3. The Review's brief.** At the first round of a Review, `runSession` reads the latest Acceptance evidence. Its
unclear criteria and `unasked` go into the prompt beside `testValueBrief`, through a `PromptInput.acceptance` field
in `briefing/prompts.ts`.

**4. `raiseAcceptanceCard`:**
- one live card per workstream: update it if one is open;
- kind `acceptance`, `targets [{workstreamId, sessionId: null}]`;
- title "Check these criteria: <task>";
- the body lists each criterion that isn't met with its note, then `unasked`;
- options Accept and Send back with a note;
- the detail holds `AcceptanceDetail`.

**5. `acceptedCriteria`:** the criteria in the detail of resolved acceptance cards of this workstream whose answer
was Accept.

## State-table rows

Every row in the spec's state table except the card-answer rows (task 6), the crash and account rows (task 4) and
Retry. Retry is handled here, through `clearSendBacks`.

## Spec sections

"Where it runs", "What the run does next", "Send-back" and "The card" (the raise only).

## Tests

One case in `runner/test-value.test.ts`'s `createTestEngine` harness (extend the file; no new harness):
- A Standard-rigor task has two criteria, and the fake OpenRouter answers per call.
- First pass: the cheap call reads criterion 2 under the floor, and the second opinion reads it at 0.1 (not met).
- The run is sent back once, with `step.changed` `sentBackBy: 'acceptance'` and a `fix` action. After the fix's
  gate, both read as met and the run goes on to Review.
- Add a per-call answer queue to the fake. That's test code, not production.
- Value card: `why_new=core: the runner's send-back on the rigor's rounds`. Prove it red first.
