# A Core plan goes ahead after its review when its brief needs nothing from the builder

- **Date:** 2026-11-27

## Decision

`complete_step` takes `builderCalls` (at most seven `{ owns, call }`). A Plan step sends the calls its brief
needs from the builder, `[]` when none. A Plan Review step sends the calls the plan makes that its brief doesn't
declare. Guardrail changes (the git guard, Codex rules, sandbox profiles, judge policy, trust grants, standing
approvals, `.mcp.json`, hooks, CI) count as calls. They are stored on the step result for Plan and Plan Review,
and dropped for other roles.

Where a plan used to wait for approval, the pure `planGate` in `runner/plan-approval.ts` decides, in order:

1. The rule `plan-goes-ahead` is set to ask: card.
2. No Plan result, or a plan that left `builderCalls` out: card.
3. The plan names calls: card, naming them, owned by the first call's owner.
4. No approving Plan Review after that plan: card.
5. The review found calls: card, naming them.
6. Otherwise the build starts in the same write, with a `plan-goes-ahead` Activity row whose body is the plan
   (undo `final`: send the task back from its drawer).

A card names its reason ("Raised as a card because …") and declares the builder's area.

## Why

A Core plan's card asked the builder to approve work whose only open question was technical, after a reviewer
had already checked it. The builder's calls are what the brief names, so the plan says them and the review
checks for any it left out. A plan from a lane on the old tool text leaves the field out and still cards, so
doubt goes up, never down. A guardrail change is caught only as a declared or found call until a deterministic
path check of plans exists.
