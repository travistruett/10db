# 10db First Run, Board and Settings Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A fresh install opens on a three-step first run that checks Claude Code, git and gh, inspects a chosen folder and detects its gate command; once a project exists, the Board, task drawer and Settings look and behave as agreed with the builder on 2026-10-28; and a project may have no gate command, in which case each finished task waits for the builder to approve its diff.

**Architecture:**

- **Desktop foundation (Tasks 1–3).** Theme defaults, one `useHiddenEdges` hook, `FormModal`, `SplitButton`, `ProjectTile`, `LabelWithHelp`, `FlowSelect` and the root error page live in `apps/desktop/src/shell/` and `views/board/`, each with its own test.
- **Shell, Board, drawer, Settings (Tasks 4–12).** Rebuilt from the spike's sketch (`spike/first-run-wizard`), with tests. The spike's files are a reference: read them with `git show spike/first-run-wizard:<path>`, then write the tested version; never merge or cherry-pick the spike.
- **Daemon (Tasks 13–15).** A new pure module `folders/` (gate detection and folder inspection), a `Git.inspect` read on the unpinned path, `POST /folders/inspect`, and gh's login in `GET /system`.
- **First run (Tasks 16–18).** Tauri's dialog plugin, the shared project form, the first-run wizard, the e2e seeding.
- **Optional gate (Tasks 19–23).** Nullable gate command, two workflow edges, a `builder_review` next action, a `check` Inbox kind and `builder` evidence, the runner and inbox changes, a changes route, ship without a gate, the desktop card.
- **Docs (Task 24).**

**Tech Stack:** As in the M2b board-and-settings plan: React 19, Mantine 9, TanStack Router and Query, dnd-kit, Testing Library + MSW, Playwright WebKit; Hono and zod in the daemon; Drizzle. One new dependency: Tauri's dialog plugin (Task 16).

**Spec:** `docs/superpowers/specs/2026-10-28-10db-first-run-design.md` (reviewed once; decisions F1–F18). Coverage: §4 first run (Tasks 16–18), §5 shell (Tasks 1–4), §6 Board (Tasks 5, 6, 8), §7 drawer and New Task (Tasks 7, 9), §8 Settings (Tasks 10–12), §9.1–9.2 (Tasks 13–14), §9.3 (Task 15), §9.4 (Tasks 19–23), §10 (the DESIGN.md PR, merged before this plan starts), §12 (every task), §13–14 (Task 24).

**Plan series:** … `14-worktree-mode`, **`15-first-run-and-board` (this file)**.

This plan was written against `main` at `b2e20d1` plus the spec, and adjusted for the builder's answers (spec §14) on `main` at `542d3bb`. Where a file, signature or anchor it names doesn't match the code, trust the code, adapt the step and say so in the task's report.

## Decisions made in the plan

1. **Two PRs.** Tasks 1–18 are one PR (`feat(desktop): first run, board and settings as agreed`); Tasks 19–24 a second (`feat(daemon): let a project run without a gate command`), opened after the first merges and after the areas task (queue task 0) merges, since both edit `ProjectPatch`. Task 24's doc lines for Tasks 1–18 go in the first PR.
2. **`folders/` is a new daemon module** after `git` in the dependency order (`… git, github, verify, routing, picker, folders → sessions …`). It imports `git` and `@10db/contracts`; `daemon/` wires it; `api` reaches it through `ApiServices.inspectFolder`.
3. **`Git.inspect(path)`** is the one new git method: it resolves the real path, refuses through typed results (never `onRefused`), and reads top level, bare-ness, branches, `origin/HEAD`, current branch and origin's fetch URL with the daemon's `git()` on the observed site. It never calls `pinned()`.
4. **The Settings base branch stays a text input** (spec §13).
5. **The first-run gate rule is staged.** Task 17 requires a non-empty gate command; Task 23 relaxes it to send `null` when empty.
6. **`InboxKind.Check = 'check'`** and **`EvidenceKind.Builder = 'builder'`**. `EvidenceDto` becomes a discriminated union on `kind`: `gate` keeps `command: string, exitCode: number`; `agent` keeps what it has today; `builder` has `command: null, exitCode: null`.
7. **Protocol version** goes up by one in Task 19 (a narrowing change: `ProjectDto.gateCommand` becomes nullable) and again in Task 15 only if `ToolCheck.signedIn` without a default would narrow; with `.default(null)` it doesn't, so Task 15 leaves it.
8. **`useProjectSetup`** lives in `apps/desktop/src/views/project-setup/`, used by both the first run and the switcher's New Project modal; `views/board/new-project-form.tsx` is deleted in Task 17.

## Global Constraints

- **Branches and worktrees:** each PR in its own worktree under `../10db-worktrees/` from `origin/main` (root `AGENTS.md`); PR 1 is `feat/desktop-first-run-board` in `../10db-worktrees/first-run-build`. Never edit, switch or stash `~/Projects/10db` while a 10db task holds it.
- **Gate:** while several sessions share this Mac, run it only through `bash ~/Projects/10db/scratch/tools/gate-one-at-a-time.sh` from the worktree. Per-task checks use the package's own `vitest run` on the files the task touched.
- **Settings files shared with the areas task:** queue task 0 (branch `10db/edit-a-project-s-areas-and-hazards-in-729ae2e5`) edits `views/settings/project-areas.tsx`, `sections.ts`, `section-body.tsx` and possibly `settings-view.tsx`. Tasks 10–12 change those files only where the task requires, without reformatting or reordering untouched code, so whichever branch lands second merges easily. `project-areas.tsx` is not touched at all.
- **Commits:** one per task: `git add <paths> && git commit -m '<type>(<scope>): <subject>' -m 'Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'`. Single quotes. Scopes from `commitlint.config.js` (optional). Run `pnpm format` first. A failing hook leaves the paths staged: fix and rerun. Never `--no-verify`, `LEFTHOOK=0` or `core.hooksPath`.
- **Tests** (`.claude/rules/testing.md`): red first, noting the failure; desktop tests use MSW through `src/test/daemon.tsx` (`serve`, `renderApp`, `daemonUrl`) and fixtures in `src/test/fixtures.ts`; daemon tests use real git through `createTempRepoWithOrigin`/`createTempRepo` (`apps/daemon/test/fixtures.ts`), `isolatedGitEnv()` on every git call, `FakeAdapter`, `FakeGh`; no sleeps (`waitFor`, `scheduler.idle()`, fake timers in jsdom). Table-driven for gate detection, inspection refusals, Claude row states and the optional-gate runner cases.
- **Copy** follows the DESIGN.md rules: Title Case for buttons, menu items and names; sentence case for labels, descriptions and messages. The exact strings are the spec's; copy them, don't paraphrase.
- **Motion** only as DESIGN.md allows: 150–200 ms eases of opacity, color or shadow.
- **Code style** (`.claude/rules/code-style.md`): `as const` objects, typed errors with a `name`, zod at every boundary (the inspect body, `recheck`, `package.json`), no `as`/`!`/`any` outside a validated boundary, exhaustive switches over `InboxKind`, `EvidenceKind`, `NextAction['kind']` and the refusal reasons, no grab-bag modules.
- **Generated files:** after any contracts change, `pnpm --filter @10db/contracts generate`; migrations with `pnpm --filter @10db/db generate`, forward-only (v0.1.0 is released).
- **Pins:** every new dependency exact, the latest stable that passes the supply-chain minimum age when the task runs; a held-back pin gets a decision file.
- **Done** is `make gate` printing `GATE PASS`, per PR.

