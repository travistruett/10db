# A lane's proposal is routed by rule: plan reviews become steps, prerequisites are filed once

- **Date:** 2026-11-27

## Decision

The `propose` MCP tool routes three kinds of proposal without an Inbox card, each one leaving an Activity row
(a notice with `decision.by: rule`, undo `final`, with a reason saying how to take it back by hand):

- **`plan_review`** (rule `plan-review-step`). `planReviewRoute` in `inbox/proposal-task.ts` decides. When the
  task's effective rigor is Careful or Critical, the current step is Plan and the rule isn't asking, the Plan
  step gets `planReviewAsked: true`, the proposal is accepted, and at the end of the step the runner puts a Plan
  Review step (planned for the task's rigor, like any added step) right after it, unless one already follows.
  The step is entered at once, so a later replan keeps it. A Plan Review already ahead accepts the proposal
  with no change. Work that isn't Core, a step that isn't Plan, or a rule set to ask raises the card as before,
  with a clause saying why. Accepting that card marks the Plan step the same way (`acceptPlanReview`) while the
  lane is still on it; once the step has ended the answer is refused with a message to reject the card, because
  a yes could no longer add the review.
- **A prerequisite** (`prerequisite: true` on a new task; rule `proposal-filed`) skips the size limit of
  `proposalFiling`. Kinds and risk words that ask for a card (data-loss surfaces), filing switched off, a batch
  join and the step's cap still raise the card. A prerequisite is filed to the Icebox once: its first
  description line names the prerequisite and the lane's task, and a second proposal with that line resolves
  against the open task already filed.
- **A small new task** filed by 10db itself (as before) now also posts a `proposal-filed` row.

A proposal that still reaches the builder (new scope outside the goal, `change_task` such as a dropped
criterion, a data-loss surface) carries `costs` ("What it costs: …", or "The lane did not say what it costs.")
and declares its decider as the builder, owning product and taste.

## Why

The builder's calls are scope, cost and data. A plan review on Core work is a step 10db already knows how to
run, and a prerequisite the task can't finish without adds nothing the goal didn't ask for; carding either only
makes the builder press accept. Until a judge question asks "is this inside the goal", the lane's own claim
stands, since a filed task is cheap to remove from the Board. Inserting the review from the `propose` handler
was turned down: the step's routing inputs aren't there, and replanning drops unstarted added steps.
