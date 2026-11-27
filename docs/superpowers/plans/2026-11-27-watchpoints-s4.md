# Watchpoints S4: what fits this repo, and principles in the guidance

**Size: Feature.** One implementer builds it end to end, then one review that blocks only on bugs. The spec is
`docs/superpowers/specs/2026-11-25-watchpoints-design.md` (§ Scope S4, § A watchpoint `knowledge`, § Surfaces,
§ Provider parity). S3a (#897), Settings (#927) and S3b (#933) are on main.

## Brief

**What changes for you.**
- **Settings › Watchpoints shows what each one covers in this repo.** Every row's Matches column gains a count read
  from the project's checkout ("14 files"), and the drawer lists up to five of them. A watchpoint that covers
  nothing reads "No files here", dimmed.
- **Add Watchpoint says which starters fit.** Starters that cover files in the project are listed first, with
  "Fits · 14 files" and an example path. The rest sit under "Nothing here yet". On All Projects, the count is
  taken across your projects.
- **A watchpoint can link Knowledge topics.** The drawer gains a Knowledge field holding topic keys such as `ui` or
  `auth`. The current principles under those topics join the watchpoint's guidance in the build and review briefs,
  so "What to check" can say "follow our UI principles" without copying them. Design principles links `ui`, and
  Auth and permissions links `auth`.

**What it buys.** You can see at a glance whether a watchpoint is doing anything in a repo, before you rely on it.
Your principles become the checklist without a second copy to keep in step.

**What could go wrong, and how we'd know.**
- *Slow on a big repo.* Counting reads the tracked-file list and, for watchpoints with line patterns, the files'
  contents. It runs off the request path in the existing line worker with its 5 s deadline. It is cached per HEAD
  commit, and a slow count shows "Counting…" and never blocks the page.
- *A topic with many principles bloats the brief.* At most five principles per watchpoint, newest first, and the
  most specific scope wins, as the context pack does.

**Calls you might disagree with.**
- **The assessment uses no model.** The starters are globs and line patterns, so the daemon counts what they cover
  directly. It is fast, free and works the same on every provider. A model look like the hazards assessor's would
  fail on a Codex plan today.
- **Fit is shown in Settings, not raised as an Inbox card.** Nothing reaches the Inbox from S4.
- **Held back with agent proposals: Looks Right saving a decision.** It changes what a card's answer does, which is
  the subject of the card-grammar spec (#953) and the decision-rights spec (#959). It is built once those are ruled
  on, together with agent-proposed watchpoint edits.

**Needed from you:** nothing.

## Provider parity

The same on every provider: the daemon counts files and joins principles itself, with no model call.

## Parts

1. **Coverage count (daemon + contracts).** `GET /projects/:projectId/watchpoints/coverage` returns, per key in the
   project's effective list plus every starter: `{ key, files: number, examples: string[] (≤5), state }`, where
   `state` is `counted | counting | unreadable`. Globs are matched with `matchWatchpoints` over `Git.survey`'s
   tracked files. A watchpoint with `lines` counts only files where a line matches, read through the existing line
   worker under its deadline. A file it can't read in full doesn't count. The result is cached (below). `GET /settings/watchpoints/coverage` sums the per-project results for All Projects. Schemas go in
   `packages/contracts`, beside `watchpoint-hit.ts`.
   **Caching.** Each count is kept in memory by (project, HEAD, the watchpoint's globs and lines), the last three HEADs
   per project, so editing a watchpoint counts only that one again, and concurrent asks for one count share one run. It is
   warmed in the background, debounced, on `ProjectCreated` and `CommitRecorded`, as `hazards/triggers.ts` does for
   hazards (`coverage-triggers.ts`). The route answers `counting` for a count in flight, and a landed count emits
   `watchpoint.coverage_landed` (entity type `watchpoint_coverage`); the desktop refetches the counts on it and polls
   nothing (`staleTime` 60 s).
2. **Settings UI (desktop).** The Matches column count, the drawer's file list, and Add Watchpoint's split into
   Fits / Nothing here yet, sorted by count. Both scopes use one query hook. While loading, the count is a skeleton
   (`PageLoading`; the loading-states PR lands first).
   **Add Watchpoint's menu** says what a click does: the heading "Add a Starter" with "Adds it to <your list | this
   project>, ready to edit", each starter's `why` as a one-line byline beside its fit count, and, once a starter is
   added, an "Added <name>." line with its row highlighted and scrolled into view. **When It Matches** (both scopes)
   shows a tooltip with the same words as the page's info button: Show puts the changes in the task's For You and the
   pull request, nothing waits on you; Ask also leaves one Inbox card per task, for you to look at.
   **Add Watchpoint's menu** says what a click does: the heading "Add a Starter" with "Adds it to <your list | this
   project>, ready to edit", each starter's `why` as a one-line byline beside its fit count, and, once a starter is
   added, a "Added <name>." line with its row highlighted and scrolled into view. **When It Matches** (both scopes) shows
   a tooltip with the same words as the page's info button: Show puts the changes in the task's For You and the pull
   request, nothing waits on you; Ask also leaves one Inbox card per task, for you to look at.
3. **Knowledge topics.** `Watchpoint.knowledge: TopicKey[]` (≤8), defaulting to `[]` when parsing a stored list, so
   no settings migration is needed. Set `ui` on Design principles and `auth` on Auth and permissions as a starter
   revision. Do not change existing copies, following the `STOCK_HAZARD_REVISIONS` rule. `watchpointBuildBrief`
   and `watchpointReviewBrief` take the principles already resolved for the run. The caller fetches current
   principles whose `topicKey` is the key or starts with `key.`, scoped as `scope.ts` does, at most five per
   watchpoint. The drawer gains a Knowledge `TagsInput`.

## Tests (per `.claude/rules/testing.md`)

- One unit test of the coverage rule, a pure function: globs, lines and an unreadable file in; count and examples
  out.
- One unit test of the topic join (key or `key.` prefix, most-specific scope, cap of five), in the same file if it
  fits.
- Extend `apps/desktop/e2e/loop.spec.ts`'s watchpoint-scopes step to assert the Matches count for the watchpoint
  the run's file hits.
- No other tests.

## Order and conflicts

PR #955 changes `watchpoints/card.ts`, `watchpoints/AGENTS.md` and `briefing/prompts.ts`. When it merges, merge
`main` and resolve the conflicts. Write module notes in `apps/daemon/src/watchpoints/AGENTS.md` and
`apps/desktop/src/views/settings/AGENTS.md`, and update the spec's Surfaces line that says no route counts a
glob's files yet.