## Review Focus

1. **Inspecting a folder changes it or raises a card.** A builder picks a repo with a hook, an fsmonitor setting, an alternates file, a gitfile pointing elsewhere, or a `package.json` that links to `~/.ssh/id_ed25519`. Expected: nothing in the folder changes, no Inbox card, the link isn't read, the answer is a typed refusal or a plain answer. Tests: Task 14's table rows `hook`, `fsmonitor`, `gitfile elsewhere`, `package.json link`, plus `no card raised` in every row.
2. **A task with no gate completes on the agent's word.** Any path that reaches DONE without the builder's Approve: a restart while waiting, a Retry after a send-back, a middle step's advance mis-read as the last. Tests: Task 20 `last step without a gate waits for the builder`, `a restart while waiting keeps one card and the same next action`; Task 21 `only Approve completes`.
3. **Approve starts a Claude session.** The `check` card reaching `deliverParkedAnswer`. Test: Task 21 `approve completes with no session started` (FakeAdapter's session count unchanged).
4. **The board's drag regresses for keyboard users.** Space on a focused card must pick it up, Enter must open the drawer, and the card menu's Enter/Space must not do either; a locked card's reason must be heard on focus. Tests: Task 8 unit tests and the e2e keyboard drag.
5. **The first run shows for a project list that hasn't loaded, or hides behind a reconnecting banner.** Tests: Task 18 `shows the shell while projects load`, `shows the first run only once the list loads empty`.

---

## File Structure

| Path | Change |
| --- | --- |
| `apps/desktop/src/theme.ts`, `theme.test.ts` | component defaults (Task 1) |
| `apps/desktop/src/shell/app-layout.tsx` | navbar fills (1), switcher (4), Settings nav (10), first run (18) |
| `apps/desktop/src/shell/use-hidden-edges.ts` (new) | the hook (2) |
| `apps/desktop/src/shell/form-modal.tsx` (new) | (2) |
| `apps/desktop/src/shell/app-error.tsx` (new), `src/router.tsx` | root error page (3) |
| `apps/desktop/src/views/settings/accounts/sign-in-steps.tsx` | copy icon centered (3) |
| `apps/desktop/src/shell/project-tile.tsx`, `project-switcher.tsx` (new); `project-picker.tsx` (deleted) | (4) |
| `apps/desktop/src/shell/split-button.tsx` (new), `views/board/board-view.tsx` | toolbar (5) |
| `apps/desktop/src/views/board/board-column.tsx`, `board-scroll.tsx` (new), `column-hints.ts` (new) | columns (6) |
| `apps/desktop/src/views/board/task-drawer.tsx`, `flow-select.tsx`, `risk-labels.ts` (new) | drawer (7) |
| `apps/desktop/src/views/board/board-dnd.tsx`, `task-card.tsx`, `task-card-menu.tsx`, `e2e/loop.spec.ts` | drag (8) |
| `apps/desktop/src/views/board/field-help.tsx` (new), `new-task-form.tsx` | New Task (9) |
| `apps/desktop/src/views/settings/settings-nav.tsx`, `settings-view.tsx`, `sections.ts`, `setting-row.tsx` (new) | layout (10) |
| `apps/desktop/src/views/settings/project-general-form.tsx`, `workspace-fields.tsx` (folded in, deleted) | General (11) |
| `apps/desktop/src/views/settings/project-billing.tsx`, `keep-awake-section.tsx`, `board-columns-section.tsx`, `accounts/*`, `account-select.tsx` (new), `shell/keep-awake-control.tsx` | other sections (12) |
| `apps/daemon/src/folders/` (new: `gate-candidates.ts`, `inspect.ts`, `index.ts`) | (13, 14) |
| `apps/daemon/src/git/git.ts`, `git/inspect.ts` (new) | `Git.inspect` (14) |
| `packages/contracts/src/folders.ts` (new), `system.ts`, `index.ts` | contracts (14, 15) |
| `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/services.ts` | routes (14, 15, 22) |
| `apps/daemon/src/github/gh.ts`, `environment/system-check.ts` | gh login (15) |
| `apps/desktop/package.json`, `src-tauri/{Cargo.toml,src/lib.rs,capabilities/default.json}` | dialog plugin (16) |
| `apps/desktop/src/views/project-setup/` (new), `views/board/new-project-form.tsx` (deleted) | shared form (17) |
| `apps/desktop/src/views/first-run/` (new), `e2e/prepare.ts` or `loop.spec.ts` | first run (18) |
| `packages/contracts/src/{entities,states,workflow}.ts`, `packages/db/src/{schema.ts,store/*}`, `packages/db/drizzle/` | optional gate data (19) |
| `apps/daemon/src/permissions/rules.ts`, `runner/runner.ts`, `runner/next-action.ts`, `recovery/recover.ts` | (19, 20) |
| `apps/daemon/src/inbox/service.ts`, `briefing/prompts.ts`, `daemon/` wiring | (21) |
| `apps/daemon/src/delivery/ship.ts`, `delivery/pr-text.ts`, `git/git.ts` (`diffSince`) | (22) |
| `apps/desktop/src/views/inbox/`, `views/settings/project-general-form.tsx`, `views/project-setup/` | (23) |
| docs | (24) |

---

### Task 1: Theme defaults and sidebar fills

**Files:**
- Modify: `apps/desktop/src/theme.ts`, `apps/desktop/src/shell/app-layout.tsx`
- Test: `apps/desktop/src/theme.test.ts`

**Interfaces:**
- Produces: `theme.components` with `Select`, `MultiSelect` (`checkIconPosition: 'right'`), `Switch` (`withThumbIndicator: false`), `NavLink` (root radius `var(--mantine-radius-md)`, label weight 600 when active).

- [ ] **Step 1: Write the failing tests** in `theme.test.ts`:
  - `puts the check of Select and MultiSelect on the right`: `theme.components?.Select?.defaultProps` has `checkIconPosition: 'right'`; same for `MultiSelect`.
  - `turns off the Switch thumb indicator`: `withThumbIndicator` is `false`.
  - `rounds nav links and weights the active label`: render `<NavLink active label="A" />` and `<NavLink label="B" />` in `MantineProvider theme={theme}`; A's label has `font-weight: 600`, B's doesn't; both roots have `border-radius: var(--mantine-radius-md)`.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop test theme` → FAIL (no component defaults).
- [ ] **Step 3: Implement** with `Select.extend`, `MultiSelect.extend`, `Switch.extend`, `NavLink.extend({ styles: (_t, props) => … })`. In `app-layout.tsx`, give `AppShell.Navbar` `bg="var(--mantine-color-default)"` and the navbar-scoped variables `--mantine-primary-color-light: var(--mantine-color-default-hover)`, `--mantine-primary-color-light-color: var(--mantine-color-bright)`, `--mantine-color-dark-6` and `--mantine-color-gray-0` both `var(--mantine-color-default-hover)`, with one comment on why (the sidebar sits a Selenized step above the content). The existing `theme.test.ts` Selenized check must still pass: every value is a Selenized one.
- [ ] **Step 4: Run** the desktop tests → PASS.
- [ ] **Step 5: Commit** `feat(desktop): theme defaults for checks, switches and nav fills`.

### Task 2: `useHiddenEdges` and `FormModal`

**Files:**
- Create: `apps/desktop/src/shell/use-hidden-edges.ts`, `apps/desktop/src/shell/form-modal.tsx`
- Test: `apps/desktop/src/shell/use-hidden-edges.test.tsx`, `apps/desktop/src/shell/form-modal.test.tsx`

**Interfaces:**
- Produces: `useHiddenEdges(): { ref: (el: HTMLElement | null) => void; edges: { top: boolean; bottom: boolean; left: boolean; right: boolean }; onScroll: () => void }` (one pixel of slack; observes the element and its first child with `ResizeObserver` when available; measures when the ref attaches).
- Produces: `FormModal({ opened, onClose, title, size = 'lg', actions, error = null, children })` as spec §5.3: centered `Modal.Root`, fixed header and footer, footer `role="alert"` region left with the error (red `IconAlertTriangle` 20, `Text c="red" lineClamp={2}`), actions right; header shadow while `edges.top`, footer shadow while `edges.bottom`, `transition: box-shadow 200ms ease`; panel styles through `styles.content`.

- [ ] **Step 1: Write the failing tests.**
  - `use-hidden-edges.test.tsx`, a table over `{scrollTop, clientHeight, scrollHeight, scrollLeft, clientWidth, scrollWidth}` (set with `Object.defineProperty` on a test element; `ResizeObserver` stubbed to call back on `observe`): rows `nothing hidden`, `bottom hidden`, `top hidden`, `both`, `one pixel short counts as none`, `right hidden`. Each asserts `edges`.
  - `form-modal.test.tsx`: `renders the title, children and actions`; `shows the error beside the actions` (the alert region holds the text, the actions are its siblings in the footer); `has no error text when error is null`; `closes on the close button`.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop test use-hidden-edges form-modal` → FAIL (modules missing).
- [ ] **Step 3: Implement** both. The spike's `shell/form-modal.tsx` is the reference; replace its inline measuring with the hook.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): a form modal with a fixed footer and scroll shadows`.

### Task 3: Root error page and the sign-in copy icon

**Files:**
- Create: `apps/desktop/src/shell/app-error.tsx`
- Modify: `apps/desktop/src/router.tsx` (`createRootRoute({ component: AppLayout, errorComponent: AppError })`), `apps/desktop/src/views/settings/accounts/sign-in-steps.tsx` (copy icon `align="center"`)
- Test: `apps/desktop/src/shell/app-error.test.tsx`

- [ ] **Step 1: Write the failing tests:** `shows the message with Try Again and Reload Window` (render `AppError` with `error: new Error('boom')`, a `reset` spy; the text `boom` in a code block, title "10db hit an error it couldn't recover from"); `Try Again calls reset`; `keeps a drag strip clear of the traffic lights` (a 48 px element with `data-tauri-drag-region`); `a crash outside every view renders it` (a router whose root layout throws renders the title).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §5.3 (spike `shell/app-error.tsx` is the reference). Reload Window calls `window.location.reload`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `fix(desktop): a root error page that clears the traffic lights`.

### Task 4: Project switcher in the sidebar

**Files:**
- Create: `apps/desktop/src/shell/project-tile.tsx`, `apps/desktop/src/shell/project-switcher.tsx`
- Delete: `apps/desktop/src/shell/project-picker.tsx` and its uses
- Modify: `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/src/views/board/board-view.tsx` (drop the picker, the "Board" title and the path · gate · areas line), `apps/desktop/src/views/settings/settings-view.tsx` (drop its picker)
- Test: `apps/desktop/src/shell/project-switcher.test.tsx`; update `board-view.test.tsx` and `settings-view.test.tsx` where they find the old picker

**Interfaces:**
- Consumes: `FormModal` (Task 2), `useSelectedProject()` (`shell/selected-project.ts`).
- Produces: `ProjectTile({ name, size = 24 })` (two uppercase letters, blue filled `Avatar`, radius `sm`, `aria-hidden`); `ProjectSwitcher({ compact = false })`; its New Project modal renders `NewProjectForm` from `views/board/new-project-form.tsx` inside a `FormModal` until Task 17 replaces it.

- [ ] **Step 1: Write the failing tests** (`project-switcher.test.tsx`, MSW with two projects `alpha` `/Users/x/a` and `beta` `/Users/x/b`):
  - `names the current project`: the button's accessible name is "Project: alpha. Switch project".
  - `lists projects with home-relative paths and a check on the current one`: after a click, options "alpha" with `~/a` and "beta" with `~/b`; the check icon is only in alpha's option.
  - `filters by name or path`: typing `b` in "Find a project" leaves beta only; typing `zzz` shows "No project matches".
  - `switches the project`: choosing beta makes the button say beta and the Board loads beta's tasks (`GET /projects/<beta>/tasks` called).
  - `opens New Project from the footer`: a dialog named "New Project" appears.
  - `board-view.test.tsx`: `has no page title or metadata line` (no heading "Board", no gate command text).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §5.1 (Combobox 300 px wide, `Combobox.Search` "Find a project", options with `ProjectTile`, name `sm`/500, `~` path `xs` dimmed monospace truncated, `IconCheck` right on the current one, `Combobox.Footer p="sm"` with a full-width `default` "New Project"; modal mounted only while open). In `app-layout.tsx` the switcher heads the navbar, then a `Divider my="xs"`, then the nav links.
- [ ] **Step 4: Run** → PASS, including the updated Board and Settings tests.
- [ ] **Step 5: Commit** `feat(desktop): switch projects from the top of the sidebar`.

### Task 5: Board toolbar with a split New Task button

**Files:**
- Create: `apps/desktop/src/shell/split-button.tsx`
- Modify: `apps/desktop/src/views/board/board-view.tsx`
- Test: `apps/desktop/src/shell/split-button.test.tsx`, `apps/desktop/src/views/board/board-view.test.tsx`

**Interfaces:**
- Produces: `SplitButton({ children, onClick, leftSection?, menuLabel, menu })`.

- [ ] **Step 1: Write the failing tests:**
  - `split-button.test.tsx`: `runs the primary action`; `opens the menu from the chevron named by menuLabel`.
  - `board-view.test.tsx`: `New Task opens the task form in a dialog named New Task with Create Task`; `Start Ready Tasks is disabled with "Nothing in Ready" when Ready is empty`; `Start Ready Tasks shows "2 ready" and opens the batch sheet`; `Add Column opens Settings at Board columns` (location `/settings/board-columns`); `shows no "No tasks yet" line`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** the toolbar per spec §6 (right-aligned `SplitButton` "New Task" with `IconPlus`; menu label "More board actions"; the Ready count as a dimmed `xs` span inside the item on the label's baseline; `IconPlayerPlay` and `IconColumns` items). The New Task form moves into a `FormModal` titled "New Task" (its submit button becomes the footer action in Task 9; here, keep the form's own button but rename it "Create Task"). Update every test and e2e string that names "New task", "Create task" or "Start a batch".
- [ ] **Step 4: Run** desktop tests → PASS.
- [ ] **Step 5: Commit** `feat(desktop): one split New Task button on the board`.

### Task 6: Full-height columns with hints and edge fades

**Files:**
- Create: `apps/desktop/src/views/board/column-hints.ts`, `apps/desktop/src/views/board/board-scroll.tsx`
- Modify: `apps/desktop/src/views/board/board-column.tsx`, `board-view.tsx`
- Test: `apps/desktop/src/views/board/column-hints.test.ts`, `board-view.test.tsx`

**Interfaces:**
- Produces: `SYSTEM_HINT: Readonly<Record<BoardStatus, string>>`, `HUMAN_HINT`, `columnHint(column: LayoutColumn): string` (strings exactly as spec §6's table); `BoardScroll({ children })`; `BoardColumn` props gain `hint: string`, `footer?: ReactNode`, `targeted?: boolean`; the lock icon goes.

- [ ] **Step 1: Write the failing tests:**
  - `column-hints.test.ts`, a table: one row per `BoardStatus` and one human column, asserting the string.
  - `board-view.test.tsx`: `an empty column shows its hint and a dashed border` (Ready empty: "Next up. Start Ready Tasks picks from here."; its `Paper` border style contains `dashed`); `a column with a card hides its hint and has a solid border`; `the count is a plain number labelled "N tasks"`; `Ready ends in Add Task, which opens New Task`; `no lock icon on system columns`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §6 (240 px, 40 px header band in `var(--mantine-color-default)`, border dashed while empty, hint `xs` dimmed under the band, Add Task dashed `default` `xs` full-width in Ready, Done's "Show all N" kept). `BoardScroll` uses `useHiddenEdges` (Task 2) for left/right fades (56 px, gradient to `var(--mantine-color-body)`, `opacity` eased 200 ms, mounted always), `ScrollArea type="hover" scrollbars="x" scrollbarSize={12} offsetScrollbars="x"`, 12 px under the columns, `styles={{ content: { height: '100%' } }}`. The board's root `Stack` takes `h="calc(100dvh - var(--app-shell-header-offset, 0px) - 2 * var(--mantine-spacing-md))"`.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): full-height board columns with hints and edge fades`.

### Task 7: The task drawer

**Files:**
- Create: `apps/desktop/src/views/board/task-drawer.tsx`, `apps/desktop/src/views/board/flow-select.tsx`, `apps/desktop/src/views/board/risk-labels.ts`
- Test: `apps/desktop/src/views/board/task-drawer.test.tsx`, `apps/desktop/src/views/board/flow-select.test.tsx`

**Interfaces:**
- Consumes: `usePatchTask()`, `useFlows()` (`daemon/queries.ts`).
- Produces: `TaskDrawer({ task, columnName, peers, active, onClose })` (`active`: the task has a live workstream); `FlowSelect({ value, onChange, ...SelectProps })`; `flowTitle(name: string): string`; `RISK_LABEL: Record<RiskTag, string>`.

- [ ] **Step 1: Write the failing tests:**
  - `flow-select.test.tsx`: `flowTitle` table (`quick` → `Quick`, `plan-first` → `Plan First`); `orders flows by step count and shows steps as a byline` ("Build → Review" under Quick).
  - `task-drawer.test.tsx`: `shows the title, column, areas and waits-on`; `saves the five fields` (the `PATCH /tasks/:id` body is `{ title, description, acceptanceCriteria, flowId, riskTags }` with trimmed lines); `refuses an empty title` ("Give the task a title", no request); `refuses no criteria` ("Add at least one acceptance criterion"); `shows the daemon's refusal beside Save` ("Couldn't save: …"); `says changes apply next session while active` ("Changes apply from the task's next session."); `closing with edits asks first` (Cancel after an edit opens "Discard your changes to this task?"; "Keep Editing" keeps the drawer and the edit; "Discard" closes it); `Escape with edits asks too`; `closing with no edits closes at once`; `risk options read in plain words` (the four labels of spec §7.1).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §7.1 (520 px right `Drawer` titled "Task", `padding="lg"`; footer sticky at the bottom with the error left and Cancel/"Save Changes" right). Task 8 mounts it from the board.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): open a task's details in a drawer and edit them`.

### Task 8: Drag the whole card; cards open

**Files:**
- Modify: `apps/desktop/src/views/board/board-dnd.tsx`, `task-card.tsx`, `task-card-menu.tsx`, `board-view.tsx`, `apps/desktop/e2e/loop.spec.ts`
- Test: `apps/desktop/src/views/board/board-view.test.tsx`

**Interfaces:**
- Consumes: `TaskDrawer` (Task 7).
- Produces: `BoardDnd` props gain `accepts(taskId, target): boolean` and `onOpen(task)`; `renderColumn(column, cards, listRef, targeted)`; the card is one `role="button"` element named by the task title, with `aria-describedby` pointing at its refusal when it can't move. `renderCard(task)` no longer takes a handle.

- [ ] **Step 1: Write the failing tests** (`board-view.test.tsx`; jsdom can't drive dnd-kit's pointer sensor, so these use click and keys):
  - `clicking a card opens its details` (a dialog named "Task" with the title's value).
  - `Enter on a focused card opens its details`.
  - `Enter or Space on the card menu does not open the card` (focus "Actions for X", press Enter: the menu opens, no "Task" dialog).
  - `a locked card names why on focus` (an in-progress card's `aria-describedby` element text is today's refusal for in-progress work).
  - `the card shows areas as labels and the criteria count` ("2 criteria"; "1 criterion").
  - `no drag handle` (no button named "Drag <title>").
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §6 "Drag" and "Cards" (spike `board-dnd.tsx` and `task-card.tsx` are the reference): pointer sensor `distance: 4`; keyboard sensor `keyboardCodes: { start: ['Space'], cancel: ['Escape'], end: ['Space', 'Enter'] }`; Enter on the card element itself opens; a click within the tick after a drop is ignored (a ref cleared on the next macrotask is acceptable here: it's UI event ordering, not a wait); `DragOverlay` portaled to `document.body`; the dragged card's slot at opacity 0.3; `targeted` from `onDragOver` through `accepts`; the column's outline `inset 0 0 0 2px var(--mantine-color-blue-filled)`, fill `var(--mantine-color-blue-light)`, eased 150 ms. The card menu's wrapper stops click and keydown propagation.
- [ ] **Step 4: Update `e2e/loop.spec.ts`:** focus the card (`getByRole('button', { name: TASK })`), press Space, arrows, Space; the locked-card check reads the card's accessible description instead of a "Can’t drag" handle.
- [ ] **Step 5: Run** desktop tests and `pnpm --filter @10db/desktop e2e` → PASS.
- [ ] **Step 6: Commit** `feat(desktop): drag a board card from anywhere and click to open it`.

### Task 9: New Task form

**Files:**
- Create: `apps/desktop/src/views/board/field-help.tsx`
- Modify: `apps/desktop/src/views/board/new-task-form.tsx`, `board-view.tsx`
- Test: `apps/desktop/src/views/board/new-task-form.test.tsx` (create if absent), `field-help.test.tsx`

**Interfaces:**
- Produces: `LabelWithHelp({ label, children })` (info icon `IconInfoCircle` 14, `HoverCard` 360 wide, visually hidden "About <label lowercased>"); `NewTaskForm` exposes its submit to `FormModal`'s footer (a `formId` the footer button submits with `form={formId}`).

- [ ] **Step 1: Write the failing tests:** `hides hazards from Areas` (a project with areas `api`, `ui` and hazards `migrations`: options are api and ui only); `hides Areas with one area and sends it` (the POST body's `areas` is `['repo']`); `the criteria placeholder shows an example` (the placeholder text of spec §7.2); `the criteria help names the gate command` (hover the icon: the project's gate command appears); `Create Task sits in the modal footer and submits`; `the description starts at one row` (`rows` attribute 1).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §7.2.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): a plainer New Task form`.

### Task 10: Settings takes over the sidebar; cards of rows

**Files:**
- Create: `apps/desktop/src/views/settings/setting-row.tsx`
- Modify: `apps/desktop/src/views/settings/settings-nav.tsx`, `settings-view.tsx`, `sections.ts`, `apps/desktop/src/shell/app-layout.tsx`
- Test: `apps/desktop/src/views/settings/settings-view.test.tsx`, `sections.test.ts`, `setting-row.test.tsx`

**Interfaces:**
- Produces: `SettingsCard({ title?, children })` (hairlines between non-null rows); `SettingRow({ label, description?, children, stacked = false })` (260 px control column); `SettingsGroup = { Project: 'project', Global: 'global' }` (the `App` key renamed); the navbar renders `SettingsNav` on `/settings/*`.

- [ ] **Step 1: Write the failing tests:**
  - `settings-view.test.tsx`: `the sidebar shows Back to Board, Project with the switcher, and Global`; `planned sections are hidden` (no "Team", "Routing rules", "Models and benchmarks", "Personas and flows" links); `the page has no title and no project picker`; `Back to Board returns to /board`.
  - `setting-row.test.tsx`: `puts the control beside the text`; `stacks a wide control under the text`; `SettingsCard skips null rows without doubling dividers` (two rows and a null: one divider).
  - `sections.test.ts`: the group values are `project` and `global`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §8.1 (spike `settings-nav.tsx`, `setting-row.tsx` as reference; compact switcher: 16 px tile, `sm`, `bg="var(--mantine-color-body)"`, `bd="1px solid var(--mantine-color-default-border)"`, `py={6}`, `mb="xs"`). Remove width caps (Settings 760, Accounts 880, Board columns 640).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): settings take over the sidebar, as cards of rows`.

### Task 11: Settings › General in cards with a save bar

**Files:**
- Modify: `apps/desktop/src/views/settings/project-general-form.tsx`, `general-values.ts`
- Delete: `apps/desktop/src/views/settings/workspace-fields.tsx` (folded in)
- Test: `apps/desktop/src/views/settings/project-general-form.test.tsx` (create if absent), `general-values.test.ts`

- [ ] **Step 1: Write the failing tests:** a table over spec §8.2's rows: each row's label is present with its line, and changing its control then Save sends that one field in the `PATCH /projects/:id` body (`name`, `gateCommand`, `delivery`, `baseBranch`, `prTitlePrefix`, `maxLanes`, `workspaceMode`, `worktreeSeed`, `handoffPct`, `flowId`, `nudgePct`, `humanWaitMinutes`, `budgetCeiling`, `allowedCommands`, `sandboxLoopback`). Plus: `Base branch and Pull request title show only for pull requests`; `Copy into each task's copy shows only for Separate copies`; `Advanced is collapsed with aria-expanded false and opens`; `Saved shows a green check and fades after 4 s` (fake timers); `a save error sits left of Reset and Save`; `labels aren't monospace; values of Gate command and Base branch are`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §8.2. The save bar: `pos="sticky" bottom={0}`, z-index `var(--mantine-z-index-app)`, a negative bottom margin equal to `var(--app-shell-padding)` so the page ends at the bar.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): settings general as cards in plain words`.

### Task 12: Billing, Keep awake, Board columns and Accounts

**Files:**
- Create: `apps/desktop/src/views/settings/account-select.tsx`
- Modify: `project-billing.tsx`, `keep-awake-section.tsx`, `board-columns-section.tsx`, `accounts/accounts-section.tsx` (and the Title Case action labels in `accounts/*`), `apps/desktop/src/shell/keep-awake-control.tsx`, `keep-awake-labels.ts`
- Test: the sections' existing tests, plus `account-select.test.tsx`

**Interfaces:**
- Produces: `AccountSelect({ accounts, value, onChange, ...SelectProps })` (the field shows the account's name; each option's byline "email · kind").

- [ ] **Step 1: Write the failing tests:** `Billing has Account, Backup account and Switch at, and no fallback model`; `AccountSelect shows the email and kind as a byline`; `Keep awake is one row with Never, While tasks run and Always`; `the header's keep-awake menu has no label and checks on the right`; `Board columns lists the state columns after yours, dimmed, with counts and their hint, and no arrows`; `your columns lead with up and down arrows`; `Accounts actions read Add Account, Archive Account`; `the This month column is right-aligned`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §8.3–8.4. Leave `project-areas.tsx` alone (queue task 0 owns it).
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): billing, keep awake, columns and accounts in the new style`.

### Task 13: Gate detection

**Files:**
- Create: `apps/daemon/src/folders/gate-candidates.ts`, `apps/daemon/src/folders/index.ts`
- Modify: `apps/daemon/AGENTS.md` (module order: `folders` after `picker`), the ESLint module-boundary list if it names modules
- Test: `apps/daemon/src/folders/gate-candidates.test.ts`

**Interfaces:**
- Produces: `GateSource = { Makefile: 'makefile', PackageJson: 'package_json', Cargo: 'cargo', Go: 'go' } as const`; `interface FolderFiles { makefile: string | null; packageJson: unknown; lockfiles: readonly string[]; cargoToml: boolean; goMod: boolean }`; `gateCandidates(files: FolderFiles): { command: string; source: GateSource }[]`. `packageJson` is parsed inside with zod (`{ scripts?: Record<string,string>, packageManager?: string }`, passthrough); anything else counts as absent.

- [ ] **Step 1: Write the failing test**, a table (`it.each`) with these rows and expected command lists:

  | Row | Input | Expected |
  | --- | --- | --- |
  | makefile gate | `gate:\n\tpnpm test` | `make gate` |
  | double colon | `gate::` | `make gate` |
  | prerequisites | `gate: lint test` | `make gate` |
  | phony only | `.PHONY: gate` | none |
  | pattern | `%:` | none |
  | order | `test:\ncheck:\ngate:` | `make gate`, `make check`, `make test` |
  | pnpm by field | scripts `{test:'vitest'}`, `packageManager:'pnpm@10.0.0'` | `pnpm test` |
  | yarn by lockfile | scripts `{check:'x'}`, lockfiles `['yarn.lock']` | `yarn run check` |
  | bun | scripts `{test:'x'}`, lockfiles `['bun.lock']` | `bun run test` |
  | npm default | scripts `{gate:'x'}` | `npm run gate` |
  | npm placeholder | scripts `{test:'echo "Error: no test specified" && exit 1'}` | none |
  | cargo | `cargoToml: true` | `cargo test` |
  | go | `goMod: true` | `go test ./...` |
  | several | Makefile `test:`, pnpm `gate`, cargo | `make test`, `pnpm run gate`, `cargo test` |
  | not an object | `packageJson: 'x'` | none |

  Each row also asserts each candidate's `source`.
- [ ] **Step 2: Run** `pnpm --filter @10db/daemon test gate-candidates` → FAIL (module missing).
- [ ] **Step 3: Implement** per spec §9.2. The Makefile rule: `/^(gate|check|test)::?(?:\s|$)/m` per name, checked in order; no other parsing.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): detect a folder's gate command from its files`.

