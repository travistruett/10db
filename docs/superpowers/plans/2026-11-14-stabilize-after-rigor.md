# Plan: clean up and stabilise after right-sized work

## Brief

**What changes for the builder.**

- A task sized while the daemon stopped mid-judge-call is judged again at the next start, instead of keeping the
  rules' sizing until its text changes.
- A Light task that the safety net gives a review says why in the task drawer ("review added: …").
- On a Critical task, a review that already shipped at its round limit and filed a follow-up doesn't file a second,
  near-duplicate one when QA sends the work back.
- The old routing tables (flows, patterns, role settings, team bindings, persona pins, task risk tags and flow,
  project flow) are dropped, along with the move that read them. A database that never ran the move refuses to
  start and says to open an earlier release first. The builder's database ran the move (`playbook.moved = true`,
  checked read-only on 2026-11-14), so it migrates.
- Lint runs one ESLint process per package, so its memory follows the largest package, not the whole repo.
- The tests that flake under load (see-screen e2e caption, the workbench thread test, `code-routes` timing, the
  pass git tests, and every `vi.waitFor` on git or gate work with the 1 s default) wait on conditions with real
  deadlines.

**What it buys.** Less dead code, fewer red gates that pass on rerun, and lint that stops needing an 8 GB heap.

**What could go wrong, and how we'd know.**

- *Dropping tables on a database that still needed the move.* `migrateDatabase` checks before it runs the drop:
  when the drop is pending and the database has rows in the old tables and no `playbook.moved = true`, it throws a
  typed `PlaybookMoveMissingError` and migrates nothing. A test on a real database file proves it, and a second
  proves an empty old database (a fresh install) migrates.
- *A load fix hides a real failure.* Each fix is a deadline on a condition wait or a count of work, never a sleep,
  and the `code-routes` test still fails if the parse goes quadratic (proved by running it against a quadratic
  stand-in once, said in the commit).
- *Lint per package misses files.* The root files outside any package (`tests/repo`, `scripts`, root configs) get
  their own process; a check counts the files linted before and after and the PR states both.

**Calls the builder might disagree with.**

- The `riskTags` alias on the lane propose tool stays: the only release, v0.1.0 (2026-10-28), predates kinds. Its
  task stays open.
- The two "moot once dropped" tasks (one set of test writers for the old tables; a corrupted JSON column reported
  by the move) are closed with the drop, since the code they change is deleted.
- The sizing fix adds one column, `tasks.sizing_owed_for` (the fingerprint the judge still owes an answer for),
  in the same generated migration as the drop. Cost if wrong: one nullable column.

**Provider parity.** Nothing here depends on the provider. The sizing re-ask uses whichever account is picked for
decisions, as sizing does now; with no judge available the column is never set.

**Coordination.** 10db-ef's PR3a holds seven migrations after 0074 and edits `runner.ts`. This PR adds one
migration (0075 here) and edits `runner.ts` (`withSafetyNet`, `stepsAdvanced`). Whoever merges second renumbers.
10db-ef is told before Track B1 starts.

**Needed from the builder:** nothing.

---

## Track B1: the daemon and the database

### Task 1: drop the old routing tables (migration, refusal, deletion)

- Remove the old tables and columns from `packages/db/src/schema.ts` (find them all through
  `store/legacy-routing.ts`); delete `legacy-routing.ts` and its test, `readLegacyRouting`'s export,
  `apps/daemon/src/team/move-to-playbook.ts` and its helpers (`move-cells`, `move-patterns`, `move-tasks`,
  `move-entries`) that only the move uses, its test, `apps/daemon/test/moved-world.ts`, and the call at daemon
  start. Keep `PLAYBOOK_MOVE_REPORT_KEY` and whatever Settings › Models reads to show the report (move the
  constant somewhere that still exists). Keep `playbook.moved` as a setting the refusal reads.
- Add `tasks.sizing_owed_for` (Task 2) to the schema in the same step, then `pnpm --filter @10db/db generate`:
  one generated migration.
- Refusal in `migrateDatabase` (`packages/db`): before running migrations, if the drop's migration is pending,
  any of the old tables holds a row, and `app_settings['playbook.moved']` is not `true`, throw
  `PlaybookMoveMissingError` ("This database was made by a 10db release that had not moved its model settings to
  the playbook. Open 10db at commit 81715524 or earlier once, then this release.") and migrate nothing. The
  daemon's start turns it into the same exit as `StaleSchemaBaselineError` with that message (find how that one
  is reported).
