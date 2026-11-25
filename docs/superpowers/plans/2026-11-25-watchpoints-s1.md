# Watchpoints S1: show, For You, and the reasons

**Size: Feature.** One implementer builds it end to end, then one code review that blocks only on bugs. Spec:
`docs/superpowers/specs/2026-11-25-watchpoints-design.md`, which is the source for every shape named here.

## Brief

**What changes for you.**
- Settings › Watchpoints lists your watchpoints and this project's, starting from six starters: Migrations, Contracts
  and API, Prompts, Evals, Agent instructions and Dependencies.
- When a task's diff hits a watchpoint, its drawer opens with **For You**: only those hunks, each file with the agent's
  reason and the reviewer's check. Its PR body gets a **For you** section.
- Loudness is **show** only in S1. Ask arrives in S2, and Hold in S5.

**What could go wrong, and how we'd know.**
- *A broken watchpoint row stops a task.* Its detail is read with `safeParse` and degrades to "skipped".
- *Main's files show as this task's.* The base is read again after the gate; the e2e's diff would show it.
- *Agents ignore `watchpointNotes`.* The folds then show hunks with no Agent line, and nothing else breaks.

**Needed from you:** nothing beyond the spec's brief.

## Parts, in build order

1. **Contracts** (`packages/contracts/src/watchpoints.ts`, exported from the entry point):
   - `WatchpointLoudness`, `Watchpoint`, `ProjectWatchpointEntry` (a `Watchpoint` or `{ key, off: true }`), and `STARTER_WATCHPOINTS`.
     Migrations and Dependencies reuse the stock hazards' globs, imported rather than copied.
   - `effectiveWatchpoints()`, `WatchpointNote`, `WatchpointDetail`, the `WatchpointHitsDto` route shape, and `EvidenceKind.Watchpoint`.
   - `detail` moves out of `EvidenceBase` into each `EvidenceDto` branch.
   - `watchpointNotes` is optional on the `commit` and `complete_step` inputs and on `StepResult`. The commit tool's
     output echoes it.
2. **Storage** (`packages/db`):
   - `insertEvidence` stores `detail` for Watchpoint as it does for Acceptance.
   - The Watchpoint branch's `detail` schema is `WatchpointDetail.catch(...)`, so a bad row reads as
     `skipped: 'unreadable'` and never makes `parseRow` throw.
   - The watchpoint settings accessors use the keys `watchpoints.you` and `watchpoints.<projectId>`, read through zod.
   - Project removal deletes the project's key.
   - No migration.
3. **Daemon matching** (`apps/daemon/src/watchpoints/`, with an `AGENTS.md` note):
   - `split-patch.ts`: unified diff → per-file `{ path, status, patch, clipped }`.
   - `match.ts`: the pure `matchWatchpoints(files, watchpoints)`, using `areaMatches`.
   - `hits-after.ts`: `watchpointHitsAfter(...)`. It re-reads `baseHead`, takes `diffOfRanges` at the watchpoint caps,
     matches on numstat `files`, and gathers agent notes from the commit tool ops. Its sources are a
     `WatchpointHitSource[]` with one entry, the Evals hook.
4. **Runner wiring** (`runner.ts`):
   - Call `watchpointHitsAfter` in `verify` beside `acceptanceAfter`, and in `finishWithoutGate`.
   - Insert the row in the write that moves the run on, not on acceptance send-back.
   - The commit handler and the `complete_step` handler (`mcp/tools.ts`) store `watchpointNotes`.
5. **Briefs** (`briefing/prompts.ts`):
   - The build brief gets the overlapping watchpoints, or all of them when the task has no areas, plus the
     `watchpointNotes` instruction.
   - The Review and QA brief gets a Watchpoint section from the newest row, on its first round, as acceptance does.
6. **PR body** (`delivery/pr-text.ts`, `ship.ts`):
   - `prBody` takes an optional `watchpoint` input and renders "For you".
   - `ship.ts` builds that input from the PR's tasks' newest rows. It wraps the section in
     `<!-- 10db:for-you -->` markers, and when a later task joins the PR it replaces only the text between them,
     through `prEditBody`.
7. **Routes** (`api/app.ts`, `daemon/services.ts`):
   - `GET`/`PUT /settings/watchpoints`.
   - `GET`/`PUT /projects/:id/watchpoints`; the `GET` returns the effective list with `from` tags.
   - `GET /workstreams/:id/watchpoint-hits`, which returns the newest row's detail with notes joined: agent notes from
     the commit ops, reviewer notes from the steps.
   - A glob-count endpoint, only if the hazard drawer's counter can't be reused.
8. **Desktop**:
   - Settings: `SettingsSectionKey.Watchpoints` under Planning after Areas and Hazards, with `watchpoints-section.tsx`
     (a DataTable in two groups, with a segmented loudness control where Ask and Hold are disabled) and
     `watchpoint-drawer.tsx`, both modelled on the hazard section and drawer.
   - `views/board/task-for-you.tsx`: the first item in the Overview. It fetches the hits itself, as `TaskSkips`
     does, and refetches on `evidence.recorded`. It holds the folds, `HunkDiff` over `parseChanges(patch)`, the
     notes, and "Open the whole diff".
   - Match mock-ups 1, 1b and 2 for layout and content only. Their CSS is a sketch.
   - The built screens use the app's own design system (`apps/desktop/DESIGN.md`, `src/theme.ts`): Mantine
     components and theme tokens only, and no hand-written colours.
   - Component choices:
     - the table is `mantine-datatable`, as in `hazards-section.tsx`;
     - the watchpoint drawer is `SurfaceDrawer`, never Mantine's `Drawer`;
     - loudness is `SegmentedControl`;
     - the folds are `Accordion`;
     - the hunks are the existing `HunkDiff`.
   - Check every screen in dark and light. A cheap layout choice is the implementer's call.
9. **Docs:**
   - `docs/architecture/db-storage.md` notes the new setting keys and the evidence kind.
   - An `AGENTS.md` sits beside `watchpoints/`.
   - The For You section is named in the drawer's `AGENTS.md`, if it has one.

## Tests (only these)

- **One pure rule-table test**, `apps/daemon/src/watchpoints/match.test.ts`, covering `matchWatchpoints` plus
  `effectiveWatchpoints`:
  - a dot-path glob (`.claude/**`);
  - an override replacing a starter;
  - an `off` entry;
  - one file under two watchpoints;
  - a clipped file.
  - Prove it red first.
- **Extend `apps/desktop/e2e/loop.spec.ts` test 1:**
  - Seed a project watchpoint covering the file the fake agent writes.
  - Have the fake agent's commit carry a `watchpointNotes` entry.
  - Assert that the drawer's For You shows the watchpoint, the hunk and the Agent note.
- **Extend one case in `pr-text.test.ts`** with a `watchpoint` input.
- No other new tests. The commit adding the rule-table test carries the value card.

## Done

- Typecheck, lint and the related tests pass.
- The e2e passes against the real daemon.
- Screenshots of Settings › Watchpoints and For You in the running app go to the builder before review.
- One `code-reviewer` round, then a PR with auto-merge, watched until it merges.
