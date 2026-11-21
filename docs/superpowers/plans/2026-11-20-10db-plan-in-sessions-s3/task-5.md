# Task 5: live states on accepted rows

**Spec:** §2 The Plan panel ("A row shows … a dot for its state (proposed, changed this round, pinned, accepted,
running, done)"; "After Accept a row reads 'On the Board' with its live state … and opens the task on the Board,
whose drawer opens its session"); §1 (the Running state: "the panel shows each task's live state").
**Track:** B. Read `apps/desktop/src/views/sessions/plan/AGENTS.md` and `apps/desktop/src/views/board/AGENTS.md`
once. Needs nothing new from the daemon, so it starts beside Task 1.

## Interfaces it implements or calls (quoted)

```ts
// apps/desktop/src/daemon/queries.ts
export function useTasks(projectId: ProjectId | null);
export function useWorkstreams(filter: { readonly active: boolean });
// apps/desktop/src/views/board/task-state.ts
export function taskState(
  workstream: WorkstreamDto | undefined,
  batch: BatchDto | undefined,
  gateCommand: string | null,
  place?: number,
  batches?: readonly BatchDto[],
  task?: RetryTask,
): TaskState | null;
// apps/desktop/src/views/sessions/plan/live-state.ts (this card)
export interface LiveWord { readonly word: string; readonly color: string }
export function taskLiveWord(task: TaskDto | undefined, workstream: WorkstreamDto | undefined): LiveWord;
export function goalLiveLine(words: readonly LiveWord[]): string;
export function liveDot(words: readonly LiveWord[]): 'running' | 'done' | null;
```

`rowDot` in `proposal-text.ts` is read in the code. Its labels today are Accepted, New this round, Changed this
round, Moved to Earlier, Pinned and Proposed.

## The words

These are the words Factory's task list and the task drawer use for a task's state, not the Board's column
labels (the index's call 4). `taskLiveWord(task, workstream)` is the first case that holds:

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

- Take the colors from the Board's status colors if it has a map (`views/board/`). Otherwise use these.
- `goalLiveLine(words)` counts the words in this order: Running, Queued, Needs you, In review, Ready, Waiting,
  Done, Removed. Zero counts are left out, and the words are lower-cased after a count. A goal of one task says
  its word alone ("Running"). Examples: "2 ready", "2 running · 1 queued · 1 done".

## The dot (the review's F4 ruling, spec §2's dot states)

`liveDot(words)`:
- `'running'` while any word is Running;
- `'done'` when every word that isn't Removed is Done, and at least one is;
- `null` otherwise.

`rowDot` takes the live part as a new optional argument:
- an accepted row shows **Running** or **Done** when `liveDot` says so, and **Accepted** otherwise;
- every other word keeps the Accepted dot.

Extend `rowDot`'s result union with `'running'` and `'done'`. Each switch over it (labels, colors) stays
exhaustive, which the linter checks. A decision or principle row passes no live part and keeps Accepted.

## Files

### `apps/desktop/src/views/sessions/plan/live-state.ts` (new, pure)

The three functions above.

### `apps/desktop/src/views/sessions/plan/proposal-row.tsx` and `proposal-text.ts`

- An accepted row (`row.converted !== null`) of kind `goal` or `task` replaces its destination text, "Accepted ·
  on the Board":
  - a task reads "On the Board · <word>";
  - a goal reads "On the Board · <goalLiveLine>".
- The word reads its task from `useTasks(projectId)`. Its latest run is the task's `workstreamId` looked up in
  the cached workstreams the Board already reads for each task. Read that cache rather than adding a query.
- A decision or principle keeps "Accepted · in Knowledge".
- The dot is `rowDot(row, liveDot(words))`.
- **Opening:**
  - an accepted task row gets a small "Open on Board" link, a `Link` to `/board` with `search={{ task: id }}`, as
    `views/factory/activity-content.tsx` uses;
  - a goal's link opens its first task that isn't done, else Factory's goal (`/factory?goal=<id>`);
  - clicking the row itself still opens it in place, as today.
- The panel's project id is the chat's, which `plan-panel.tsx` has.

## State-table rows

- Rows accepted | Task or run event.
- Accepted row | A task starts running.
- Accepted row | Builder clicks Open on Board.
- Accepted task | Removed from the Board.
- Accept and Start | The cut fails later (the row half).

## Tests

None. The words and the dot are a view, and the e2e reads them. Count is a cost (`testing.md`).

## Done when

- Typecheck, ESLint and `vitest related` on the changed files pass.
- The existing New Plan e2e still passes. Move its "Accepted · on the Board" expectations in this card's commit:
  - the goal row reads "On the Board · 2 ready";
  - each loose task row reads "On the Board · Ready".

  That is the one e2e edit this card makes. Task 6 extends the rest.
- `make precheck` is green.
