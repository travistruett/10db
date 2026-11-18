# Task 4: daemon — the 14 notice raisers post notices

**Spec:**

- §5's "Changes tier" table, the rows that become **Activity**, plus "Couldn't regenerate files", which becomes a
  batch notice;
- §4.2: "Batch-scoped notices use the existing `batches.notices` list";
- §4.5 "Tiers aren't stored".

**State rows:** 8. **Part:** A. **Consumes:** Task 3's `postNotice`, `InboxService.notice`, `post` and `postIn`,
and Task 2's `hasNoticeKey`.

This is wiring. There are four commits, one per module group. In each, the existing test that pins the card is
changed first to expect the notice, and is seen failing for that reason.

## The raisers

The index's "Becomes a notice in S1" table is the list. Each notice's `key` is the card's fold key where it has one,
else the stable key named here. The line is the card's title, and the body is the card's body. Notices take
`tier: CardTier.Notice`.

### Commit A: delivery

- **`branchCards.abandonedBranchDeleted(batch, withWorktree)`** returns a `DeliveryNotice`: key
  `branchCardKey.deleted(batch.id)`, tone `info`, `taskId: null`. `branch-cleanup.ts:74` calls `post`.
- **`worktreeCards.orphanNotRemoved(path, why)`** returns a `DeliveryNotice`: key `keptWorktreeKey.removeFailed(path)`,
  tone `warning`, `taskId: null`. `worktree-card.ts:143` calls `post`.
  - The card it used to refresh was the one just answered, so nothing else is closed.
  - Check that in `worktree-card.ts`. If an open removeFailed card can remain, withdraw it in the same flow with
    `withdraw(…, [keptWorktreeKey.removeFailed(path)])`.
- **`retired-landings.ts` `movedCard`** returns a `DeliveryNotice`: key `retired-landings:<sorted branch names>`,
  tone `info`, `taskId: null`. `raiseIn` at `:101` becomes `postIn`, so the notice commits with the move.
- **`baseCards.regenerate`** becomes `baseNotices.regenerate(batch, worktree, dirs, problem): Notice`, a batch
  notice: key `base-regenerate`, tone `warning`, the title as `line`, the body as `body`.
  - `base-update.ts:1076` calls `showNotice(ctx.state, batch.id, …)`.
  - Where `base-update.ts:999` withdraws `baseRegenerateKey`, it also calls
    `hideNotices(state, batchId, ['base-regenerate'])`. The withdraw stays, because the lost-migrations card still
    folds on that key.
  - `lost-migrations.ts:50` does the same.
  - `baseCards.lostUnreadable` keeps its card and its fold key `baseRegenerateKey`. It no longer folds into a
    regenerate card, so its comment says it stands alone.

Tests to change, red first:

- `delivery/branch-cleanup.test.ts`: the deleted-branch case expects a `notice.posted` event and no open card;
- `delivery/worktree-card.test.ts`: the orphan-not-removed case;
- `delivery/retired-landings.test.ts`;
- `delivery/base-update.test.ts`: the regenerate case expects the batch's `notices` to hold `base-regenerate`, and
  the journal-whole case expects it hidden.

### Commit B: pass

- **`merged-open.ts` `carryOver`** posts in its write:
  - `postNotice(ctx, { tier: Notice, projectId: pass.projectId, taskId: null, key: followOnKey(passId), tone:
    unpushed.length > 0 ? 'warning' : 'info', line: <the title>, body })`.
  - `carryOverDue` adds `!hasNoticeKey(db, pass.projectId, key)` to its two card checks. The card checks stay, for
    cards raised before this build.
  - `detail` (`PassFollowOnDetail`) is no longer written. The log line keeps it.
  - Its comment and `pass/AGENTS.md` say the notice marks the carry-over done.
- **`close.ts:276`** (gate failed as the pass closed) posts: key `gateFailedKey(pass.id)`, tone `warning`.
- **`fast-forward.ts:48`** (Your folder stays on) posts: key `branchMovedKey(pass.id)`, tone `warning`.
  - The withdraw at `:61`-`:63` goes, since a notice needs none.
  - Its test of "the card goes when the branch moves" is deleted. The notice stays in Activity as history. Say so in
    the commit body.
