# Card 1: contracts, schema and stores

**Size:** Core (the shared shapes every later card builds on; one migration). Reviewed in group 1 (cards 1-5).
**Spec:** "The tools" (the table and its bullets), "Evidence".
**Track:** first. Nothing else starts before it merges.

## Files

- **The tools' contract.** `packages/contracts/src/lane-browser.ts` (new), exported from
  `packages/contracts/src/index.ts`.
  - `BrowserToolName`, `BrowserAction`, `ElementRef`, `BrowserToolInputs`, `SNAPSHOT_MAX_CHARS`,
    `BROWSER_MAX_PAGES`, `BrowserDialog`, `BrowserAnswer`, as below.
  - `browser_act`'s schema gets a `superRefine`: `fill`, `select` and `press` need `value`; `click` and `check`
    refuse one. Its message names the action.
  - `BROWSER_TOOL_DESCRIPTIONS`: one paragraph each, in the words a model reads. Say, once per tool where it
    applies:
    - it reaches only servers this lane started (a process of its own, or a Docker Compose stack started from its
      copy or temp dir) on `localhost`, `127.0.0.1` or `[::1]`;
    - a refusal is final and says why;
    - refs come from the latest snapshot;
    - an upload takes files in the lane's copy or temp dir;
    - a screenshot is kept on the task as evidence, sent as an image when it fits the account's limits, and its
      PNG's path is in every answer.
- **Screens.** `packages/contracts/src/task-screens.ts`:
  - `ScreenKind` gains `Lane: 'lane'`.
  - `TaskScreenDto` gains `url` (origin and path, at most 2,048 characters), `title` (at most 512) and `note`,
    each nullable, null on every kind but `lane`.
  - The file's header comment says lane screens are taken by a lane's own browser and are sent to its model
    (`decisions/` file in card 7).
- **Evidence.**
  - `packages/contracts/src/states.ts`: `EvidenceKind` gains `Browser: 'browser'`, with a one-line comment.
  - `packages/contracts/src/entities.ts`: `EvidenceDto` gains the browser variant, and its comment names it.
