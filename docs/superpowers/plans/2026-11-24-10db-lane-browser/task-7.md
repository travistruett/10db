# Card 7: the drawer, the reporter, the e2e and the docs

**Size:** Feature (UI and words over cards 1-5). It gets one code review, in group 2, after a click-through against
the real daemon.
**Spec:** "Evidence" (the drawer, the reporter, the decision file), "Tests" (the e2e item), "Out of scope".
**Track:** after card 5. May run beside card 6.
**Peer note:** `apps/desktop/src/views/board/task-pictures.tsx` is the task drawer, which session 10db-a2 owns
tonight. The coordinator clears it with 10db-a2 before this card starts, and merges `main` into the integration
branch first if 10db-a2 has changed it.

## Files

- **The drawer.** `apps/desktop/src/views/board/task-pictures.tsx`:
  - `pairsOf` skips `ScreenKind.Lane` as it skips `Turn`, so a lane screen is never shown as an "after".
  - Under the pairs, a group labelled "Lane Screenshots" lists the task's lane screens oldest first. Each is a
    `ScreenPicture` at width 180 with the note as its caption (the URL when there is no note), and the URL in a
    dim line under it.
  - The component returns null only when there are no pairs and no lane screens.
  - `ScreenPicture`'s alt comes from `screen-alt.ts`, which card 1 taught the `lane` kind.
- **The reporter.** `apps/daemon/src/linear/reporter-brief.ts`, where it maps `listTaskScreens` to `shows`: a lane
  screen reads `lane, <url>, "<note>"` (no note: just the URL). `url` is kept without its query (card 5), so no
  query reaches Linear. Evidence already lists `browser: <summary>` by
  kind.
- **The e2e, flow 2.** `apps/desktop/e2e/loop.spec.ts`, first test (a task from the UI to done):
  - Once the task is Done, seed one lane screen and its browser evidence for that task's workstream with a new
    `apps/daemon/scripts/seed-lane-screen.ts`. It calls the db stores as `seed-question-card.ts` does, and writes
    a real PNG through `keepScreen`.
  - Seeding stands in for a lane's `browser_screenshot`. The e2e daemon runs no browser, and a lane would reach
    this state (`apps/desktop/e2e/AGENTS.md`, "A spec seeds a database row … only to reach a state a lane would
    reach").
  - Open the task's drawer and check that the "Lane Screenshots" group shows the note. A reload keeps it.
  - Update flow 2's row in `apps/desktop/e2e/AGENTS.md` with "and a lane's screenshot shows in the drawer".
- **The decision.** A new file in `docs/architecture/decisions/`, dated the day it is written and named
  `lane-screenshots-go-to-the-lanes-model`, in the
  README's format, amending
  `decisions/2026-11-10-task-pictures-come-from-a-pinned-chromium-and-stay-on-the-mac.md`.
  - **Decision:** a `lane` screen, taken by a lane's own browser through `browser_screenshot`, is sent to that
    session's model as an image block when it fits the account's limits. Every other picture stays on the Mac.
    Lane screens prune as turn pictures do.
  - **Why:** the lane needs to see what it tested; the setting that says so is the browser itself; an image is
    what any lane's Read of a PNG already sends.
- **Module notes and the spec.**
  - `apps/daemon/src/pictures/AGENTS.md`: "No picture is uploaded or sent to a model" gains "except a `lane`
    screen", citing the new decision file by its path. (The plan names it without its date: a repo test
    checks that every cited decision file exists.)
  - `apps/daemon/src/lane-browser/AGENTS.md`: read it whole once, and tidy it into one list for the module.
  - `apps/daemon/src/sandbox/AGENTS.md`: one line saying the lane browser's reach is the ownership rule in
    `lane-browser/`, and what it adds to a project with loopback off.
  - `apps/desktop/src/views/board/AGENTS.md` (or the nearest one): the drawer's lane group.
  - The spec's status line becomes "Built, November 2026." with the plan's path.
  - Add no row to `decisions.md`.

## Interfaces it calls

From the index, word for word:

```ts
// packages/contracts/src/task-screens.ts (card 1)
export const ScreenKind = { Before: 'before', Turn: 'turn', After: 'after', Lane: 'lane' } as const;
// TaskScreenDto gains, null on every kind but `lane`:
  /** Origin and path only: the query and fragment are dropped before it is kept. */
  url: z.string().max(2048).nullable(),
  title: z.string().max(512).nullable(),
  note: z.string().nullable(),

// packages/contracts/src/states.ts, entities.ts (card 1)
// EvidenceKind gains Browser: 'browser'. EvidenceDto gains the variant
  z.object({ ...EvidenceBase, kind: z.literal(EvidenceKind.Browser), command: z.null(), exitCode: z.null(),
    screenId: TaskScreenId }),

// packages/db/src/store/task-screens.ts (card 1)
// NewTaskScreen gains, optional, so every caller outside a lane screen is unchanged:
  readonly lane?: {
    readonly url: string; readonly title: string; readonly note: string | null;
    /** The session the picture went to as an image block; null when it went as a path only. */
    readonly sentSessionId: SessionId | null;
  };
/** The summed size of unpruned lane screens sent as image blocks to any of these sessions. */
export function laneScreenBytesSentTo(db: DbReader, sessionIds: readonly SessionId[]): number;
// packages/db/src/store/evidence.ts (card 1): NewEvidence gains
  | (NewEvidenceBase & {
      readonly kind: typeof EvidenceKind.Browser;
      readonly command: null;
      readonly exitCode: null;
      readonly screenId: TaskScreenId;
    })

// apps/daemon/src/pictures/picture-files.ts
export type ScreenToKeep = Omit<NewTaskScreen, 'sha256' | 'size' | 'width' | 'height' | 'storedPath'> & {
  readonly png: Uint8Array;
};
export function keepScreen(state: StateStore, dataDir: string, screen: ScreenToKeep): TaskScreenDto | null
```

## State-table rows

None of its own. It shows card 5's rows: a kept lane screen in the drawer and the brief, and a pruned one hidden.

## Tests

No unit tests (a UI change extends a core e2e flow). The e2e leg above.

## Done when

- The checks in Global Constraints pass.
- You clicked through the drawer against the real daemon (`make dev`, or the `10db-dev-window` skill) with a
  seeded lane screen.
- A screenshot of the drawer's lane group is in your scratch folder and named in your report.
- The e2e leg passes locally (`pnpm --filter @10db/desktop e2e -- loop.spec.ts`, or the repo's e2e command).
