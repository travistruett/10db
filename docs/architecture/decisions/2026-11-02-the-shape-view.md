# The Shape view reads one route, opens a conversation on its first message, and builds slice 1's screen without new dependencies

- **Date:** 2026-11-02
- **Amends:** `decisions/2026-11-02-shape-is-an-sdk-session-in-10dbs-own-ui.md` (how the screen is built in slice 1)

## Decision

**Built (Shape slice 1, part 3):**

- **Routes.** `GET /shapes/:shapeId` answers `ShapeViewDto`: the transcript, every proposal with its typed body
  and what Convert made of it, the latest `note_heard` echo and the turn (`running`, `queued`, `proposing`). The
  screen reads only this and the project's conversation list; `shape.changed` refetches both. The actions are
  `POST /projects/:id/shapes`, `/shapes/:id/messages`, `/propose`, `/stop`, `/convert`,
  `POST /goals/:id/remove-draft` and `POST /shapes/:id/decisions/:id/withdraw`. A Convert refusal is a 400
  `{errors}`, as the adopt route's is.
- **`/shape` is a new conversation that does not exist yet.** The daemon makes the conversation on the first
  message sent, so browsing Shape leaves no empty rows; the nav lists a conversation only once it exists.
- **Adopt a Plan…'s UI is gone** (`adopt-plan.tsx`, `use-adopt-plan.ts`, `desktop/choose-plan.ts`,
  `useAdoptGoal`); Factory's primary is Shape Work…, a link to `/shape`. The adopt route stays.
- **The Proposed rows are buttons over regions**, as Factory's goal rows are, so Enter opens a row and ↑/↓ move
  between them with a roving tab stop. The spec's Enter-edits, P and W belong to slice 2, when rows edit.
- **Remove Draft Goal and Withdraw Decision… sit on the converted row's menu in the sidebar.** Remove Draft Goal
  is also in the Board's goal line menu and in Factory's open goal (the Board has no goal drawer), behind the
  same confirm. It is offered only for a goal a conversation made (`GET /goals/:id/shape`) whose digest status
  is Not started (`goal.state` stays Draft for life, so it says nothing here). A conversation's goal with a task
  that has started says why in Factory instead, except a Shipping or Done goal, whose work is finished.
- **Model text is plain text.** No markdown renderer is a dependency, so chat and row text show as text with
  line breaks and are never markup.
- **The transcript is a virtual list.** `@tanstack/react-virtual` (the builder's choice, pinned at 3.14.25, the
  newest `minimumReleaseAge` allows) mounts only the blocks near the viewport, measuring each as it mounts. Why?
  and stick-to-bottom go through the virtualizer, since their block may not be mounted. The cost is that ⌘F and a
  drag-select reach mounted text only. Blocks are not memoized: about twenty mount at a time, and a new message
  rebuilds every block object anyway. `content-visibility: auto` stays on the Proposed rows, which are few.
  `e2e/shape.spec.ts` checks 2,000 messages in WebKit; a sandboxed gate skips e2e, so CI is what runs it.
- **The header shows the conversation's tokens** ("88k tokens", through the factory's `formatTokens`), from
  `ShapeViewDto.tokens`: the input and output tokens summed over the conversation's `sessions` rows
  (`shapeTokens`), the rows per-project usage reads. Cached tokens are a subset of input, so they are not added.
  It is read with the rest of the view, and a turn's end announces `shape.changed` after its usage is written, so
  the header updates as turns finish. Nothing shows before the first turn.
- **The Proposed summary counts what is pending**, with converted rows counted apart; the pull-request count is
  the number of landings, and hours and open findings come with their slices.

## Why

- One read for the whole screen keeps the transcript, the proposals and the round from disagreeing with each
  other, which is the spec's "one source per field" at the UI.
- A conversation made on the first send avoids the daemon holding a row, a session and a nav entry for a builder
  who only opened the view.
- A button over a region is the repository's own row pattern (Factory), already accessible, and carries the
  arrow keys without a listbox's rule against controls inside its options.
