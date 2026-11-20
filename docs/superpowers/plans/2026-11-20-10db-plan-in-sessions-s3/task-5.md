# Task 5: live states on accepted rows

**Spec:** §2 The Plan panel ("After Accept a row reads 'On the Board' with its live state … and opens the task on
the Board, whose drawer opens its session"); §1 (the Running state: "the panel shows each task's live state").
**Track:** B. Read `apps/desktop/src/views/sessions/plan/AGENTS.md` and `apps/desktop/src/views/board/AGENTS.md`
once. Needs nothing new from the daemon, so it starts beside Task 1.

## The words (the index's call 4: the Board's words, not the spec's four)

`taskLiveWord(task, workstream)` is the first that holds:

| Case | Word | Color |
| --- | --- | --- |
| no task in the cache, or `status === cancelled` | Removed | gray |
| latest run `queued` | Queued | blue |
| `boardStatus` `in_progress` | Running | blue |
| `boardStatus` `in_review` | In review | violet |
| `boardStatus` `blocked` | Needs you | orange |
| `boardStatus` `done` | Done | teal |
| `boardStatus` `ready` | Ready | gray |
| `boardStatus` `backlog` | Waiting | gray |

- Take the colors from the Board's own status colors if it has a map (`views/board/`). Otherwise use these.
- `goalLiveLine(words)` counts the words in this order: Running, Queued, Needs you, In review, Ready, Waiting,
  Done, Removed. Zero counts are left out, and a single word is said without its count ("Running" when there
  is one task). Example: "2 running · 1 queued · 1 done".

## Files

### `apps/desktop/src/views/sessions/plan/live-state.ts` (new, pure)

```ts
export interface LiveWord { readonly word: string; readonly color: string }
export function taskLiveWord(task: TaskDto | undefined, workstream: WorkstreamDto | undefined): LiveWord;
export function goalLiveLine(words: readonly LiveWord[]): string;
```

### `apps/desktop/src/views/sessions/plan/proposal-row.tsx` (and `proposal-text.ts`)

- An accepted row (`row.converted !== null`) of kind `goal` or `task` replaces its destination text, "Accepted ·
  on the Board", with "On the Board · <word>" for a task and "On the Board · <goalLiveLine>" for a goal.
- The word reads its task from `useTasks(projectId)`. Its latest run comes from the task's `workstreamId`
  looked up in `useWorkstreams({ active: false })`; use whichever cached query the Board uses for the latest run
  of each task, and read it rather than adding a new one.
- A decision or principle keeps "Accepted · in Knowledge".
- The state dot for these rows stays "Accepted" (`rowDot`), since the word carries the live state.
- **Opening:** an accepted task row gets a small "Open on Board" link, a `Link` to `/board` with
  `search={{ task: id }}`, as `views/factory/activity-content.tsx` uses. A goal's link opens its first task that
  isn't done, else Factory's goal (`/factory?goal=<id>`). Clicking the row itself still opens it in place, as
  today.
- The panel's project id is the chat's, which `plan-panel.tsx` has.

## State-table rows

- Rows accepted | Task or run event.
- Accepted row | Builder clicks.
- Accepted task | Removed from the Board.
- Accept and Start | The cut fails later (the row half).

## Tests

None. The words are a view and the e2e reads them. Count is a cost (`testing.md`).

## Done when

- Typecheck, ESLint and `vitest related` on the changed files pass.
- The existing New Plan e2e still passes. Its "Accepted · on the Board" expectations move to "On the Board ·
  Ready" in this card's commit. That is the one e2e edit this card makes; Task 6 extends the rest.
- `make precheck` is green.