### Task 14: Folder inspection

**Files:**
- Create: `packages/contracts/src/folders.ts` (export from `index.ts`, register in `json-schema.ts`), `apps/daemon/src/git/inspect.ts`, `apps/daemon/src/folders/inspect.ts`
- Modify: `apps/daemon/src/git/git.ts` (`Git.inspect`), `git/index.ts`, `apps/daemon/src/api/app.ts`, `api/services.ts`, `apps/daemon/src/daemon/services.ts`
- Test: `apps/daemon/src/folders/inspect.test.ts`, `apps/daemon/src/api/app.test.ts` (one route test; append, don't restructure: the areas task is editing this file, so rebase on it first)

**Interfaces:**
- Produces (contracts): `FolderInspectInput = { path: z.string().startsWith('/') }`; `FolderRefusalReason` (`as const`: `not_found`, `not_a_directory`, `not_a_repository`, `bare_repository`, `already_a_project`, `inside_a_project`, `protected_path`, `unreadable`); `FolderInspection` (spec §9.1 shape, `github: z.string().nullable()`); `FolderInspectResult = { ok: true, inspection } | { ok: false, reason, message }`.
- Produces (git): `Git.inspect(path: string): Promise<RepoFacts | { refused: 'not_a_repository' | 'bare_repository' | 'unreadable'; message: string }>` with `RepoFacts = { root: string; branches: { name: string; remote: boolean }[]; defaultBranch: string | null; originFetchUrl: string | null }`. It runs on the observed site and never calls `onRefused`.
- Produces (folders): `inspectFolder(deps: { git: Git; projects: readonly ProjectDto[]; protectedRoots: readonly string[] }, path: string): Promise<FolderInspectResult>`; reads files with `lstat` first, 256 KiB cap.
- Route: `POST /folders/inspect` → 200 `FolderInspectResult` (a refusal is a 200 with `ok: false`; a bad body is 400).

- [ ] **Step 1: Write the failing tests** (`inspect.test.ts`, real temp repos with maintenance off): one row per case, each asserting the result and, after it, `no Inbox card` (the test's `onRefused` spy not called), `git status --porcelain` unchanged, `.git/config` bytes unchanged, and no new file under `.git`:
  - `a root with a GitHub origin` → `github: 'acme/widgets'`, branches with `main` (remote) first, `defaultBranch: 'main'`, `suggestedName` the folder's name.
  - `a subfolder answers for the root`.
  - `a path through a link answers the real root`.
  - `no commits` → `branches: []`, `defaultBranch: null`.
  - `no remote` → `github: null`, local branches only.
  - `a non-GitHub remote` → `github: null`.
  - `no origin/HEAD` → `defaultBranch` the current branch.
  - `hook` (a `post-checkout` hook writing a file) → no file written.
  - `fsmonitor` (`core.fsmonitor` set to a script that writes a file) → no file written.
  - `gitfile elsewhere` → `unreadable` or `not_a_repository` with a message, no card.
  - `package.json link to a file outside` → its scripts are not read (no candidates from it).
  - `package.json over 256 KiB` → not read.
  - refusals: `not_found`, `not_a_directory`, `not_a_repository`, `bare_repository`, `already_a_project` (message names it), `inside_a_project` both directions, `protected_path` (the data dir).
  - `app.test.ts`: `POST /folders/inspect refuses a relative path with 400`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** `git/inspect.ts` holds the porcelain parsing (`for-each-ref --format=%(refname)` over `refs/heads` and `refs/remotes/origin`, `symbolic-ref -q refs/remotes/origin/HEAD`, `symbolic-ref -q HEAD`, `rev-parse --is-bare-repository --show-toplevel`, `config --get remote.origin.url`); `Git.inspect` wires it to `git()` on the observed site. `inspectFolder` applies the project and protected-root refusals by real path, reads the files, calls `gateCandidates` and `githubRepoOf`.
- [ ] **Step 4: Run** daemon tests → PASS; `pnpm --filter @10db/contracts generate`.
- [ ] **Step 5: Commit** `feat(daemon): inspect a folder before it becomes a project`.

### Task 15: gh's login in the system check

**Files:**
- Modify: `apps/daemon/src/github/gh.ts`, `apps/daemon/src/environment/system-check.ts`, `packages/contracts/src/system.ts`, `apps/daemon/src/api/app.ts`, `api/services.ts`, `daemon/services.ts`, `apps/desktop/src/daemon/queries.ts` (`useSystemCheck().recheck()`)
- Test: `apps/daemon/src/github/gh.test.ts`, `environment/system-check.test.ts`, `api/app.test.ts`

**Interfaces:**
- Produces: `Gh.authLogin(call: GhCall): Promise<string | null>`; `ToolCheck.signedIn: z.string().nullable().default(null)`; `GET /system` query `{ recheck?: '1' }`; desktop `useRecheckSystem()` mutation that fetches with `recheck=1` and writes the result into the `system` query.

- [ ] **Step 1: Write the failing tests:** `authLogin` table over a fake exec: `signed in` (stdout `octocat\n` → `'octocat'`), `signed out by message` (stderr matching `SIGNED_OUT` → `null`), `signed out by exit 4` → `null`, `timeout` → throws. System check: `reports the gh login`; `a throw leaves signedIn null`. Route: `a plain GET /system after the first doesn't probe gh again` (exec call count), `?recheck=1 probes`, `?recheck=yes is a 400`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §9.3; the memo lives in the daemon's services, not module state.
- [ ] **Step 4: Run** → PASS; regenerate contracts.
- [ ] **Step 5: Commit** `feat(daemon): report whether gh is signed in`.

### Task 16: Tauri's folder panel

**Files:**
- Modify: `apps/desktop/package.json` (`@tauri-apps/plugin-dialog`, exact), `apps/desktop/src-tauri/Cargo.toml` (`tauri-plugin-dialog = "=<version>"`), `Cargo.lock`, `pnpm-lock.yaml`, `src-tauri/src/lib.rs` (`.plugin(tauri_plugin_dialog::init())` with a one-line comment), `src-tauri/capabilities/default.json` (`dialog:allow-open`, description sentence "The dialog may open the folder panel.")
- Create: `apps/desktop/src/desktop/choose-folder.ts`; a decision file in `docs/architecture/decisions/` only if the pin is held back
- Test: `apps/desktop/src/desktop/choose-folder.test.ts`

**Interfaces:**
- Produces: `chooseFolder(): Promise<string | null>` (opens the panel with `{ directory: true, title: 'Choose a git checkout' }`; null on cancel); `canChooseFolder(): boolean` (`isTauri()`).

- [ ] **Step 1: Write the failing test** with the plugin's `open` mocked at the module boundary: `returns the picked path`; `returns null on cancel`; `canChooseFolder is false outside Tauri`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.** Pick the npm and crate versions: the latest stable at least as old as the repo's supply-chain minimum age (`pnpm-workspace.yaml` or `.npmrc` names it); the npm and Rust versions must match. If that isn't the latest, write a new decision file in `docs/architecture/decisions/` (slug `dialog-plugin-pin`) saying why.
- [ ] **Step 4: Run** desktop tests and `make rust-check` → PASS.
- [ ] **Step 5: Commit** `feat(desktop): choose a project folder in the native panel`.

### Task 17: The shared project form

**Files:**
- Create: `apps/desktop/src/views/project-setup/project-setup.tsx`, `apps/desktop/src/daemon/folder-queries.ts`
- Delete: `apps/desktop/src/views/board/new-project-form.tsx`, its tests' project-creation cases (moved here)
- Modify: `apps/desktop/src/shell/project-switcher.tsx`
- Test: `apps/desktop/src/views/project-setup/project-setup.test.tsx`

**Interfaces:**
- Consumes: `POST /folders/inspect` (Task 14), `ToolCheck.signedIn` (Task 15), `chooseFolder` (Task 16), `AccountSelect` (Task 12), `FormModal` (Task 2).
- Produces: `useInspectFolder()` mutation; `useProjectSetup(onCreated): { fields: ReactNode; submit(): void; canSubmit: boolean; pending: boolean; error: string | null }`. Sends `{ name, repoPath: root, gateCommand, areas: [{ name: 'repo', globs: ['**'] }], handoffPct: 40, nudgePct: 50, delivery, accountId? }` plus, for pull requests, `{ baseBranch, prTitlePrefix: 'feat' }` (F8; drop the prefix when queue task 3 has lifted the rule, if it has by then).

- [ ] **Step 1: Write the failing tests** (MSW; `chooseFolder` mocked), one per behavior of spec §4.3:
  - `only the folder control shows at first`.
  - `choosing a folder inspects it and shows the root once with Change`.
  - `a subfolder shows "The repository's top folder."`.
  - `a refusal shows on the folder box and nothing else` (one row per reason from Task 14's enum, message shown).
  - `the browser types a path and inspects on blur`.
  - `prefills the name and the best gate candidate; pills fill the input`.
  - `an empty gate is a field error and Create Project stays disabled`.
  - `Account shows only with two accounts`.
  - `pull requests are preselected when possible`; `disabled without gh` ("Needs the GitHub CLI, signed in."), `signed out` (same), `with no GitHub remote` ("This folder has no GitHub remote."), `with no commits` ("This repository has no commits yet.").
  - `Base branch lists origin's branches first and preselects the default`; `with defaultBranch null nothing is preselected and Create Project waits for a choice`.
  - `sends the defaults` (the exact body above).
  - `a refusal from POST /projects shows "Couldn't create the project: …"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §4.3; the switcher's New Project modal now renders `setup.fields` in `FormModal` with Cancel and "Create Project".
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): one project form that inspects the folder`.

### Task 18: The first run

**Files:**
- Create: `apps/desktop/src/views/first-run/first-run.tsx`, `first-run/setup-check.tsx` (the Agents and Tools cards), `first-run/claude-row.ts` (the row's state as a pure function)
- Modify: `apps/desktop/src/shell/app-layout.tsx`, `apps/desktop/e2e/loop.spec.ts` (and `e2e/prepare.ts` if the API call belongs there)
- Test: `apps/desktop/src/views/first-run/claude-row.test.ts`, `first-run.test.tsx`

**Interfaces:**
- Produces: `claudeRow(input: { claude: ToolCheck | undefined; probing: boolean; identity: AccountIdentityDto | null; error: string | null }): { mark: 'ok' | 'bad' | 'pending'; detail: string; runsAs: string | null }` (`runsAs`: the email the footer names, null unless signed in); `FirstRun({ onCreated })`.

- [ ] **Step 1: Write the failing tests:**
  - `claude-row.test.ts`, a table over spec §4.2's four rows (signed in counts as `ok` whether or not the identity is recorded yet), plus `the personal organization is hidden` and `a real organization is shown`.
  - `first-run.test.tsx`: `shows the shell while projects load`; `shows the first run only once the list loads empty`; `Welcome → Get Started`; `the probe runs once on entering the step and on Recheck` (identity request count); `nothing patches the account` (no `PATCH /accounts/:id`); `the footer says "Tasks will run as <email>."`; `Add Another Login opens the Add Account modal`; `there is no Switch Login`; `Continue is enabled once Claude Code and git are found` and `disabled without git` and `disabled without Claude Code`; `Recheck on Tools sends recheck=1`; `gh rows: signed in, signed out, missing`; `Create Project lands on /board with the project selected`; `Back returns a step`; `a later step can't be clicked`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §4 (logo from `app-icon.svg` imported as a URL; left rail 290 px; footer with the error and actions; Title Case actions).
- [ ] **Step 4: Update e2e:** before `page.goto`, create the project with Playwright's `request.post` to `http://127.0.0.1:${E2E_DAEMON_PORT}/projects` with `Authorization: Bearer ${E2E_TOKEN}` (`e2e/paths.ts`, `e2e/ports.ts`) and the fields it typed before; drop the UI project-creation steps; keep everything after.
- [ ] **Step 5: Run** desktop tests, e2e, then `make gate` → `GATE PASS`.
- [ ] **Step 6: Commit** `feat(desktop): a first run that checks the setup and adds a project`.
- [ ] **Step 7:** Do Task 24's PR 1 files, then `make gate` → `GATE PASS`, and open PR 1.

### Task 19: Optional gate: contracts, data, workflow, permissions

Starts after PR 1 and queue task 0 have merged.

**Files:**
- Modify: `packages/contracts/src/entities.ts` (`gateCommand` nullable in input, DTO and patch; `EvidenceDto` union), `states.ts` (`InboxKind.Check`, `EvidenceKind.Builder`), `workflow.ts` (two edges), the `NextAction` union (`builder_review`), `protocol.ts` (version + 1), `packages/db/src/schema.ts` (`gate_command` nullable), a generated migration, `packages/db/src/store/*` that read the column or evidence, `apps/daemon/src/permissions/rules.ts`
- Test: `packages/contracts/src/workflow.test.ts`, `entities` tests, `packages/db/src/store/projects.test.ts`, `apps/daemon/src/permissions/rules.test.ts`

**Interfaces:**
- Produces: `NextAction` `{ kind: 'builder_review'; inboxId: InboxItemId }`; `canTransition(Verifying, WaitingHuman)` and `canTransition(WaitingHuman, Verifying)` true; `EvidenceDto` discriminated on `kind`.

- [ ] **Step 1: Write the failing tests:** `ProjectInput accepts no gate command and defaults it to null`; `ProjectPatch can clear the gate command`; `the two new edges exist and no others changed` (snapshot of the table minus the two); `builder evidence parses with null command and exit code; gate evidence without them doesn't`; `a project stored with no gate reads back null`; `baseAllowedTools with no gate has no Bash entry for it`; `the read-only filter with no gate keeps the same tools as before minus the gate`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement**; `pnpm --filter @10db/db generate`; `pnpm --filter @10db/contracts generate`. Every exhaustive switch over `InboxKind`, `EvidenceKind` and `NextAction['kind']` gains its arm (the compiler lists them); `nextActionAfterCrash` keeps `builder_review` as is; the desktop's switches get placeholder arms rendered in Task 23.
- [ ] **Step 4: Run** `make check` → PASS.
- [ ] **Step 5: Commit** `feat(contracts): a project may have no gate command`.

### Task 20: Optional gate: the runner and recovery

**Files:**
- Modify: `apps/daemon/src/runner/runner.ts` (`verify`), `apps/daemon/src/recovery/recover.ts`
- Test: `apps/daemon/src/runner/runner.test.ts` (new `describe('without a gate command')`), `apps/daemon/src/recovery/recover.test.ts`

- [ ] **Step 1: Write the failing tests**, a table over a two-step flow on the fake adapter with `gateCommand: null`:
  - `a middle step advances without evidence` (step 2 queued, reason "no gate command", no evidence rows).
  - `last step without a gate waits for the builder`: state `WAITING_HUMAN`, `currentSessionId` null, `nextAction` `builder_review` with the card's id, one open `check` card targeting the workstream, title "Ready for you to check: <title>", options `approve` and `send_back`, detail `{ workstreamId, baseHead, head, commits }`, claims still held, no lane counted.
  - `a restart while waiting keeps one card and the same next action` (`recoverOnStartup`: still `WAITING_HUMAN`, same `nextAction`, one open card).
  - `a crash in VERIFYING with no gate raises the card once` (recover twice: one card).
  - `with a gate everything is as today` (the existing gate tests unchanged).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §9.4 items 4 and 7. Recovery checks for a `check` card before the generic "open card → answer" branch.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): finished work waits for the builder when there is no gate`.

### Task 21: Optional gate: answering the check

**Files:**
- Modify: `apps/daemon/src/inbox/service.ts` (`onCheckAnswer`; a `check` card never reaches `onParkedAnswer`; Send Back without a note is a 400 `InboxAnswerRefused`), `apps/daemon/src/runner/runner.ts` (`approveCheck(id)`, `sendBack(id, note)`), `apps/daemon/src/briefing/prompts.ts` (the builder branch), `apps/daemon/src/daemon/` wiring
- Test: `apps/daemon/src/inbox/inbox.test.ts`, `runner.test.ts`, `briefing/prompts.test.ts`

**Interfaces:**
- Produces: `Runner.approveCheck(id: WorkstreamId): void`, `Runner.sendBack(id: WorkstreamId, note: string): void`.

- [ ] **Step 1: Write the failing tests:** `approve completes with no session started` (DONE, task done, claims released, FakeAdapter session count unchanged); `only Approve completes` (Send Back and an unanswered card don't); `approve raises no review card`; `send back without a note is refused`; `send back records builder evidence and queues a fix` (state `QUEUED`, `nextAction.kind` `fix`, attempt + 1); `the fix prompt carries the builder's note` ("The builder sent the work back: <note>"); `past maxFixAttempts a send back fails the workstream`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §9.4 item 5. Approve goes `WAITING_HUMAN → VERIFYING` and runs verify's completion with no gate and no `review` card.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): approve or send back work that has no gate`.

### Task 22: Optional gate: the diff route and shipping

**Files:**
- Modify: `apps/daemon/src/git/git.ts` (`diffSince(repo, base, maxBytes): Promise<{ diff: string; truncated: boolean; files: { path: string; added: number | null; removed: number | null }[] }>`, with `--no-ext-diff --no-textconv`), `apps/daemon/src/api/app.ts` (`GET /workstreams/:id/changes`), `api/services.ts`, `daemon/services.ts`, `packages/contracts/src/` (`WorkstreamChangesDto`), `apps/daemon/src/delivery/ship.ts`, `delivery/pr-text.ts`
- Test: `apps/daemon/src/git/git.test.ts`, `api/app.test.ts`, `delivery/ship.test.ts`, `pr-text.test.ts`

- [ ] **Step 1: Write the failing tests:** `diffSince returns the diff and numstat`; `caps at 512 KiB and flags truncated`; `ignores a textconv attribute` (a `.gitattributes` textconv driver that would write a file: no file written); route `answers the workstream's changes from its checkout`; `ships a batch without a gate step when the project has none` (no gate run recorded, PR created); `the PR body says "No gate command: each task was approved in 10db."`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** per spec §9.4 items 8–9.
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(daemon): show a task's changes and ship without a gate`.

### Task 23: Optional gate: the desktop

**Files:**
- Create: `apps/desktop/src/views/inbox/check-card.tsx`
- Modify: `apps/desktop/src/views/inbox/inbox-card.tsx` (the `check` arm), `views/settings/project-general-form.tsx` (Gate command clearable), `views/project-setup/project-setup.tsx` (empty gate allowed, sent as null, with the line of spec §4.3), `apps/desktop/src/daemon/queries.ts` (`useWorkstreamChanges`)
- Test: `check-card.test.tsx`, the form tests

- [ ] **Step 1: Write the failing tests:** `the check card shows criteria, commits, files with counts and the diff`; `a truncated diff says so`; `Approve sends approve`; `Send Back needs a note`; `Settings can clear the gate and shows "No automatic check: each finished task waits for you."`; `setup sends gateCommand null when empty and shows "No check found. …"`.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** → PASS.
- [ ] **Step 5: Commit** `feat(desktop): check finished work when a project has no gate`.

### Task 24: Docs

**Files (PR 1):** `apps/desktop/AGENTS.md` (the board: whole-card drag, Space and Enter, the drawer; the first run and `views/project-setup/`; Settings' sidebar and `setting-row.tsx`; e2e seeds its project through the API), `apps/daemon/AGENTS.md` (`folders/`; inspection never pins or raises cards), `docs/architecture/03-trust-boundaries.md` (inspection's reads and the residual: the repository proposes the gate command, the builder accepts it, it runs only under the gate sandbox), `docs/open-items.md` (spec §13's items), a new decision file in `docs/architecture/decisions/` (slug `folder-inspection`; F3, F4).

**Files (PR 2):** `docs/architecture/01-factory-loop.md` (the check wait in the lifecycle), `docs/architecture/02-batch-delivery.md` (ship without a gate), a new decision file in `docs/architecture/decisions/` (slug `optional-gate`; F5, F6, citing the spec's open question 2).

- [ ] **Step 1:** Write each, citing decisions by path.
- [ ] **Step 2: Run** `make gate` → `GATE PASS` (the repo tests check cited decision files exist).
- [ ] **Step 3: Commit** `docs: first run, inspection and the optional gate`.
