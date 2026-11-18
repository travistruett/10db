# Task 1: contracts — the row key, the sort, the query and the page

**Spec:** app shell spec §4.1 Inbox, "Performance" ("The route grows a cursor"); decision
`docs/architecture/decisions/2026-11-16-the-open-inbox-is-paged-by-row-and-the-daemon-groups-the-rows.md`.
**State rows:** none directly. This card is the pure base for rows 4-8.

## Files

- Create `packages/contracts/src/inbox-rows.ts` and `inbox-rows.test.ts`.
- Modify `packages/contracts/src/inbox-page.ts` and `packages/contracts/src/index.ts` (one export line).
- Modify `apps/desktop/src/views/inbox/inbox-rows.ts`: `isDismissable` becomes a re-export from `@10db/contracts`,
  so the desktop keeps compiling. Task 6 deletes the file.

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
//   < 0 when a shows first; resolved runs newest first
export const InboxRowRef = z.object({ key: z.string().min(1), sort: InboxRowSort, passId: PassId.nullable(),
  ids: z.array(InboxItemId).nonempty() });   // the row's cards, by id, in list order

// packages/contracts/src/inbox-page.ts (extended)
// InboxPageQuery gains:
//   after: the last row's sort, as JSON (string → InboxRowSort)
//   q: z.string().trim().min(1).max(200)   (title or body, case-insensitive)
//   since: z.iso.datetime()                (resolved only: updated at or after)
//   card: InboxItemId                      (the page holds only that card's row, when it's in the list)
//   page becomes optional (1 when absent).
// Refused with a 400: after with page, sort or dir; card with after or page; since outside resolved.
// InboxPageDto gains:
//   rows: z.array(InboxRowRef)   (one per card in waiting and resolved)
//   next: InboxRowSort.nullable()   (`after` for the next page; null on the last)
// `items` stays: the rows' cards, in order. `pageSize` counts rows. Open's `total` counts the rows with a card
// that triage has placed.
export const InboxCardContextDto = z.object({
  messages: z.array(z.object({ author: z.enum(['builder', 'agent']), text: z.string(), at: Timestamp })).max(3),
});
```

`inboxRowKey` is today's `inboxRows` in `apps/desktop/src/views/inbox/inbox-rows.ts`, moved. A Ready page is
checked first, then a dismissable card, then the card's own id. A failed turn's flag has options, so it keeps its
own row. `after` is a string in the query that the schema parses into `InboxRowSort`. Use `z.string().transform`
and `.pipe`, with the JSON parse inside a `safeParse`-style transform that adds a zod issue. That's the validated
boundary, so it needs no cast. The refusals are one `superRefine` on `InboxPageQuery`, each with its own message.
The `rows` comment in the module says how a row holds its cards.

## Steps

1. **Red.** Write `inbox-rows.test.ts`, three tables:
   - `inboxRowKey`, one row per case:
     - a question → its id;
     - a flag with no options → `flags:["prj_…","T","B"]`;
     - the same flag in another project → a different key;
     - a flag with options (a failed turn) → its id;
     - a `playbook_move_report` with none → `flags:` key;
     - a `check` whose detail is a valid `PassCheckDetail` → `pass:<passId>`;
     - a `check` with any other detail → its id.
   - `inboxRowSort`, one row per state, plus a `low` urgency → rank 2 and a waiting card with no send → `[1, '', id]`.
   - Port every grouping row of `apps/desktop/src/views/inbox/inbox-rows.test.ts` (its `inboxRows` and
     `isDismissable` cases) into these tables as key rows. Task 6 deletes that file with the code it tests.
   - `compareRowSort`:
     - open, by rank, then at, then id;
     - resolved, the newer first;
     - equal → 0.
   - Run `pnpm --filter @10db/contracts exec vitest run src/inbox-rows.test.ts`. Expected: fails, because the
     module is missing.
2. **Red.** Extend `inbox-page.test.ts` if one exists, or add the rows to `inbox-rows.test.ts`. Table of
   `InboxPageQuery.safeParse`:
   - `after` as valid JSON parses to the tuple;
   - `after` as `'nope'` fails;
   - `after` with `page` fails, with `sort` fails;
   - `card` with `after` fails;
   - `since` with `state: open` fails;
   - `q: '  '` fails;
   - no `page` gives `page: undefined`.
3. Implement both modules. Re-export `isDismissable` from the desktop file.
4. Green. Run `pnpm --filter @10db/contracts exec vitest related src/inbox-rows.ts src/inbox-page.ts --run
   --maxWorkers=2`. Then typecheck contracts, daemon and desktop: the `page` type is now optional, so fix the
   callers that read it.
5. Commit:

   ```
   git add packages/contracts/src/inbox-rows.ts packages/contracts/src/inbox-rows.test.ts \
     packages/contracts/src/inbox-page.ts packages/contracts/src/index.ts \
     apps/desktop/src/views/inbox/inbox-rows.ts && git commit -m 'feat(contracts): the inbox row key, its sort and the keyset page'
   ```

   The body carries:

   ```
   Value: protects=one grouping rule for the daemon and its tests; fails_when=a flag, a pass's
     Ready pages or a failed turn's flag lands in the wrong row, or a cursor sorts wrong;
     why_new=inbox-rows.test.ts in the desktop tests the browser's grouping, which goes;
     no_claim=that the daemon's query calls it (task 2)
   ```
