# Task 1: contracts — the row key, the sort, the query and the page

**Spec:** app shell spec §4.1 Inbox, "Performance" ("The route grows a cursor"); decision
`docs/architecture/decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`.
**State rows:** 22 (the Resolved tie, in `compareRowSort`). This card is the pure base for rows 4-8.

## Files

- Create `packages/contracts/src/inbox-rows.ts` and `inbox-rows.test.ts`.
- Modify, in `packages/contracts/`:
  - `src/inbox-page.ts`;
  - `src/inbox-page.test.ts` (create it if there is none);
  - `src/index.ts` (export lines);
  - `src/json-schema.ts`: `'inbox-card-context-dto': InboxCardContextDto` in `CONTRACT_SCHEMAS`.
- Regenerate with `pnpm --filter @10db/contracts generate`, and commit:
  - `packages/contracts/generated/inbox-page-query.schema.json`;
  - `packages/contracts/generated/inbox-page-dto.schema.json`;
  - the new `packages/contracts/generated/inbox-card-context-dto.schema.json`.

  `contracts.test.ts` compares them byte for byte.
- Modify `packages/db/src/store/inbox-page.ts`. `pageInbox` fills `rows` (one per card: `key` = id, `sort` from
  `inboxRowSort`, `passId: null`, `ids: [id]`) and `next: null`, and reads `q.page ?? 1`. Add rows in
  `packages/db/src/store/inbox-page.test.ts` checking that `rows` mirror `items` in every existing case.
- Modify `apps/desktop/src/daemon/queries.ts`: `useInboxPage` sends `page` only when it's set.
- Modify `apps/desktop/src/views/inbox/inbox-rows.ts`:
  - `isDismissable` becomes a re-export from `@10db/contracts`;
  - `inboxRows` folds by `inboxRowKey`, so the desktop's interim grouping is the same rule;
  - its tests stay green. Task 6b deletes the file.

## Interfaces (implement, exactly)

```ts
// packages/contracts/src/inbox-rows.ts (pure)
export type InboxRowCard = Pick<InboxItemDto, 'id' | 'kind' | 'projectId' | 'title' | 'body' | 'options' | 'detail'>;
export function isDismissable(card: Pick<InboxItemDto, 'kind' | 'options'>): boolean;   // moved from the desktop
export function readyPassOf(card: InboxRowCard): PassId | null;   // a Ready page's pass (PassCheckDetail), else null
export function inboxRowKey(card: InboxRowCard): string;
//   `pass:<passId>` | `flags:${JSON.stringify([projectId, title, body])}` for a dismissable card | the card's id
export const InboxRowSort = z.tuple([z.int().min(0), z.string(), InboxItemId]);   // [rank, at, id]
export type InboxRowSort = z.infer<typeof InboxRowSort>;
export interface SortCard { readonly id: InboxItemId; readonly urgency: Urgency; readonly createdAt: string;
  readonly updatedAt: string; readonly sentAt: string | null }
export function inboxRowSort(state: InboxListState, card: SortCard): InboxRowSort;
//   open [high 0 | normal 1 | low 2, createdAt, id] · waiting [sentAt === null ? 1 : 0, sentAt ?? '', id]
//   · resolved [0, updatedAt, id]
export function compareRowSort(state: InboxListState, a: InboxRowSort, b: InboxRowSort): number;
//   < 0 when a shows first; resolved runs newest first. Strings compare by code unit (<, >), as SQLite's BINARY
//   collation does, never localeCompare; a tie on `at` falls to the id, descending for resolved.
export const InboxRowRef = z.object({ key: z.string().min(1), sort: InboxRowSort, passId: PassId.nullable(),
  ids: z.array(InboxItemId).nonempty() });   // the row's cards, by id, in list order

// packages/contracts/src/inbox-page.ts (extended)
// InboxPageQuery gains:
//   after: the last row's sort, as JSON (string → InboxRowSort)
//   q: z.string().trim().min(1).max(200)   (title or body; LIKE, ASCII case folded)
//   since: z.iso.datetime()                (resolved only: updated at or after)
//   card: InboxItemId                      (the page holds only that card's row, when it's in the list)
//   page becomes optional (1 when absent).
// Refused with a 400: after with page, sort or dir; card with after or page; since outside resolved.
// InboxPageDto gains:
//   rows: z.array(InboxRowRef).default([])   (one per card in waiting and resolved)
//   next: InboxRowSort.nullable().default(null)   (`after` for the next page; null on the last)
// `items` stays: the rows' cards, in order. `pageSize` counts rows. A keyset or card answer has page 1. Open's
// `total` counts the rows with a card that triage has placed.
export const InboxCardContextDto = z.object({
  messages: z.array(z.object({ author: z.enum(['builder', 'agent']), text: z.string(), at: Timestamp })).max(3),
});

// packages/db/src/store/inbox-page.ts
export function pageInbox(db: DbReader, q: InboxPageQuery, placement: InboxPlacement): InboxPageDto;
```

