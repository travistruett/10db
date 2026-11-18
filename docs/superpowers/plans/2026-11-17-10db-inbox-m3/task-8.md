# Task 8: run it against the real daemon, then the e2e

**Spec:** app shell spec §4.1 Inbox, "Performance" ("Budget", the e2e half); §8 Tests (e2e).
**State rows:** run by hand against the real daemon: 1, 3, 4, 14, 15, 19, 23.

## Files

- Create `apps/desktop/e2e/inbox.spec.ts` and `apps/daemon/scripts/seed-inbox-cards.ts`.
- Modify the e2e specs that select the old Inbox:
  - `e2e/loop.spec.ts`: the Inbox steps near "skipped while away", and the "Dismiss" radio;
  - `e2e/process-per-rigor.spec.ts`: the plan card opened in the Inbox;
  - `e2e/sessions.spec.ts`: the Inbox card after ⌘J;
  - `e2e/stakeholder-questions.spec.ts`: the Inbox page.

  Change only their selectors. What each checks stays.

## The seed script

`seed-inbox-cards.ts <database> <json>` follows `seed-question-card.ts`. The JSON is
`{ projectId, count, state: 'open' | 'resolved', grouped?: number }`.
- It writes `count` cards in one `store.write`: flags with distinct titles, every tenth one a question.
- With `grouped`, that many sets of three identical flags are among them.
- For `resolved`, each card is answered through the store's answer function, with `updated_at` one minute apart.

`inbox.spec.ts` seeds into **its own project**, named `e2e-inbox` and made by the spec as
`stakeholder-questions.spec.ts` makes its own. Every query and assertion is narrowed to it (`?project=`), so other
specs in the shard see none of its cards. It resolves every open card it seeded in an `afterAll`, through
`POST /inbox/:id/answer`.

## Steps

1. **Run it.**
   - Start the real daemon and the desktop dev build, as `apps/desktop/AGENTS.md` says (`pnpm dev`).
   - Seed 2,000 open cards (50 grouped sets) and 2,000 resolved cards into its data directory.
   - Click through in dark and light at 1280, 900 and 480 px:
     - Open, Waiting and Resolved;
     - `j`/`k` past the first 50;
     - answer a question with a digit and Enter, and see the next row selected;
     - Dismiss All on a group;
     - `e`;
     - search;
     - each filter;
     - leave for Board and come back;
     - the panel over the content at 900 px;
     - restart the daemon and watch the list come back.
   - Fix what you see before anyone reviews. Screenshots go to the run's scratch folder.
2. **e2e**, `inbox.spec.ts` (WebKit, the real daemon). Each time is measured from the first `/inbox/page` request
   (`page.waitForRequest`) to the first `[data-inbox-row]` being visible, not from `page.goto`:
   - **Open at scale,** the expensive path: seed 2,000 open flags, 50 of them in grouped sets. Open's first row
     shows in under 2,000 ms, and the first request asks `pageSize=50`. Fewer than 100 `[data-inbox-row]` are in
     the DOM. A grouped row reads `×3`.
   - **One lookup.** Answer the first row with Dismiss. The `card=` request that follows answers in under 500 ms
     (`page.waitForResponse`), and the row leaves.
   - **Resolved at scale:** seed 2,000 resolved cards. The first row shows in under 2,000 ms. Scroll the listbox to
     the end of what's loaded: a request with `after` goes out, and the row count grows past 50.
   - **Answer:** with 3 open questions in the project, answer the first with `1` and Enter. The second is selected,
     and the rail badge drops by one.
   - **Search:** type a seeded title. One row shows, and the URL holds `q`.
   - **Accessibility:** `expectAccessible(page, 'inbox panel, dark')`, and the light run.
3. Update the four specs' selectors.
4. Run the specs you touched: `pnpm --filter @10db/desktop exec playwright test e2e/inbox.spec.ts e2e/loop.spec.ts
   e2e/process-per-rigor.spec.ts e2e/sessions.spec.ts e2e/stakeholder-questions.spec.ts`.
5. Commit the specs and the seed script, with the message `test(desktop): the inbox panel end to end, 2,000
   cards`. The body carries:

   ```
   Value: protects=the first page of a large Inbox, Open's grouped scan included, and one row lookup
     are fast in the real app; fails_when=the panel loads the whole list, the grouped scan is slow,
     or the first page waits on counts; why_new=no e2e seeded more than one card; no_claim=60 fps
     scrolling
   ```
