# Task 8: run it against the real daemon, then the e2e

**Spec:** app shell spec §4.1 Inbox, "Performance" ("Budget", the e2e half); §8 Tests (e2e).
**State rows:** run by hand against the real daemon: 1, 3, 4, 14, 15, 19.

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
`{ projectId, count, state: 'open' | 'resolved' }`. It writes `count` cards in one `store.write`:
- flags with distinct titles;
- every tenth one a question;
- for `resolved`, each answered through the store's answer function, with `updated_at` spread one minute apart.

## Steps

1. **Run it.**
   - Start the real daemon and the desktop dev build, as `apps/desktop/AGENTS.md` says (`pnpm dev`).
   - Seed 300 open and 2,000 resolved cards into its data directory.
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
2. **e2e**, `inbox.spec.ts` (WebKit, the real daemon):
   - **First page time.** Seed 2,000 resolved cards. Time from `page.goto('/inbox?state=resolved')` to the first
     `[data-inbox-row]` being visible: it's under 2,000 ms. The first request asks `pageSize=50`. Fewer than 100
     `[data-inbox-row]` are in the DOM.
   - **Scroll.** Scroll the listbox to the end of what's loaded: a request with `after` goes out, and the row count
     grows past 50.
   - **Answer.** Seed 3 open questions, then answer the first with `1` and Enter: the second is selected, and the
     rail badge drops by one.
   - **Search.** Type a seeded title: one row shows, and the URL holds `q`.
   - **Accessibility.** `expectAccessible(page, 'inbox panel, dark')` and the light run.
3. Update the four specs' selectors.
4. Run the specs you touched: `pnpm --filter @10db/desktop exec playwright test e2e/inbox.spec.ts e2e/loop.spec.ts
   e2e/process-per-rigor.spec.ts e2e/sessions.spec.ts e2e/stakeholder-questions.spec.ts`.
5. Commit the specs and the seed script, with the message `test(desktop): the inbox panel end to end, 2,000
   cards`. The body carries:

   ```
   Value: protects=the first page of a large Inbox shows fast in the real app; fails_when=the panel
     loads the whole list, or the first page waits on counts; why_new=no e2e seeded more than one
     card; no_claim=60 fps scrolling
   ```