`placement` arrives in Task 2. Here `pageInbox` keeps its two arguments.

- `inboxRowKey` is today's `inboxRows` rule in `apps/desktop/src/views/inbox/inbox-rows.ts`, moved. A Ready page
  is checked first, then a dismissable card, then the card's own id. A failed turn's flag has options, so it keeps
  its own row.
- `after` is a string in the query that the schema parses into `InboxRowSort`, with `z.string().transform` and
  `.pipe`. The JSON parse goes inside a transform that adds a zod issue on failure. That's the validated boundary,
  so it needs no cast. `CONTRACT_SCHEMAS` renders with `io: 'input'`, so the transform is fine there.
- The refusals are one `superRefine` on `InboxPageQuery`, each with its own message.
- The defaults on `rows` and `next` keep every older fixture and reader parsing, M2's `chat-tab.test.tsx` among
  them.

## Steps

1. **Red.** Write `inbox-rows.test.ts`, three tables:
   - `inboxRowKey`, one row per case:
     - a question → its id;
     - a flag with no options → `flags:["prj_…","T","B"]`;
     - the same flag in another project → a different key;
     - a flag with options (a failed turn) → its id;
     - a `playbook_move_report` with none → a `flags:` key;
     - a `check` whose detail is a valid `PassCheckDetail` → `pass:<passId>`;
     - a `check` with any other detail → its id.
   - Port every grouping row of `apps/desktop/src/views/inbox/inbox-rows.test.ts` (its `inboxRows` and
     `isDismissable` cases) into these tables as key rows.
   - `inboxRowSort`: one row per state, plus a `low` urgency → rank 2, and a waiting card with no send →
     `[1, '', id]`.
   - `compareRowSort`:
     - open, by rank, then at, then id;
     - resolved, the newer first;
     - **resolved tie:** the same `at` → the greater id first;
     - **code units:** `'Z' < 'a'`, as SQLite orders them, where `localeCompare` disagrees;
     - equal → 0.

   Run `pnpm --filter @10db/contracts exec vitest run src/inbox-rows.test.ts`. Expected: fails, because the module
   is missing.
2. **Red.** In `inbox-page.test.ts`, a table of `InboxPageQuery.safeParse`:
   - `after` as valid JSON parses to the tuple;
   - `after: 'nope'` fails;
   - `after` with `page` fails, and with `sort` fails;
   - `card` with `after` fails;
   - `since` with `state: open` fails;
   - `q: '  '` fails;
   - no `page` → `page: undefined`.

   Then `InboxPageDto.parse` of an answer without `rows` and `next` → `[]` and `null`.
3. Implement. Then `pageInbox`'s `rows`, `next` and `q.page ?? 1`, the `useInboxPage` fix and the desktop's
   `inboxRows` over `inboxRowKey`. Run `pnpm --filter @10db/contracts generate`.
4. Green. Run `pnpm --filter @10db/contracts exec vitest related src/inbox-rows.ts src/inbox-page.ts
   src/json-schema.ts --run --maxWorkers=2`, then `pnpm --filter @10db/db exec vitest related
   src/store/inbox-page.ts --run --maxWorkers=2` and `pnpm --filter @10db/desktop exec vitest related
   src/views/inbox/inbox-rows.ts src/daemon/queries.ts --run --maxWorkers=2`. Then typecheck contracts, db, daemon
   and desktop.
5. Commit, naming every path:
   - `packages/contracts/src/inbox-rows.ts`, `inbox-rows.test.ts`, `inbox-page.ts`, `inbox-page.test.ts`,
     `index.ts` and `json-schema.ts`;
   - the three `generated/*.schema.json` files;
   - `packages/db/src/store/inbox-page.ts` and `inbox-page.test.ts`;
   - `apps/desktop/src/daemon/queries.ts`;
   - `apps/desktop/src/views/inbox/inbox-rows.ts`.

   The message is `feat(contracts): the inbox row key, its sort and the keyset page`. The body carries:

   ```
   Value: protects=one grouping rule and one sort for the daemon and the browser; fails_when=a flag,
     a pass's Ready pages or a failed turn's flag lands in the wrong row, or a Resolved tie sorts
     differently from SQLite; why_new=the desktop's inbox-rows.test.ts tests only the browser's
     grouping; no_claim=that the daemon's query calls it (task 2)
   ```
