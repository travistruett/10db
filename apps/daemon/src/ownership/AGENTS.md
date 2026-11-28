# apps/daemon/src/ownership

- `shadow.ts` (`askOwnershipShadow`) asks the judge the ownership test's three questions (`OwnershipQuestion`:
  `one_way_door`, `product_and_taste`, `promise`) about a root batch's pull request, in one `judge.assess` call
  (`JudgeDecision.OwnershipTest`, marked `secondary`, 20 s). The tasks' titles and criteria and the pull request's
  diff go in the state, the diff fenced and capped as a watchpoint's question is (`questionDiff`).
- It only logs. The call's row is `JudgeOutcome.Shadow` (the answer names the questions read as yes, the
  confidence is the least sure of the three, every probability is on the row), and one `ownership.shadow` event
  (`OwnershipShadowData`) carries the answers, the guardrail hit count and what `ownershipTest` made of them. No
  card, hold, move or merge reads either one: the hold is the path list's alone
  (`delivery/guardrail-hold.ts`), and that file does not import this module.
- `delivery/ship.ts` queues it once per ship of a root batch (never a CI-fix batch or a catch-up), after the
  pull request is recorded, as a job under its own key, so the ship waits for nothing and a failure only logs. The
  job reads from the project's repository by SHA, since the shipped worktree may be gone by then.
- Without a Decisions account there is no answer: the judge logs its `fallback_no_key` row and no event is sent.
  With the decision or the whole judge switched off nothing is asked or logged. `OwnershipTest` is in the judge's
  `SESSION_EXCLUDED`, so a project's own Claude or Codex plan is never spent on it.
- Letting these answers act is a later decision, after a week of logged calls have been read against what was
  actually answered.