- Tests (real database file, `database.test.ts`'s own-migration pattern): refuses with a row and no setting;
  migrates with the setting; migrates an empty database with neither (fresh install). Every test that seeded the
  old tables goes with the code. `rg` for each dropped table and column name finds only the migration SQL.

### Task 2: a sizing call cut off by a shutdown is asked again

- When `sizing-service.ts` queues a task for the judge, the same write that applies the rules sets
  `sizing_owed_for` to the fingerprint. Every end of the task's judge work (answers applied, stopped, fallback,
  never made because the text changed or the stop came) clears it in its write, when it still equals that
  fingerprint.
- `sweep()` also enqueues each open, unstarted task made within the sweep's 24 hours whose `sizing_owed_for`
  equals its current fingerprint.
- Tests in `sizing-service.test.ts`, red first: (a) create, stop the service before the judge answers (the fake
  judge never resolves; dispose), start a new service on the same database, sweep: the judge is asked and its
  answer applied; (b) a task whose call answered before the stop is not asked again; (c) one made more than 24 h
  ago gets no call (injected clock).

### Task 3: process-per-rigor follow-ups (`runner.ts`)

- `withSafetyNet`: the inserted Review step's own `reason` reads `review added: <reason>` (the transition reason
  already does). Test: the runner test that covers the safety net asserts the step's reason, then a render test
  of the drawer's step reason if one exists (else the runner assert alone).
- `stepsAdvanced`: a step that already has `shippedAtLimit` keeps it and files no second follow-up. Test: Critical,
  Review ships at its limit and files a follow-up, QA sends back, Review rejects again past its limit: one
  follow-up task.
- A cancel during the safety net's diff read (`reviewForcedAfter`): a test holds the read open (an injected
  diff reader that waits on a promise the test resolves after cancelling), cancels, releases: the task ends
  cancelled and no review step is added. If the read can't be held through an existing seam, report
  NEEDS_CONTEXT rather than adding a test-only seam.

## Track B2: tooling and load tolerance

### Task 4: lint each package in its own process

- A script `scripts/lint-workspaces.mjs` (or a Make target, whichever the gate and CI call more simply) runs
  `eslint --max-warnings=0` once per workspace package directory and once for everything outside them, serially,
  failing on the first failure but reporting every package's result. Root `pnpm lint` calls it; the gate's `lint`
  step and CI's policy job keep calling `pnpm -s lint`. Lower `--max-old-space-size` to what the largest package
  needs plus headroom, measured (`/usr/bin/time -l` peak RSS per process), and state the numbers in the report.
- Prove the file count is unchanged (eslint `--format json` file counts, before and after) and that a warning in
  one package still fails it.

### Task 5: load-tolerant tests