- **`abandon.ts:193`**: with no Move option, it posts key `pass-abandon:<passId>`, tone `info`. With the Move option
  it stays a card.
  - When a refresh finds the Move option gone, the open card with that fold key is withdrawn in the same write
    (`withdrawCard`), and the notice is posted.

Tests to change, red first:

- `pass/merged-open.test.ts`: the carried-over case expects a notice and no card.
  - **Restart, new:** with a notice already posted for the pass, `carryOverDue` is false and `resume()` carries
    nothing over again.
  - **Crash, new:** with no notice and no card, `carryOverDue` is true (state row 8).
- `pass/close.test.ts`: the gate-failed case;
- `pass/fast-forward.test.ts`;
- `pass/abandon.test.ts`: both variants, and the switch from card to notice.

### Commit C: runner and mcp

- **`runner.ts:2195`** ("<acct> cannot run <model>"): when `retry && !nothingLeft`, it posts through
  `opts.inbox.notice`: `projectId: row.projectId`, `taskId: row.taskId`, key
  `model-refused:<account.id>:<model>` (today's fold key; grouping at read collapses repeats), tone `warning`.
  - Otherwise (not retried, or nothing left to run) it stays a flag. Task 5 gives it its values, with `// S2: Choose Another Model`.
- **`runner.ts:4661`** (the step left changes in its claims) and **`:4678`** (ended without the requested handoff)
  post with the workstream's `taskId`:
  - keys `left-changes:<workstreamId>:<role>` and `no-handoff:<workstreamId>:<role>`;
  - tone `warning`.
- **`mcp/tools.ts:1030`** ("<task> was resized") posts with the task: key `resize:<taskId>`, tone `info`.
  - The "Got it" option goes.
  - `mcp/AGENTS.md`'s `resize_task` line says it posts a notice.

Tests to change, red first:

- `runner/model-start.test.ts`: the retried case expects a notice with the task; the not-retried case still expects
  a card;
- `runner/runner.test.ts` `:4978` and its neighbour for the handoff;
- the resize case in `mcp/mcp.test.ts` or `mcp/resize-task-pass.test.ts`, whichever pins the card today.

### Commit D: daemon start

- **`openWhenBusyDeps.notify`** (`daemon/start.ts:2313`) keeps its signature `(projectId, title, body)`, from
  `pass/open-when-busy.ts:28`. Its body becomes `inbox.notice({ tier: Notice, projectId, taskId: null, key:
  'pass-open-failed', tone: 'warning', line: title, body })`.
- **The update drain's cancel** (`daemon/start.ts:2640`) posts `inbox.notice(…)`: key `pass-open-cancelled`, tone
  `info`, with the same title and body.

Tests to change, red first:

- `daemon/self-update.test.ts:921` expects a notice;
- the did-not-open case in `test/pass-api.test.ts`, or whichever test pins it.

## Steps

For each commit A-D:

1. Change the tests listed, and run them with `vitest run`. Expected: they fail, because a card is still raised and
   no notice is posted.
2. Change the raisers.
3. Run `pnpm --filter @10db/daemon exec vitest related <the changed source files> --run --maxWorkers=2`. Then
   typecheck and lint the daemon.
4. Commit, naming every path:
   - A: `feat(daemon): delivery notices post to activity, and a failed regenerate is a batch notice`;
   - B: `feat(daemon): workbench pass notices post to activity, and the follow-on notice marks a carry-over`;
   - C: `feat(daemon): run notices post to activity on their task`;
   - D: `feat(daemon): a pass that did not open or was cancelled posts a notice`.

   Each body carries a value card, as in this one for B:

   ```
   Value: protects=a merged pass's follow-on is a notice and still marks its carry-over done;
     fails_when=the notice is stored as a card, or a restart carries the pages over twice;
     why_new=merged-open.test.ts pinned the card as the marker; no_claim=that cards raised before
     this build are swept (task 6)
   ```
