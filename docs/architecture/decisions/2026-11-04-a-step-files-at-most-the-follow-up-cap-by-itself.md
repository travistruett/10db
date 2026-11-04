# A step files at most MAX_FOLLOW_UPS tasks through propose and file_follow_up together

- **Date:** 2026-11-04
- **Amends:** `decisions/2026-11-03-a-small-lane-proposal-files-itself-to-the-icebox.md`

## Decision

That decision lists the conditions under which 10db files a lane's proposal itself. This adds one: the step
the lane is in must not already have filed as many tasks as a step may.

- **The cap is shared.** `MAX_FOLLOW_UPS` (10, `packages/contracts/src/mcp-tools.ts`) bounds the tasks a step
  files with no person involved through two tools, `propose` and `file_follow_up`. `complete_step`'s `followUps`
  are a separate route, outside this cap (see Not done). A step's count (`stepFilings`,
  `apps/daemon/src/mcp/tools.ts`) is its `file_follow_up` calls plus its `propose` calls that 10db filed to the Icebox itself (a call whose
  recorded result has a `taskId`; a proposal that raised a card, and a principle or note, has none and does not
  count). Both are read from the step's tool-op records, in every session after the step's `sessionFloor`, so a
  handoff, re-launch or recovery inside one step does not reset the count; the next step starts again at zero.
  A replayed `opId` is one record and counts once.
- **Past the cap, `propose` raises a card.** `propose` passes `stepCapReached` (`count >= MAX_FOLLOW_UPS`) to
  `proposalFiling`. A small new-task proposal that would otherwise have been filed is not: it opens the same
  proposal card as any other, whose body ends "Raised as a card because this step has already filed as many
  tasks as a step may, so a person decides." `propose` still answers `{ proposalId, taskId: null }` and is not an
  error; accepting the card files the task as it always did. A call replayed with an `opId` that was filed
  before the cap was reached still answers its original `taskId`.
- **The cap is the last rule.** `proposalFiling` names it only for a proposal that no other rule already
  sent to a card. A declared risk tag, a named risk, `joinsRunningBatch`, a body over the size limit or a zero limit
  shows its own reason, so the cap never hides what the builder most needs to see. The cap changes who decides,
  not what is decided.
- **Past the cap, `file_follow_up` is refused.** It counts the same total, and past it answers an error telling
  the lane to stop filing, put what is left in its summary or handoff, and end its turn. Small proposals 10db
  filed therefore use up the follow-ups a step may file, and the other way round. `propose`'s and
  `file_follow_up`'s tool descriptions say so.
- Nothing else in the 2026-11-03 decision changes: the size limit, the risk scan, the filing into the Icebox and
  the task description are as it says.

## Why

On 2026-11-04 the task "A lane cannot file an unlimited number of tasks to the Icebox through propose" found
that the 2026-11-03 rules let a lane file any number of tasks with no card, while `file_follow_up` was already
limited to ten per step. Small, risk-free proposals meant the Inbox card guarded nothing, but a loop of them
could still fill the Icebox with no person ever looking. A shared cap keeps one bound on what a step may add through
these two tools and puts the next task past it in front of the builder. Counting each tool alone would let a step
file twenty through them. A card, not a refusal, past the cap on `propose`, because a proposal is a request the builder can accept;
`file_follow_up` has no such path and so refuses.

## Not done

- The cap is a constant, not a project setting like the size limit. Raise it only with a decision.
- Cards a step raises past the cap are not themselves capped; they are what the builder is meant to see.
- `complete_step`'s `followUps` do not share the cap. A review, plan review or QA step can file them with no card
  and no refusal; the schema limits them to `MAX_FOLLOW_UPS` per call, on its own. They are not counted in
  `stepFilings`, do not use up the cap, and still work once the cap is reached. Such a step can therefore file
  more on top of the cap: up to `MAX_FOLLOW_UPS` for each `complete_step` call, and nothing limits the calls.
