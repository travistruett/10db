# One page header, one count, and the Workbench start page

## Brief

**What changes for you**
- Inbox, Factory, Knowledge, Board and the Workbench start page share one header: the title with the view's
  actions on the same row, an optional one-line dimmed byline under it, and an optional row for tabs (left) and
  filters (right). Inbox's tabs move under its title; Knowledge's New Principle moves up to the title row.
- A count is a small muted pill the height of the text, in the sidebar, on tabs and in buttons. It is blue only
  when it means something needs you (Inbox, the Sessions and Workbench needs-you counts).
- The Workbench start page lists the project's pages as rows you tick, with the open UI tasks under them. Start
  Pass sits at the list's foot with what is ticked ("2 pages · Start Pass") and why it can't start, if it
  can't. Set Up becomes Workbench Settings on the title row. "What's bothering you?" is gone. Found pages are
  one quiet line at the list's foot until the next PR adds them on their own.

**What could go wrong and how we'd know**
- A view's header loses a control in the move: each view's tests find its controls by role, and the e2e specs
  for Inbox, Factory, Knowledge, Board and the Workbench drive them in WebKit.
- The ticked list lets two rows that share files both be ticked: `blockedReason` stays the one rule, and its
  table plus a list render test cover it.

**Calls you might disagree with**
- Sessions, Plan and an open Workbench pass keep their compact headers: there the content is the work. Board
  takes the page header, with its goal on the toolbar row.
- The Add Page dialog inside an open pass keeps its search picker; only the start page becomes a list.

- A page that loads shows its header at once and, after 300 ms, quiet placeholder rows in the shape of what
  is coming, instead of a lone spinner under the title. The Workbench start page should also open faster.

**Needed from you:** nothing. Adding found pages on their own is the next PR (it rebuilds page areas, which
decide what an agent may write, so it gets a decision record first).

## Context for agents

Worktree `../10db-worktrees/page-headers`, branch `feat/page-headers` from main 7bfbb09b. Builder decisions
behind this plan: `~/Agents/notes/10db/page-headers-and-workbench-start.md`. Design pass report:
`~/.gstack/projects/10db/designs/design-audit-20261115/design-audit-localhost.md`. Rules: root `AGENTS.md`,
`.claude/rules/code-style.md`, `.claude/rules/testing.md`, `apps/desktop/AGENTS.md`, `DESIGN.md`.

Provider parity: UI only; every account sees the same header, count and list.

## Task 1: the count

- `apps/desktop/src/shell/count-badge.tsx`: `CountBadge` gains `tone?: 'neutral' | 'attention'` (default
  neutral). Neutral: `Badge` `variant="light"` `color="gray"`, size `xs`, weight 600, height the label's
  line (no circle taller than the text). Attention: the same shape, `variant="filled"` primary.
- `shell/app-layout.tsx` has its own sidebar `CountBadge` (with a `VisuallyHidden` phrase): make it use the
  shell's `CountBadge` with `tone="attention"`, keeping the phrase. Inbox, Sessions and Workbench counts in
  the sidebar are attention.
- Callers: Inbox's Open tab is attention, Waiting neutral; `views/settings/accounts/accounts-section.tsx`,
  `views/shape/proposed-list.tsx`, `views/sessions/all-tabs-menu.tsx`, `views/workbench/setup/areas-section.tsx`:
  pick the tone by "does this need the builder".
- `DESIGN.md` Counts: add the tone rule and the size rule.
- Test: one render test in a new `shell/count-badge.test.tsx` with a row per tone (rung 3; a label component
  gets one render test).

## Task 2: the page header

