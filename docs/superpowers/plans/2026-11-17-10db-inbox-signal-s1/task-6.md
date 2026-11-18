# Task 6: daemon — at start, close the open cards that are notices now

**Spec:** the roadmap's S1 bullet "Open cards of a type that is now a notice are withdrawn once at daemon start". It
serves §4.5 "Tiers aren't stored": after this, every open stored flag is an ask, or a status until S2.

**State rows:** 6, 7. **Part:** A. **Consumes:** Task 4. Its raisers no longer make these cards, so after the first
start the sweep finds none.

## Files

- Create `apps/daemon/src/daemon/notice-sweep.ts` and `notice-sweep.test.ts`.
- Modify `packages/db/src/store/inbox.ts`: `OpenFlagRow` and `listOpenFlagRows`, as quoted in the index. It reads
  `id`, `fold_key`, `title`, `body` and the options' length from open `flag` rows. Export them from the package.
- Modify `apps/daemon/src/daemon/start.ts`: one call after the inbox service exists and before the scheduler starts.
  It's `logger.info({ closed: resolveNoticeCards(state.db, inbox) }, 'closed open cards that are notices now')`,
  logged only when `closed > 0`.
- Modify `apps/daemon/src/daemon/start.test.ts`: one wiring test.

## Interfaces (implement, exactly)

`NOTICE_SWEEP_REASON`, `noticeTypeOf(card: OpenFlagRow): string | null` and `resolveNoticeCards(db, inbox): number`,
quoted in the index.

`resolveNoticeCards` calls `inbox.resolve(id, NOTICE_SWEEP_REASON)` for each row `noticeTypeOf` names, and returns
the count. `resolve` leaves a card that is no longer open as it was (state row 7). Each resolve is its own write, so
a killed sweep resumes at the next start (state row 6).

**The matchers.** `noticeTypeOf` holds one `as const` table, one entry per notice type, each `{ name, matches }`. It
imports the fold-key helpers where a module exports them; otherwise it uses the literal prefix, with a comment
naming the file. Titles are quoted from the raisers as they stood before Task 4. Copy them from `git show
<Task 4's parent>:<file>`.

| Name | Matches |
| --- | --- |
| `branch-deleted` | fold key starts `branch-deleted:` |
| `orphan-not-removed` | fold key starts `worktree-remove-failed:` **and** title starts `10db removed nothing at ` |
| `tasks-moved` | no fold key, title matches `/^\d+ tasks? moved off .+, which no longer exists$/` |
| `regenerate-failed` | fold key starts `base-regenerate:` **and** title contains `: 10db couldn't regenerate files after merging ` |
| `pass-follow-on` | fold key starts `pass-follow-on:` |
| `pass-gate` | fold key starts `pass-gate:` |
| `pass-branch-moved` | fold key starts `pass-branch-moved:` |
| `pass-abandoned` | fold key starts `pass-abandon:` **and** no options |
| `model-retried` | fold key starts `model-refused:` **and** body matches `/, and is running the step on [^ ]+\.$/` |
| `left-changes` | no fold key, title matches `/^The .+ step left changes in its claims$/` |
| `no-handoff` | no fold key, title is `Session ended without the requested handoff` |
| `resized` | fold key starts `resize:` |
| `pass-did-not-open` | no fold key, title matches `/^Pass ‘.+’ did not open$/` |
| `pass-cancelled` | no fold key, title matches `/^Pass ‘.+’ was cancelled for 10db’s update$/` |

## Steps

1. **Red.** `notice-sweep.test.ts`, a pure table over `noticeTypeOf`. It has one matching row per entry above, and
   a row per near miss, each expecting `null`:
   - `worktree-remove-failed:` titled `10db could not remove …` (an ask);
   - `base-regenerate:` titled `…lost migrations 10db can no longer list` (an ask);
   - `pass-abandon:` with a Move option;
   - `model-refused:` whose body ends `…has nothing left to run the step on.`;
   - `model-refused:` whose body says it stopped the task;
   - `checkout-return:` (an ask);
   - `pass-folder:` (an ask);
   - a title `The review step left changes in its claims` **with** a fold key;
   - an unrelated flag.

   Then, real SQLite with a real inbox service (as `inbox/inbox.test.ts` builds one), seed:
   - one open card of each of three notice types, through `flagCard` with S1's fields;
   - one open ask;
   - one dismissed notice-type card.

   `resolveNoticeCards` returns 3, and each of the three is `RESOLVED`, with `detail.resolution.reason` equal to
   `NOTICE_SWEEP_REASON`. The ask is still open. The dismissed card is unchanged. A second run returns 0.

   Run with `vitest run`. Expected: it fails, because the module is missing.
2. **Red.** `start.test.ts`, one test through the wiring. Pre-seed the data dir's database with one open
   `branch-deleted:` card, in the way the file's other restart tests reach the database. Start the daemon. Then
   `GET /inbox?state=OPEN` doesn't list it, and `GET /inbox/page?state=resolved` does. Expected: it fails, because
   nothing sweeps.
3. Implement.
4. **Green.** Run `pnpm --filter @10db/daemon exec vitest related src/daemon/notice-sweep.ts src/daemon/start.ts
   --run --maxWorkers=2` and `pnpm --filter @10db/db exec vitest related src/store/inbox.ts --run
   --maxWorkers=2`. Then typecheck and lint both.
5. Commit, naming every path. The message is `feat(daemon): at start, open cards of a kind that is now a notice
   move to resolved`. The body carries:

   ```
   Value: protects=no stale notice-type card stays counted after the update, and no ask is swept
     with them; fails_when=a matcher misses one of the 14 kinds, or catches an ask that shares its
     fold key prefix; why_new=no sweep existed; no_claim=that cards of kinds the matchers don't
     name are asks (S3's repo test)
   ```