- Sweep `apps/daemon/src/**` delivery, runner and pass tests for `vi.waitFor(` / `expect.poll(` with no options on
  work that runs git or a gate, and give each the deadline `pass-pr.test.ts` uses (`{ timeout: 20_000 }`, or that
  file's constant if it has one). Check what `apps/desktop/src/test/load-tolerance.test.ts` enforces before
  touching desktop tests.
- `apps/daemon/src/folders/code-routes.test.ts:250`: replace the 100 ms wall-clock bound with a count of work (for
  example, the number of nodes visited or a counter the parser already has) so it fails if the parse goes quadratic
  and never on a slow machine. If the parser exposes no count, compare 20 000 deep against 2 000 deep and bound the
  ratio. No new test-only export.
- `apps/daemon/src/pass/close.test.ts`, `abandon.test.ts`, `put-back.test.ts`: per-file test timeouts sized to the
  git work (or the file's describe), and a `vi.waitFor` deadline where they wait.
- `apps/desktop/src/views/workbench/thread.test.tsx` ("leads with the goal's earlier pictures …"): find the
  timing dependence and wait on the condition (`findBy…`).
- `apps/desktop/e2e/see-screen.spec.ts`: find why `I saw the board: 1 picture.` can take over 20 s under CI load
  and wait on the real condition, or give that wait a deadline that matches the capture's own timeout, with the
  reason in a comment.
- Prove each under load: run the changed files with `--maxWorkers=2` while the machine is loaded (it is), five runs
  each for the flaky ones; report the counts.

### Task 6: close the moot tasks (controller)

The controller closes `tsk_01a1d83e-0b2c…` and `tsk_01a1d83e-0a1b…` and notes the `riskTags` task stays, after
the PR merges.

## Review focus

The refusal's three cases and its message; nothing left reading a dropped table; the sizing column cleared on
every end of the judge's work; the duplicate follow-up rule on a QA send-back; lint's file count.

## Round 1 amendments (they override the text above)

**Task 1 (drop):**
- *Trigger (B4).* Key the check on whether any old table still exists in `sqlite_master`, not on a migration index
  (the number may change on merge). Old routing data also sits in columns (B2): `tasks.risk_tags` (non-empty),
  `tasks.flow_id`, `projects.flow_id`, `personas.model_pin`, `personas.minimum_score` (non-null): check those too,
  through `pragma table_info` so an older schema without a column doesn't throw. Refuse when any old row or value
  exists and `playbook.moved` is not `true`.
- `PlaybookMoveMissingError` extends `SchemaMismatchError` (exit 3 through `main.ts`). Message names the range
  (B3): "Open a 10db build from #608 (f31017b6) through 81715524 once, so it moves the model settings to the
  playbook, then this one."
- *Four tests* (B4): an empty file (fresh install); a database at the previous head with empty old tables; moved
  (rows and the setting); unmoved (rows or a column value, no setting) refused with nothing migrated.
- *Deletion list* (B5) also covers `packages/db/src/legacy-types.ts` and its export, `store/legacy-routing-fixtures.ts`,
  `apps/daemon/test/legacy-rows.ts`, `team/move-rigor.ts`, the old row types in `store/team.ts` and
  `store/projects.ts`, `FlowId`/`PatternId` in contracts `ids.ts` if nothing else uses them, `start.test.ts`'s
  expectation that start sets `playbook.moved`, and the AGENTS.md text. In `routing/routing-regression.test.ts` the
  case that runs the move over `moved-world` goes; seed `STRONGEST_WHEN_UNREACHED` as a playbook cell directly so
  the "uses every line" check still holds.
- *Migration tests* (B6): `migrations-model-tiers.test.ts` and `migrations-model-ids.test.ts` keep their coverage
  of 0067's other rewrites: stop them at the migration under test, or drop only the old-table assertions. Don't
  delete them.

**Task 2 (sizing, B1 blocking, B7):**
- A judge job ended by `stop()` (the job's abort or the service's `stopped`) **writes nothing**: the owed mark
  stays for the next start. Test (a) uses a judge that resolves `{kind:'fallback', reason:'stopped'}` on abort,
  as the real judge does (extend `apps/daemon/test/scripted-judge.ts` to honour `req.signal`).
- Set `sizing_owed_for` only when the task is actually queued for the judge (not in the sweep's rules write for a
  task older than 24 h). Clear it on every other end: answers applied, a fallback other than stopped, nothing
  sizable, nothing to ask (pinned rigor, decisions off), text changed. Name the store functions in the report
  (the `applyTaskSizing` change, a sibling of `listUnsizedTasks` for the sweep).

**Task 3 (runner):**
- *Duplicate follow-up* (B8): when the step already has `shippedAtLimit` and its follow-up task is still open
  and unstarted, append the new rejection's findings to that task's description; otherwise file nothing (the
  findings stay on the step). Never a second task.
- *Cancel test seam* (B12): the diff read goes through `opts.git.diffSince`; `createDeliveryHarness` takes
  `wrapGit`. Use that.

**Task 4 (lint, B11):** run every package, then exit non-zero if any failed. Report wall time as well as peak
memory.

**Task 5 (load, B9, B10):** `code-routes.test.ts` is now 30 000 deep with a 1 000 ms bound: replace the timing with
a count of work if the parser has one through its public API; if not, leave it and say so (don't add a ratio of
timings). Proof: 20 runs in a row for the thread test and for see-screen; for the pass tests, record the load
average during the run (above 40).

**Follow-ups, not in this PR:** a daemon `vi.waitFor` guard like desktop's load-tolerance test (B13); the no-gate
path's missing shutdown check after the safety net's read (B12).