- New `apps/desktop/src/shell/page-header.tsx`: `PageHeader({ title, description?, actions?, toolbar?,
  titleAside? })`. Row 1: `Title order={2}` and `titleAside` (Factory's sync note) left, `actions` right,
  `align="center"`. Row 2: `description` as `Text size="sm" c="dimmed"`, one line. Row 3: `toolbar`, a
  `Group justify="space-between"` the view fills (tabs left, filters right). Rows that are absent take no
  space.
- Apply to `views/inbox/inbox-view.tsx` (title; toolbar = the SegmentedControl left, project filter and ?
  right), `views/factory/factory-view.tsx` (title + `BenchmarkSyncNote` as titleAside; its notes stay under
  the header; description "Goals 10db is pursuing, by project"; actions = `ProjectFilter`),
  `views/knowledge/knowledge-view.tsx` (description as today, one line; New Principle moves to actions:
  it lives inside `ProjectKnowledge` today, so lift it or pass it up), `views/board/board-view.tsx` (title;
  toolbar = Goal select and GoalLine left, the rest right), and the Workbench start page (Task 3).
- `DESIGN.md`: a "Page header" rule naming the component, the three rows, which views use it and that
  workspaces (Board's columns aside, Sessions, Plan, an open pass) keep their compact headers.
- `apps/desktop/src/shell/AGENTS.md` (or the nearest AGENTS.md): one line for `PageHeader`.
- Tests: one render test for `PageHeader` (rows present and absent). The views' existing tests must still
  find every control; fix production code, not those tests, unless a test asserted the old layout itself.

## Task 3: the Workbench start page

- `views/workbench/start-pass.tsx` loses the Textarea and the new-pages line; `openRequest` in
  `start-pass-rules.ts` loses its `bothering` argument (the request sends no first message; check
  `PassOpenRequest` in `packages/contracts` keeps it optional, else send none).
- New `views/workbench/page-list.tsx`: the pages as rows (Checkbox, label, route in monospace dimmed, last
  change, "Waits for <task>" when held), then an "Open UI tasks" subhead and the joinable tasks as rows. A
  row whose `blockedReason` is not null is disabled with the reason under it. Same `PickTicks` state as the
  picker. Keep `page-picker.tsx` for `add-page-modal.tsx`.
- Footer of the list: `StartLines` and the refusal left; right the primary Button "Start Pass" with the
  ticked count in words before it ("2 pages · 1 task"), disabled with the reason in `StartLines` when it
  can't start. Below the rows, when the setup found pages: one dimmed line "Sessions /sessions found in
  code · Review" where Review opens the setup (`setUp.onOpen`).
- `workbench-view.tsx`: the start page uses `PageHeader` (title UI Workbench, description "Work through pages
  with the agents, live.", actions = `Button variant="default"` "Workbench Settings" with the setup count as
  a neutral `CountBadge` when above 0, opening the setup).
- `DESIGN.md` "Picking several from a list that can grow": a bounded list the builder reads whole (a
  project's pages) is tickable rows; the searchable MultiSelect stays for lists that grow without bound.
- `views/workbench/AGENTS.md`: update the start page's description.
- Tests: `start-pass.test.tsx` and `start-pass-rules.test.ts` rows for the list (a blocked row disabled with
  its reason; ticking a page and a task; the footer's words); `e2e/workbench.spec.ts` drives the start page by
  role and must follow the new controls (Start Pass, checkboxes by page name). Red first for each new row.

## Task 4: one loading state for a page

- New `apps/desktop/src/shell/page-loading.tsx`: `PageLoading({ shape: 'list' | 'cards', rows?, label })`.
  It renders nothing for its first 300 ms (a fast load never flashes), then Mantine `Skeleton` rows in the
  shape of the page's content (list: a checkbox-and-two-lines row; cards: a card outline), static, no shimmer
  under `prefers-reduced-motion`, with `role="status"` and `aria-label={label}` ("Loading the pages").
  Generalise Sessions' `LoadingLines` in `views/sessions/chat-tab.tsx` (same 300 ms rule) into it.
- The `PageHeader` renders while the page loads: the title and description are known before the data.
- Use it in the Workbench (`workbench-view.tsx:130` today is a lone `Loader`), and wherever a top-level view
  shows a bare `Loader` as its whole content (grep `views/*/` for `<Loader`).
- `DESIGN.md`: a "Loading" rule: header first, placeholder rows after 300 ms, never a lone spinner for a page.
- Test: one render test with an injected clock (nothing before 300 ms, rows after).

## Task 5: why the Workbench start takes 3-4 s

- The start page waits on `GET /passes?live=true` and `GET /projects/:id/pass-start`
  (`apps/daemon/src/pass/start-preview.ts`), which asks git per page for its last commit (`Git.lastChangedAt`),
  the folder's changed files and the holder. Measure each read on the real project first (time the routes
  with the dev daemon, `pnpm dev`), name the slow step in the PR, then cut it, for example one
  `git log --name-only` walk for every page's last change instead of one call per page.
- Keep the answer identical: `start-preview` tests assert the DTO; add a row only if the batched read can
  differ (a page with no commits).
- If the slow read is the setup proposal (`POST /projects/:id/workbench-setup`), it no longer blocks the
  start page in Task 3's design: the found-pages line appears when it arrives.

## Order and checks

Tasks 1-5 in order, one commit each (Conventional Commits, scope `desktop`, value card per new
behaviour). After each: `pnpm exec vitest related <files>`, typecheck, lint. Before the PR: the Inbox,
Factory, Knowledge, Board and Workbench e2e specs in WebKit (Settings needs a spec that adds a project before
it), screenshots at 1280 in dark and light, then `make check-changed`. Code review by `code-reviewer`
(round 1 lists all; at most two fix rounds).
