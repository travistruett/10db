# Models page polish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief

**What changes for the builder:** the nav says **Models** under an **AI** subhead; role names are Title Case
everywhere ("Plan Review"); "Used by" is plain text; the refresh button matches the Account select's height; the
page's tables and chart sit on a raised surface; the model list nests older versions under each family's current
model and pages 25 families at a time.

**What could go wrong, and how we'd know:** a filter that hides a family's current model must still show its older
ones (a pure table row); the page number outliving a filter (render test resets to page 1); the expand toggle
opening the drawer (render test); a stale "Models and scores" left in tests, e2e or `AGENTS.md` (grep in Task 1).

**Needed from the builder:** nothing.

**Goal:** PR 1 of the right-sized work design: the Models page polish that needs no playbook.

**Architecture:** labels and copy in `sections.ts`, `role-labels.ts` and two other role-label maps; one theme token
for the raised surface; a pure `groupByFamily` beside `model-order.ts`, rendered with mantine-datatable's row
expansion and the pager Knowledge already uses.

**Tech Stack:** React, Mantine 9, mantine-datatable 9.4.0, Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-13-10db-right-sized-work-design.md` §2, §10.1 (on `docs/right-sized-work`).

## Global Constraints

- Copy rules from `apps/desktop/AGENTS.md`; no copy names a model.
- No `as` casts, no `!`, `as const` objects for constants (`.claude/rules/code-style.md`).
- "Who each role gets" gets only the label and colour fixes; PR 2 replaces it.
- The raised surface applies to this page only.

## Review Focus

1. A filter that removes a family's current model keeps its older versions, the first of them as the lead row.
2. Changing the filter, sort or account while on page 2 returns to page 1.
3. Clicking the expand control does not open the drawer; clicking a row, lead or older, does.
4. A model with no family is its own one-row group, never merged with other no-family models.
5. "Used by" still shows on an older version a role picks.

---

### Task 1: Names, labels and the header

**Files:**

- Modify: `apps/desktop/src/views/settings/sections.ts:76-86` (subhead `'Models'` → `'AI'` on Accounts, Models,
  Decisions, Models by role; label `'Models and scores'` → `'Models'`)
- Modify: `apps/desktop/src/views/settings/models-section.tsx:89` (title `Models`), `:120-123` (refresh
  `ActionIcon` `size="input-xs"`, to match the `xs` Select)
- Modify: `apps/desktop/src/views/settings/role-labels.ts:12`, `views/board/flow-select.tsx:7`,
  `views/factory/task-rows.ts:21` (`'Plan review'` → `'Plan Review'`)
- Modify: `apps/desktop/src/views/settings/models-table.tsx:160-174` (Used by: `Text size="xs"` with no `c`)
- Modify tests: `sections.test.ts:27`, `settings-nav.test.tsx:19`, `settings-view.test.tsx:52-59`,
  `rightsizing-series.test.ts:109`, `apps/desktop/e2e/settings.spec.ts:20` (subheads `['AI', 'Agents', …]`)
- Modify: `apps/desktop/AGENTS.md:106` (page name, Used by no longer violet, refresh size)

- [ ] **Step 1:** Change the test expectations first: `['app', 'AI', 'models', 'Models']` in `sections.test.ts`,
      `'Models'` in the nav and view tests, `'Plan Review, Review 48'` in `rightsizing-series.test.ts`, and in
      `models-section.test.tsx` add `it('shows Used by as plain text')`: the Used by cell's computed colour equals
      the body text colour, not violet.
- [ ] **Step 2:** Run `pnpm --filter @10db/desktop exec vitest run src/views/settings` and see those fail on the old
      labels.
- [ ] **Step 3:** Make the source changes listed above.
- [ ] **Step 4:** Run the same command: PASS. Then `git grep -n "Models and scores\|Plan review" -- apps e2e` prints
      nothing outside `docs/`.
- [ ] **Step 5:** Commit: `fix(desktop): the models page is named Models under AI, and role names are Title Case`.

### Task 2: Raised surface

**Files:**

- Modify: `apps/desktop/src/theme.ts:154-165` (add `'--tendb-color-panel': variant.bg1` for both schemes, next to
  the Board's variables, with a one-line comment: the raised tone for a page's tables and charts)
- Modify: `apps/desktop/src/theme.test.tsx` (the token resolves to each variant's `bg1`)
- Create: `apps/desktop/src/views/settings/raised-panel.tsx`:
  `RaisedPanel({ children }: { readonly children: ReactNode })`, a bordered `Paper` with radius `md`, padding
  `sm` and `bg="var(--tendb-color-panel)"`
- Modify: `models-section.tsx` (chart inside `RaisedPanel`), `models-table.tsx` and `role-picks-panel.tsx`
  (`DataTable` `backgroundColor="var(--tendb-color-panel)"`)

- [ ] **Step 1:** Add the theme test row; run `pnpm --filter @10db/desktop exec vitest run src/theme.test.tsx`: FAIL.
- [ ] **Step 2:** Add the token, the component and the three uses.
- [ ] **Step 3:** Run it again: PASS.
- [ ] **Step 4:** Commit: `fix(desktop): the models page's tables and chart sit on a raised surface`.

