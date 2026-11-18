# Task 9: run it against the real daemon, the e2e, and the desktop docs

**Spec:** the roadmap's S1 tests: "One e2e: a deleted empty branch shows in Activity, and Open's count doesn't move".

**State rows:** 2, 5 and 9, run by hand. **Part:** B. **Consumes:** Tasks 1-8.

## Files

- Create `apps/desktop/e2e/inbox-activity.spec.ts`. If main's M3 `inbox.spec.ts` has its own project and fixtures
  that fit, add a `test.describe` there instead, and say so in the commit.
- Modify `apps/daemon/scripts/seed-worktree-batches.ts`. Each `open` entry may give `branch` and `baseSha`, which
  are written with `patchBatch` in place of the slug and the zero sha. That lets a seeded batch's branch be a real
  one.
- Modify `apps/desktop/src/views/inbox/AGENTS.md`: Activity's item, its reads, that it's never counted, and the
  live refetch.
- Modify `DESIGN.md`: the Inbox line gains the Activity item and the `NOTICE` tag. Follow how M3 wrote its Inbox
  line.

## The e2e

1. In its own project, made as M3's `inbox.spec.ts` or `stakeholder-questions.spec.ts` makes one, on a disposable
   repository built by the spec's helper. Copy `createRepository` from `worktree-board.spec.ts`, with
   `maintenance.auto=false`, `gc.auto=0` and `receive.autogc=false`:
   - make a branch `10db/activity-e2e` at `HEAD`, with no commits beyond it;
   - seed one open batch on that branch, with `baseSha` = `HEAD`, through the extended seed script.
2. Read Open's count: `GET /inbox/page?state=open&pageSize=1&project=<id>` → `total`. Read the rail's Inbox badge
   too, or its absence.
3. `POST /batches/<id>/abandon`.
4. Wait, with a deadline and no sleep, until `GET /activity/page?project=<id>` has a row whose line is
   `Batch "<title>" abandoned: 10db/activity-e2e deleted`.
   - **Check first** that abandoning a seeded batch reaches `settleBranch` (`delivery/branch-cleanup.ts`), through
     `retireWorktree` for a worktree project or `ship.ts:643` for a shared one. Pick the project's delivery mode
     that does.
   - If neither does without a real worktree, seed the worktree too: `git worktree add` in the spec, and its path
     in the batch row.
5. In the app: open the Inbox, choose Activity, and see the row. Selecting it shows its body.
   `expectAccessible(page)`.
6. Open's count, read again, is unchanged, and so is the rail badge. No `inbox.opened` event came for the project
   (read `GET /inbox?state=OPEN` filtered to it: none new).
7. `afterAll` removes nothing it doesn't own. The project and the repository live under `E2E_DIR`.

## Steps

1. **Run it.** Start the real daemon and the dev build, as `apps/desktop/AGENTS.md` says.
   - Post notices by abandoning a batch with an empty branch, and by resizing a running task through its lane, or
     whichever notice is easiest to reach by hand.
   - Watch Activity update while it is shown (row 2), and a task's drawer list its notice (row 5). Restart the
     daemon and watch the list refetch (row 9).
   - Check dark and light at 1280 and 480 px.
   - Fix what you find, and write each fix up with its cause in the commit.
2. **Red.** Write the e2e, and run it before the seed script change: `pnpm --filter @10db/desktop exec playwright
   test e2e/inbox-activity.spec.ts`. Expected: it fails, because the seeded branch isn't real, or the abandon
   raises nothing.
3. Extend the seed script, and run the e2e green.
4. Write the docs. Format the changed files with
   `/Users/travistruett/Projects/10db/node_modules/.bin/prettier --write <files>`.
5. Run `make check-changed` once, the end-of-run check.
6. Commit, naming every path:
   - `test(desktop): a deleted empty branch shows in activity and open's count holds`;
   - then `docs(desktop): the inbox's activity item`.

   The test commit carries:

   ```
   Value: protects=a notice from the real delivery path reaches Activity without touching Open's
     count or the badge; fails_when=the branch-deleted notice is stored as a card, or Activity
     doesn't show it; why_new=the unit and route tests stub the raiser or the read; no_claim=that
     every notice raiser is wired (task 4's tests)
   ```