- **Schema.** `packages/db/src/schema.ts`:
  - `task_screens` gains `url`, `title`, `note` and `sent_session_id` (the session that got the picture as an
    image block, which card 5's budget reads), all nullable text.
  - `evidence` gains `screen_id`, nullable, referencing `task_screens.id`.
  - The tables' comments say what each holds.
- **Stores.**
  - `packages/db/src/store/task-screens.ts`:
    - `NewTaskScreen` gains the optional `lane`; `insertTaskScreen` writes its four fields, nulls without it.
    - `columns` reads `url`, `title` and `note`, so `listTaskScreens` and every other read return them.
      `sent_session_id` stays in the store: add `laneScreenBytesSentTo(db, sessionIds)`, the summed `size` of
      unpruned lane screens sent to any of those sessions.
    - A `lane` screen is never deduplicated: the turn rule stays turn-only.
  - `packages/db/src/store/evidence.ts`:
    - `NewEvidence` gains the browser variant; `insertEvidence` writes `screenId`, null for every other kind.
    - `parseRow` reads it; the other variants ignore the key.
- **Migration.** `pnpm --filter @10db/db generate` once, after the schema change, and commit the generated files.
  This is the branch's dev migration (Global Constraints): it is regenerated at each merge of `main` and after the
  last. Never edit it by hand.
- **Generated contracts.** `pnpm --filter @10db/contracts generate`, and commit what it changes under
  `packages/contracts/generated/` (`make gate`'s drift check fails otherwise).
- **Catalogue.** `docs/architecture/db-storage.md`: the "Workbench pictures" entry gains the `lane` kind and the
  four columns. The evidence entry gains `screen_id` and the `browser` kind.
- **Callers.** Run the typechecks of `@10db/contracts`, `@10db/db`, `@10db/daemon` and `@10db/desktop`.
  - `apps/desktop/src/views/workbench/screen-alt.ts` `WHEN` gains `[ScreenKind.Lane]: 'from the lane's browser'`.
  - Any other exhaustive switch over `ScreenKind` or `EvidenceKind` the typecheck names gets its real answer. A
    lane screen is never a before or an after. Browser evidence is never a gate's.
  - Where a caller needs a later card's behaviour, add the smallest shim marked `// TODO(lane-browser)`.

## Interfaces it implements

From the index, word for word:

```ts
// packages/contracts/src/lane-browser.ts (card 1), exported from the package entry
export const BrowserToolName = {
  Open: 'browser_open',
  Snapshot: 'browser_snapshot',
  Act: 'browser_act',
  Upload: 'browser_upload',
  Screenshot: 'browser_screenshot',
} as const;
export type BrowserToolName = (typeof BrowserToolName)[keyof typeof BrowserToolName];
export const BrowserAction = {
  Click: 'click', Fill: 'fill', Select: 'select', Check: 'check', Press: 'press',
} as const;
export type BrowserAction = (typeof BrowserAction)[keyof typeof BrowserAction];
/** A ref from the latest snapshot, as `[ref=e12]` prints it. */
export const ElementRef = z.string().regex(/^[A-Za-z0-9]{1,32}$/);
export const BrowserToolInputs = {
  [BrowserToolName.Open]: z.strictObject({ url: z.string().min(1).max(2048), viewport: ScreenViewport.optional() }),
  [BrowserToolName.Snapshot]: z.strictObject({}),
  [BrowserToolName.Act]: z.strictObject({
    ref: ElementRef,
    action: z.enum(BrowserAction),
    /** The text to fill, the option to select, or the key to press; refused for click and check. */
    value: z.string().max(10_000).optional(),
    /** Accepts a `confirm` or `prompt` the action raises; absent, it is dismissed. */
    dialog: z.literal('accept').optional(),
  }),                                   // a superRefine: fill, select and press need `value`; click and check refuse it
  [BrowserToolName.Upload]: z.strictObject({ ref: ElementRef, paths: z.array(z.string().min(1).max(4096)).min(1).max(10) }),
  [BrowserToolName.Screenshot]: z.strictObject({ fullPage: z.boolean().optional(), note: z.string().max(500).optional() }),
} as const satisfies Record<BrowserToolName, z.ZodType>;
export const BROWSER_TOOL_DESCRIPTIONS: Record<BrowserToolName, string>;
/** The most characters of a snapshot an answer carries; a longer one is cut and says so. */
export const SNAPSHOT_MAX_CHARS = 24_000;
/** The most pages a session's browser holds open; a fifth closes the oldest. */
export const BROWSER_MAX_PAGES = 4;
export const BrowserDialog = z.object({
  type: z.enum(['alert', 'beforeunload', 'confirm', 'prompt']),
  message: z.string(),
  answer: z.enum(['accepted', 'dismissed']),
});
/** What every tool but `browser_screenshot` answers, as JSON text. */
export const BrowserAnswer = z.object({
  /** The current page: its URL after redirects, its title, and the status of its last navigation. */
  page: z.object({ url: z.string(), title: z.string(), status: z.int().nullable() }).nullable(),
  /** Every open page, oldest first; `current` marks the one the snapshot reads. */
  pages: z.array(z.object({ url: z.string(), title: z.string(), current: z.boolean() })),
  snapshot: z.string().nullable(),
  snapshotCut: z.boolean(),
  /** Each request refused since the last answer: `<method> <origin><path>: <why>`, never the query. */
  refused: z.array(z.string()),
  dialogs: z.array(BrowserDialog),
  /** What else the lane should know: cookies cleared after an idle close, a page closed for a fifth. */
  notes: z.array(z.string()),
});
export type BrowserAnswer = z.infer<typeof BrowserAnswer>;

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

// packages/db/src/schema.ts (card 1)
// task_screens: url: text('url'), title: text('title'), note: text('note'),
//   sentSessionId: text('sent_session_id').$type<SessionId>()                         // all nullable
// evidence: screenId: text('screen_id').$type<TaskScreenId>().references(() => taskScreens.id)   // nullable

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
```

## Interfaces it reads

From the index, word for word:

```ts
// packages/contracts/src/task-screens.ts
export const ScreenKind = { Before: 'before', Turn: 'turn', After: 'after' } as const;

// packages/contracts/src/entities.ts
// EvidenceDto: z.discriminatedUnion('kind', [...]) over EvidenceBase
//   { id, workstreamId, summary, logPath, commitShas, createdAt } with command/exitCode per kind

// packages/db/src/store/task-screens.ts
export interface NewTaskScreen {
  readonly taskId: TaskId; readonly turnId: PassTurnId | null; readonly kind: ScreenKind;
  readonly route: string; readonly viewport: ScreenViewport; readonly theme: ScreenTheme;
  readonly sha256: string; readonly size: number; readonly width: number; readonly height: number;
  readonly storedPath: string; readonly keptSha: string | null;
}
```

## State-table rows

None directly: these are the shapes the rows are written in. `NewTaskScreen.lane` stays optional, so
`pictures/pictures.ts` (the peer's file tonight) and every other caller compile unchanged.

## Tests

None new. A type and a column earn no test (`.claude/rules/testing.md`). The existing migration and store tests
must stay green.

## Done when

- The checks in Global Constraints pass, and the four packages typecheck.
- The dev migration is committed, generated, not hand-written.
- `git grep 'TODO(lane-browser)'` lists only shims a later card names.