### Task 3: Families and pages

**Files:**

- Create: `apps/desktop/src/views/settings/model-families.ts`, `model-families.test.ts`
- Create: `apps/desktop/src/shell/table-pager.ts` (move the pager props out of `views/knowledge/knowledge-table.tsx`
  so both tables share them; Knowledge keeps its behaviour)
- Modify: `models-table.tsx`, `models-section.tsx`, `models-section.test.tsx`, `apps/desktop/AGENTS.md:106`

**Interfaces:**

- Produces: `interface ModelFamily { readonly key: string; readonly lead: ModelRowDto; readonly older: readonly ModelRowDto[] }`
  and `groupByFamily(sorted: readonly ModelRowDto[]): ModelFamily[]`. Families are keyed `${maker}/${family}`, or
  the model ID when either is null. Every Current model leads an entry (two current models of one family are two
  rows); a family's other versions go under its first Current model, or with none under its first row. Entries
  keep their lead's place in the sort; `key` is the lead's model ID. Page size is Knowledge's (25).

- [ ] **Step 1:** Write `model-families.test.ts` as a named table: one family of three sorted by Intelligence →
      one group, lead the Current one; two families interleaved → order of first appearance; a Superseded row
      sorting above its Current sibling → the Current one still leads; the lead filtered out → the first older
      row leads; two no-family models → two groups.
- [ ] **Step 2:** Run `pnpm --filter @10db/desktop exec vitest run src/views/settings/model-families.test.ts`: FAIL
      (module missing).
- [ ] **Step 3:** Implement `groupByFamily`.
- [ ] **Step 4:** Run it: PASS.
- [ ] **Step 5:** In `models-section.test.tsx`, add render tests: 30 single-model families show 25 rows and
      "1–25 of 30"; Next shows 5; changing the Model filter returns to page 1; a family with older versions shows
      "2 older" on its lead row, and clicking it reveals them without opening the drawer; clicking an older row
      opens the drawer on that model; an older row a role picks shows that role under Used by.
- [ ] **Step 6:** Run them: FAIL.
- [ ] **Step 7:** Render families in `ModelsTable`: records are the page's `ModelFamily` leads (`idAccessor` the
      key); the Model cell shows an expand control ("N older", its own button that stops propagation) when
      `older` is non-empty; `rowExpansion` renders the older rows in a nested `DataTable` with `noHeader` and the
      same columns. Paging is client-side: `page` state in `ModelsSection`, reset to 1 when filter, sort or
      account changes, and the shared pager props.
- [ ] **Step 8:** Run `pnpm --filter @10db/desktop exec vitest run src/views/settings src/views/knowledge`: PASS.
- [ ] **Step 9:** Commit: `feat(desktop): the models list nests each family's older versions and pages 25 at a time`.

### Task 4: Check it runs

- [ ] **Step 1:** `pnpm --filter @10db/desktop typecheck && pnpm --filter @10db/desktop lint`: no errors.
- [ ] **Step 2:** Click through Settings › Models in the dev UI with invented data, dark and light, at 1440 and
      900 px: nav, header heights, raised surfaces, expand, paging, drawer. Screenshots to the session scratchpad.
- [ ] **Step 3:** `make gate`: `GATE PASS`.
