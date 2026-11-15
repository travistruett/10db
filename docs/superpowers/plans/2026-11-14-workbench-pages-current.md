# Plan: the Workbench's pages stay current, show their names, and Abandon clears

## Brief

**What changes for the builder.**

- Each page has a **display label** ("Plan" for the `shape` area). The picker, the queue, the page pane,
  notifications, modals, the pass name ("Plan pass") and the task a pass makes ("Plan: UI work") show the label.
  Settings › Areas edits it on page rows. Workbench setup guesses it from the app's nav (`{ to: '/shape', label:
  'Plan' }`), and when it guesses nothing the label is the name with its first letter capitalised.
- **The picker notices new pages.** With page areas, the picker's header always offers **Set Up**, with a count
  of new pages (pages the repository has and the project lacks, less those the builder left out) plus the
  settings it suggests. Under the Pages field a line says "New page found: Sessions /sessions" with Set Up. In
  the setup, Rebuild Areas starts ticked when it found a new page. A page the builder unticks at Apply is
  remembered as left out and not counted again; it still shows, unticked, in the rebuild. A label the setup
  guesses for an existing page with none is part of the rebuild too.
- **Abandon Pass clears.** Unsigned pages' files go back as today, but their changes are deleted, not kept. A
  task the pass made ("Settings: UI work") is removed from the Board. A Board task that joined the pass goes back
  to the Board open, without the pass's changes and without any saved work it carried in. Signed-off pages stay
  landed. The confirm says it deletes: "Discards: Billing, People (their changes are deleted). Stays: Settings
  (signed off)." Take Out keeps work as before.

**What it buys.** The page list matches the app you see, and an abandoned pass leaves nothing behind.

**What could go wrong, and how we'd know.**

- *Abandon deletes work the builder wanted.* It is the builder's call; the confirm names every page it discards.
  Signed-off work is never touched (existing abandon tests keep asserting it).
- *A restart mid-Abandon leaves a task half removed or a ref behind.* The per-step restart table in
  `abandon.test.ts` gains rows asserting the pass-made task is cancelled and no `refs/10db/kept/<id>` exists after
  a kill at each step.
- *A label guess is wrong.* It is a default; Settings › Areas changes it. Names stay the key everywhere (claims,
  `task.areas`, passes), so a label never changes behaviour.
- *The new-page line nags.* A page left out once is never counted again.

**Calls the builder might disagree with.**

- A joined Board task loses saved work it carried into the pass, not only this pass's changes. Cost if wrong:
  work from an earlier pass is gone; the confirm names the page.
- Labels are allowed on page areas only (`areaRolesProblem` refuses one elsewhere).
- Your existing "Settings: UI work" task predates the marker column, so this build doesn't remove it; the
  coordinator removes that one row through the daemon after merge.

**Provider parity.** Nothing here depends on the account's provider: setup, labels and Abandon run in the daemon
and git, the same for a Claude plan, Bedrock, an API key or a Codex plan.

**What I need from you.** Nothing.

---

## Global Constraints

- Worktree per track under `../10db-worktrees/`, branched from `feat/workbench-pages` after Task 1 merges. Commit
  after every green step, explicit paths, Conventional Commits, single-quoted `-m`, value card per newly tested
  behaviour (`.claude/rules/testing.md`). Never `--no-verify`.
- Run related tests only: `pnpm vitest related --run <changed files> --maxWorkers=2`, plus typecheck and lint of
  the changed packages. No full gate; the coordinator runs it once at the end.
- `name` stays the key for areas everywhere. The label is display only.
- `pageLabel(area)` is the only place the fallback (capitalised name) is computed. No inline capitalising.
- Docs are part of done: each track updates the AGENTS.md lines for the code it changes and the spec
  `docs/superpowers/specs/2026-11-09-10db-workbench-design.md` sections it contradicts. Decisions go in new files
  under `docs/architecture/decisions/` (README format); merged decision files are never edited.

## Task 1 (foundation, before both tracks): columns and contracts

Interfaces:

- `packages/contracts`: `AreaDef.label?: PageLabel` where `PageLabel` is one line, 1-40 chars (`oneLine`).
  `areaRolesProblem` refuses a label on an area whose role is not page: "Only a page has a label".
  `export function pageLabel(area: { readonly name: string; readonly label?: string }): string`
  in `page-areas.ts`: the label, else the name with its first letter upper-cased. Exported from the entry point.
- `ProjectDto.leftOutPages: string[]` (page names the builder left out of a rebuild) and
  `ProjectPatch.leftOutPages?: string[]`.
- `PageRow.label?: PageLabel` (setup's guess for a new page).
- `PassStartPageDto.label: string` and `PassPageDto.label: string`, filled by the daemon with `pageLabel`.
- `packages/db`: `projects.left_out_pages` (json `string[]`, not null, default `[]`) and `tasks.made_by_pass_id`
  (nullable text, references `passes.id`), in one generated migration following `packages/db/AGENTS.md`.
  `insertPassPageTask` sets `made_by_pass_id`; the task DTO does not need it.
- Regenerate `packages/contracts/generated/`. Daemon fills the two `label` DTO fields
  (`apps/daemon/src/pass/view.ts`, `apps/daemon/src/pass/start-preview.ts`) and stores/reads `leftOutPages`.

Tests: `pageLabel` and the label refusal as table rows in the existing contracts tests; a real SQLite row for
`made_by_pass_id` set by the pass open (extend the existing `pass-open` test); `leftOutPages` round-trip through
the project patch route (extend an existing route test).

## Track A: Abandon clears (implementer on Opus; git and recovery, red-first per behaviour)

### Task 2: an abandoned page's changes are deleted

In `take-out.ts`, when `TakeOutWithin.Abandon`: the files revert as today, the pass's kept ref for the page is
deleted instead of moved to `refs/10db/kept/<task id>`, an existing `refs/10db/kept/<task id>` is deleted too,
and `kept_work_sha`/`kept_base_sha` are cleared. The step stays idempotent: a restart after the ref delete and
before the row write finishes the same. A plain Take Out is unchanged.

Tests (real git repo, delivery harness, restart per step; extend `abandon.test.ts`'s first test and restart
table): after Abandon no `refs/10db/kept/*` exists for an unsigned page, kept-work columns are null, a joined
task that carried kept work in has none after; signed-off page untouched; take-out test still asserts keep.

### Task 3: a pass-made task leaves the Board

In the same write that takes the page out under Abandon (`leavePassForBoard`'s Abandon branch): a task whose
`made_by_pass_id` is this pass is retired (status cancelled, board column cleared, as `retireTask`); a joined task
is set open with no pass and a thread notice "Abandoned with <pass name>; its changes were deleted." Inbox items
for the page are cancelled as today.

Tests: restart table rows assert the pass-made task is cancelled and absent from `listTasks` after a kill at
each step; a joined task is open with no kept work; `joinableTasks` (pure) no longer offers either.

### Task 4: the confirm and the card say it deletes

`abandon-modal.tsx`: "Discards: <labels> (their changes are deleted). Stays: <labels> (signed off)." The
Abandon card text says the same. Update `abandon-modal.test.tsx` and the e2e step in `e2e/workbench.spec.ts`
that asserts keep. Docs: new decision `2026-11-14-abandon-pass-deletes-unsigned-pages-work.md` superseding
`2026-11-09-abandon-pass-puts-unsigned-pages-back.md` (and amending `2026-11-09-a-turns-work-is-kept-at-a-ref.md`
for the Abandon case); spec §5.4 Abandon bullet, the take-out line on Abandon, the test table row, P17 and open
item 18; `apps/daemon/src/pass/AGENTS.md`, `apps/desktop/src/views/workbench/AGENTS.md`; source comments in
`abandon.ts` and `take-out.ts` that say Abandon keeps.

## Track B: labels and new pages (implementer on Sonnet; routes, wiring, views)

### Task 5: the label shows wherever a page's name does

Swap `page.area` / `pageName()` for the DTO's `label` (or `pageLabel(area)` where only an `AreaDef` is at hand)
at every place the researcher listed: picker (`page-picker.tsx` name and search haystack, which also matches the
name and route), queue row, queue list, row menu, page pane, composer and phase, thread, announcements, notify-pass,
abandon/take-out/close/add-page modals, close-choices, header notices, page-status, `passName` in
`start-pass-rules.ts`, and the daemon's `pageTaskTitle` (`<Label>: UI work`). Route stays monospace beside it.
Tests: extend the picker test (label shown, search by name and label), `passName` table rows, `pageTaskTitle`
row.

### Task 6: Settings › Areas edits the label

`project-areas.tsx`: `AreaDraft.label`, a Label field on page rows (placeholder: `pageLabel` of the name), sent in
`toPatch`, emptied means absent. Extend `project-areas.test.tsx`.

### Task 7: the setup guesses labels

In `codeRoutes` (`apps/daemon/src/folders/code-routes.ts`), with the hand-written scanner (no regex over repo
text, per `folders/AGENTS.md`): for each found route, look in the files it already reads for an object literal
holding both `to: '<route>'` (or `path:`/`href:`) and `label: '<text>'`, and take the text. Carry it through
`CodePage.label` → `PageRow.label` → the proposed area. An existing page area with no label gets the guess in
`proposed`, and `sameArea` compares labels, so the rebuild offers it. Tests: `code-routes.test.ts` table rows
(nav array like 10db's, no label, label for another route, two routes on one line); `rebuild-areas.test.ts` row
for a label added to an existing page.

### Task 8: the picker offers new pages

- `setUpCount` (`setup-rules.ts`) counts settings plus `areas.pages` whose name is not in
  `project.leftOutPages`.
- With page areas, Set Up is always in the picker header; the count shows only when above 0.
- Under the Pages field: "New page found: <label> <route>" (or "<n> new pages found: …") with Set Up, from the
  same count's pages.
- In the setup, Rebuild Areas starts ticked when a counted new page exists.
- Apply (`setupPatch`) sends `leftOutPages`: the project's list plus each new page unticked, minus each ticked.
- Tests: `setup-rules.test.ts` rows (count with/without left-out, patch adds/removes left-out names);
  `workbench-view.test.tsx` (Set Up shown with zero settings, the new-page line); one e2e or route test through
  the real daemon that a repo with an unlisted route shows the line.
- Docs: decision `2026-11-14-page-areas-carry-a-display-label.md`; update
  `apps/desktop/src/views/workbench/AGENTS.md` (setup paragraph), `apps/daemon/src/folders/AGENTS.md`,
  `apps/desktop/src/views/settings` AGENTS if it lists the area fields, and the spec's setup section.

## Review focus

- Track A: every Abandon step killed and restarted ends with no kept ref, no kept-work columns, pass-made tasks
  cancelled; signed-off pages untouched; plain Take Out unchanged.
- Track B: no place still shows a raw area name to the builder; `name` is still the key; the scanner has no
  regex over repo text and is linear.

## Round 1 amendments (they override the text above)

1. **Task 7 reads the nav.** Besides the router files, `codeRoutes` reads up to 20 more source files per app whose
   base name contains `layout`, `nav`, `sidebar`, `menu` or `shell` (case-insensitive), within
   `SETUP_READ_BYTES`, for label guesses only. Add a `this-repository.test.ts` row: `shape` gets "Plan",
   `sessions` gets "Sessions".
2. **A label never makes a page "new".** `rebuildAreas` carries `existing.label ?? guess` onto a page it keeps or
   rebuilds, so a builder-set label always wins and an unlabelled page gets the guess. A label difference is never
   a `PageRow`; `areas.pages` holds only pages whose name and route match no existing page area. Unticking a row
   can therefore never demote an existing page.
3. **Both `sameArea`s compare `label`:** the daemon's (`rebuild-areas.ts`) and the desktop's
   (`setup/setup-rules.ts`, used by `areasChanged`), so a label-only rebuild is offered and sent.
4. **Task 2/3 tests open People with `pages`** (a pass-made task) in the restart table, keep Settings joined from
   the Board, and add a kill row that lets the kept-ref delete run and then dies before the row write.
5. **`retirePassMadeTask(tx, taskId)`** is a new export of `packages/db` (store/tasks.ts) that never refuses: sets
   cancelled, clears the board column, detaches Shape questions as `retireTask` does, and deletes its `task_deps`
   edges both ways. Task 3 calls it on both Abandon paths, including the no-run path at `abandon.ts:269-272`.
   Board **Remove** also uses it for a task whose every workstream is `CANCELLED` and that has no pass and no kept
   work (nothing to lose): this is how the builder removes the leftover "Settings: UI work".
6. Drop "`joinableTasks` no longer offers either": a joined task is offered again by design.
7. Task 1: the column is set by `markTasksMadeByPass` after `insertPass`; add migration 0091 to
   `docs/architecture/db-storage.md`.
8. Task 4's doc list adds spec lines 606-607 (step 5), 628 ("Nothing is pushed or deleted"), and the D23 row at 1508.
9. **Files both tracks touch:** Track A owns `abandon-modal.tsx` (and puts labels in it), spec §5.4 and the abandon
   sentences of `views/workbench/AGENTS.md`; Track B owns spec §4.2 and the setup sentences. The coordinator
   merges the text.
10. Brief addition: new pages are found from committed code (HEAD), up to 10 minutes after the commit (the
    setup's cache); a file-routed app gets the capitalised name, not a guess.
11. Follow-up, not this PR: a page whose own Take Out is running when Abandon starts finishes keeping its work.
