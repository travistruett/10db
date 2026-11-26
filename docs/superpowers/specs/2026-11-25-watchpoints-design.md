# Watchpoints: the changes you want to judge yourself

**Size:** S1 to S4 are Feature: settings, a pure matcher, a drawer section, an Inbox card, and brief and PR text.
S5, the merge hold, is Core because it changes when a pull request merges. It gets an index with cards and plan
review, and it doesn't start until you say go.

Mock-ups: `2026-11-25-watchpoints-mockups.html`. Research: the hand-off's notes,
`judgment-areas-research.md`.

## Brief

**What changes for you.**
- You keep a list of **watchpoints**, the kinds of change you want to judge yourself: migrations, contracts, prompts,
  evals, agent instructions, dependencies, or your own. Each one has paths, a line on why it matters, and guidance
  on what to check. You start from a library.
- Watchpoints live in **10db's settings** (your call). Yours apply in every project, and a project adds its own or
  overrides one of yours. Agents only propose edits.
- Each watchpoint has a loudness:
  - **Show:** the task's **For You** section and the PR body.
  - **Ask:** one Inbox card per task, however many watchpoints it hits.
  - **Hold:** the PR opens without auto-merge. The run still finishes.
- For You is the first section of the task drawer. It has one fold per watchpoint and holds only the matching hunks.
  Each file shows the agent's reason and the reviewer's check against your guidance. The hunks are kept, so a Done
  task still shows them.

**What it buys.** Code review of the few changes you care about, one click from the task. The reviewer checks
them against what you said matters, and nothing else.

**What could go wrong, and how we'd know.**
- *Noise.* A broad glob fires on every task, and you stop reading. Settings shows each watchpoint's hits over the last
  30 days. An ask watchpoint you wave through goes yellow: at least 5 cards, at least 80% "Looks right" with no note,
  the measure 10db already uses.
- *Misses.* A model id in ordinary code matches no glob. Line patterns (the Model choice starter) and a judge question cover that.
- *A wrong reason.* The agent's note is its own account of what it did. The reviewer's check is the independent
  read, and the hunks sit right under both.
- *An agent weakens a watchpoint.* It can't: agents propose, you accept.

**Calls you might disagree with.** You approved all of them, and the mock-ups, on 2026-11-25.
1. **The name (your call).** "Watchpoint", the debugger term for "stop when this changes" (gdb, lldb, Xcode). Show,
   ask and hold map to log, notify and break. The drawer section is **For You**, and the Inbox card is **Look at
   these changes**. "Focus" was dropped because it clashes with macOS Focus modes.
2. **Starter defaults.** Migrations and Contracts are **ask**, the rest are **show**, and none are **hold**. The
   Inbox stays quiet, and changes that can't be undone still reach you.
3. **Hold.** It is offered per watchpoint, off by default, and built last (S5). It is the only real block. Until S5 the
   control shows it greyed out with "coming later".
4. **Notes come early.** The agent's reason per file (given when it commits) and the reviewer's check per file
   ship in S1, not S3 as the research had it. Without them For You is just a filtered diff, and you said the
   reasons are the point. A Light task has no review, so its folds show only the agent's reason until S2's ask
   forces a review.
5. **S1 adds no migration.** Watchpoints are stored as app settings, and hits as evidence rows (§ Storage). That
   matters because only one open PR may add a migration at a time, and two other sessions are adding them now.

**What I need from you.** Nothing. The built screens use the app's own Mantine theme and components, and come to
you as screenshots of the running app.

---

## Scope

| Slice | Size | Adds |
| ----- | ---- | ---- |
| S1 | Feature | Watchpoints with globs, `why` and `guidance`; the glob starters; Settings › Watchpoints; matching after the gate; hits kept as evidence; `watchpointNotes` from the build and review steps; the reviewer's Watchpoint section; For You; the PR body's For you section. Loudness **show** only (Ask is disabled with "next"). |
| S2 | Feature | **Ask**: the one-per-task Look card, Looks right and Send back. An ask hit forces a review on a Light task. A show hit posts an Activity notice. Per-watchpoint hit counts and the noisy flag. |
| S3a | Feature | `match.lines` (regexes over changed lines), and the Indexes and Model choice starters. Built. |
| S3b | Feature | `match.question`, a new `JudgeDecision` that is off and replayed in Shadow first; the Design principles and Auth starters. |
| S4 | Feature | Assessing the starters against the repo, with evidence and a covered-file count, as hazards are. Agent proposals for watchpoint edits. Knowledge links (principle topics join the guidance) and "Looks right" saving a decision. |
| S5 | Core | **Hold**: auto-merge off for a held run, Merge on the card, a goal's shared PR, recovery. Built only on your go. |

Out: per-watchpoint detector commands (Squawk and `buf breaking` belong in the gate, where a failure already sends the
run back), and watchpoints on the Critical plan-approval card.

## A watchpoint

`packages/contracts/src/watchpoints.ts`:

| Field | S1 | Meaning |
| ----- | -- | ------- |
| `key` | ✓ | A `Name`, unique within its list. A project watchpoint with a key from your list overrides that one. |
| `label`, `why` | ✓ | "Migrations", "A revert can't undo a migration that ran." |
| `globs` | ✓ | `PathPattern[]`, matched the way areas are (`areaMatches`, so dot-paths match). |
| `guidance` | ✓ | What you want checked. It goes into the build brief and the review brief. |
| `loudness` | ✓ | `WatchpointLoudness = { Show, Ask, Hold } as const`. S1 accepts only `show` from the UI. The type has all three, so stored settings never need migrating. |
| `lines` | S3a | Optional regexes over the added and removed lines of matching files. |
| `question` | S3b | Optional. A yes/no the judge asks of hunks the rules didn't settle. |
| `knowledge` | S4 | Optional principle topic keys. Their current text joins `guidance`. |
| `starter` | ✓ | The library key it came from, if any. It tells a starter's later revision which watchpoints to touch. |

A project's list holds `Watchpoint | { key; off: true }`. The second shape names one of your keys and turns it off in
that project; it has no other fields.

**Resolving a project's watchpoints** is a pure function: `effectiveWatchpoints(yours, project)`. It returns your list with
the project's entries replacing yours by key, then the project's new keys. Each entry is tagged
`from: 'you' | 'project' | 'override'` for Settings. An `off` entry drops that watchpoint. The function lives in
`@10db/contracts`, because Settings and the daemon both need it. `matchWatchpoints` lives in the daemon
(`apps/daemon/src/watchpoints/`), because it uses `areaMatches` from `guard/paths.ts`, and packages never import apps.

## The library

`STARTER_WATCHPOINTS` lives in `@10db/contracts` and is revised the way `STOCK_HAZARD_REVISIONS` is: a new starter
arrives as a proposal, never by silently editing your list.

| Starter | Globs | Default | Slice |
| ------- | ----- | ------- | ----- |
| Migrations | the stock `migrations` hazard's globs | ask (show in S1) | S1 |
| Contracts and API | `**/contracts/**`, `**/*.proto`, `**/openapi*.{yaml,json}`, `**/schema.graphql` | ask (show in S1) | S1 |
| Prompts | `**/prompts/**`, `**/*prompt*.*` | show | S1 |
| Evals | `**/evals/**`, `**/*.eval.*` | show | S1 |
| Agent instructions | `**/AGENTS.md`, `**/CLAUDE.md`, `.claude/**`, `.codex/**` | show | S1 |
| Dependencies | the stock deps hazard's globs | show | S1 |
| Indexes | migration globs, plus index DDL lines | show | S3a |
| Model choice | model-id lines in any file | show | S3a |
| Design principles | UI globs, plus a question linked to the `ui` principles | show | S3b |
| Auth and permissions | a question | show | S3b |

On a new install, your list starts as the S1 starters. "Add from library" in Settings offers any starter not in the
list. S2 turns Migrations and Contracts to ask, but only on watchpoints still at the starter's settings; one you've
edited stays as you left it.

## Storage

- **Your watchpoints:** app setting `watchpoints.you`. **A project's:** `watchpoints.<projectId>`, following the
  `trusted_writes.<projectId>` precedent. Both are zod-parsed when read, since they are a boundary.
- Routes: `GET`/`PUT /settings/watchpoints` (beside `/settings/keep-awake`), and `GET`/`PUT /projects/:id/watchpoints`. The `GET` for a project returns the
  effective list with `from` tags. Each `PUT` replaces the whole list, as the hazard patch does.
- **Hits:** one `evidence` row per matching pass, of a new `EvidenceKind.Watchpoint`, with `detail: WatchpointDetail`. The
  newest watchpoint row on a workstream is the current one. Evidence outlives the worktree, which is why a Done task
  still shows its hunks: `workstreamChanges` refuses a finished batch's diff.
- **Typing `detail` per kind.** The column is JSON text, so SQLite needs no change, but the TypeScript does:
  - `detail` leaves the shared `EvidenceBase` (`entities.ts`). Each branch of `EvidenceDto` and `NewEvidence`
    gets its own: Acceptance's is `AcceptanceDetail`, Watchpoint's is `WatchpointDetail`, and every other kind's is `null`.
    The existing `e.detail?.sentBack` and `detail?.criteria` readers then narrow by kind as they do today.
  - `insertEvidence` stores `detail` for both kinds, instead of only for Acceptance.
  - **A watchpoint row can never break `listEvidence`.** The Watchpoint branch's `detail` schema carries its own fallback
    (`WatchpointDetail.catch(...)`), because `parseRow` parses the whole row at once. A detail that doesn't parse reads
    as `{ hits: [], head: '', skipped: 'unreadable' }` instead of throwing, because a throw there would stop the
    gate count, fix evidence and every `commit` call for the workstream. `WatchpointDetail` also only changes in
    backward-compatible ways.
  - Every evidence reader filters by kind already, so a watchpoint row changes no count. `goal-pages.ts` collects
    `commitShas` from every row, which is harmless.
  - The cost is that `listEvidence` parses up to 128 KB more per gate pass, on each `commit` call. If that shows up
    in timing, the hunks move to their own column.

`WatchpointDetail`:
```ts
{
  hits: Array<{
    watchpoint: { key; label; why; guidance; loudness };  // a snapshot, so a later edit doesn't rewrite history
    files: Array<{ path; status: 'M' | 'A' | 'D' | 'R'; added; removed; patch: string; clipped: boolean }>;
  }>;
  head: string;            // the commit matched
  skipped: string | null;  // set when the diff couldn't be read in full
}
```
`patch` holds that file's hunks as unified diff text, capped at 24 KB per file and 128 KB per row. A clipped file
says so, and "Open the whole diff" covers the rest while the worktree exists.

Archiving a project keeps its `watchpoints.<projectId>` key, so a restore finds the list again; there is no project deletion.

Cost if this is wrong: moving watchpoints into a `projects` column later is one small migration plus a copy, both
internal.

## When it runs

1. **Before work.** The build brief lists the watchpoints whose globs overlap the task's areas (`globsOverlap`), with
   their `why` and `guidance`. A task with no areas gets all of them, since there are few. The brief also says: "If
   you change a file a watchpoint covers, give your reason in that commit's `watchpointNotes`."
2. **After a passing gate.** This is `watchpointHitsAfter(row, checkout)` in `verify` (`runner.ts`), beside
   `reviewForcedAfter`, `testValueFollowUpsAfter` and `acceptanceAfter`, and in `finishWithoutGate`.
   - **It reads `baseHead` again after the gate.** The gate's base merge moves it, and a diff from the old base
     would count main's own migrations and contracts as this task's. That is how `coverageOf` reads it.
     `reviewForcedAfter` and `acceptanceAfter` have the same latent issue, which is a follow-up task, not this work.
   - **It matches on the complete file list**, the numstat `files` from `diffOfRanges`. It doesn't match on files
     parsed from the capped patch, which would miss watchpoint files past the cap. Each matched file's status and hunks
     come from its own section of the patch, read at the watchpoint cap. A file whose section is cut off is kept with
     `clipped: true`.
   - The daemon splits the patch per file with its own small parser, because `parseChanges` is desktop code.
   - It calls the pure `matchWatchpoints(files, watchpoints): WatchpointHit[]`.
   - The result is written as a `watchpoint` evidence row **inside the write that moves the run on**: to the next step
     or to Done. When acceptance sends the run back, no row is written, and the fix's gate pass writes one. When
     nothing hits, nothing is written.
   - A later gate pass after a fix writes a newer row. The ship that follows uses that newest row, which is the
     final diff, so nothing is matched again at ship.
   - A diff that can't be read writes a row with `skipped` set. For You then says "Couldn't read this run's
     changes", and the run goes on.
3. **Review.** The review brief gets a **Watchpoint** section built from the newest row: each watchpoint's guidance, its
   files, and the agent's notes. A **Review** or **QA** step's reviewer is told to send one `watchpointNotes` entry per
   watchpoint file it checked in `complete_step`, prefixed ✓ or ⚠. Plan review doesn't, because there is no diff yet. A
   ⚠ can also be a blocking finding, as today.
4. **Ship.** `prBody` gets an optional `watchpoint` input, built in `ship.ts` from the PR's tasks' newest watchpoint rows. It
   renders a "For you" section after "What and why": each watchpoint, its loudness, its files with the agent's note, and
   the reviewer's check as a quote.
   - A repo PR template that lacks the section gets it at the end, which is how `fillTemplate` treats any missing
     section.
   - The body is written in `createPr`, with the section between `<!-- 10db:for-you -->` and
     `<!-- /10db:for-you -->` markers. When a later task ships into the same PR (a goal's shared PR), only the text
     between the markers is replaced, through `prEditBody`. A body whose markers someone removed is left alone.
   - Workbench pass PRs are out of S1, because a pass page gates at close and may never reach this write.
5. **Hook for Evals.** `watchpointHitsAfter` takes a list of `WatchpointHitSource`s; S1 has one, the glob matcher. The
   Evals session's `eval.definition_changed` becomes a second source. It turns the event's classification ("bar
   lowered", "golden changed") into a hit on the Evals watchpoint, with that classification as the reason. Nothing for it
   is built here.

### `watchpointNotes`

`WatchpointNote = { path: string; note: string }`, at most 40 per call, each note at most 400 characters. The same shape
rides on two tools:
- **Agent:** the `commit` tool gains an optional `watchpointNotes`. An implement step never calls `complete_step`; it
  ends its turn, and 10db runs the gate. The commit handler copies the notes into its tool-op result, and
  `watchpointHitsAfter` reads them from the run's commit ops, as `committedByRun` reads shas. The newest commit wins per
  path.
- **Reviewer:** `complete_step` gains the same optional field, kept on the step's `StepResult` (the
  `workstreams.steps` JSON, no migration). The newest Review or QA step wins per path.
- A note for a path no hit covers is kept, but not shown.

Claude Code and Codex lanes connect to the same 10db MCP server (`codex-lane-config.ts`), so both tools have the
field on every provider.

## Surfaces

**Settings › Watchpoints** (mock-ups 1 and 1b). A project section under Planning, after Areas and Hazards.
- One table, in two groups: "Yours, in every project" and "This project".
- Each row has a segmented loudness control. Hold is greyed out until S5, and Ask until S2.
- The row's drawer edits the name, why, globs (with a matching-file count read from the checkout), guidance,
  loudness, and **Applies to**: every project or this one.
- An override carries a cyan tag, and "Use yours" drops it.
- The last-30-days column arrives in S2.

**For You** (mock-up 2). It is the first section of the drawer's Overview when the newest watchpoint row has hits, and
it is absent otherwise. It mirrors `TaskSkips`: it fetches `/workstreams/:id/watchpoint-hits` itself and returns null
when empty.
- There is one fold per watchpoint, holding its loudness tag and file count.
- Inside a fold come "You asked: <guidance>", then each file's Agent and Reviewer notes, then its hunks, drawn
  with `HunkDiff` from `parseChanges` over the stored patch.
- Folds start open for ask and hold, and closed for show.
- "Open the whole diff" opens the existing Changes view while the worktree exists, and is hidden once it's gone.
- It refetches on `evidence.recorded`.
- It shows the task's latest workstream, as the rest of the drawer does. While a retry runs, the earlier run's hits
  stay hidden until the retry's own gate passes.

**The Look card** (mock-up 3, S2). It follows the Acceptance card's pattern and rules:
- one live card per workstream, written in the write that moves the run on, never a run's question, and nothing
  for recovery to rebuild;
- **Looks right** closes it;
- **Send back with a note** files one Ready follow-up task, linked to the original, holding the watchpoint, the files
  and the note.

**PR body** (mock-up 4). Described under § When it runs.

## Provider parity

| | Claude plan | Bedrock or API key | ChatGPT/Codex plan |
| - | - | - | - |
| Settings, matching on globs and lines, For You, the PR body, the Look card | Same | Same | Same. The daemon does all of it. |
| `watchpointNotes` from the build and review steps | Through 10db's MCP `commit` and `complete_step` | Same | Same MCP server, same tools |
| Judge questions (S3) | Not asked without a Decisions account; Settings and For You say "Judge questions aren't checked: no account can answer decisions" | Asked on the Decisions account | As on a Claude plan |
| Hold (S5) | PR delivery only. On local delivery, hold acts as ask, and Settings says so. | Same | Same |

No watchpoint changes a step's model.

## Trust

Watchpoints add no restriction to the agent. They decide only what you see and, with hold, when a merge waits for you,
which is a consequence you opted into for code that goes live. That is 10db coordinating its own writers, not a
rule on the agent. A lane can't edit a watchpoint: watchpoints live outside the repo, and an agent's edit is a proposal
(S4).

## S5, hold (Core, outline only)

- On PR delivery, a run with a hold hit ships its PR with `autoMerge: false`, through the existing landing hold
  (`packages/contracts/src/landing.ts`).
- The Look card gains **Merge**, which turns auto-merge on and leaves CI to decide.
- A goal's Light and Standard tasks share a PR, so one hold holds the goal, and the card names the tasks waiting.
- Recovery: a held PR found open after a restart keeps its card.
- A judge answer alone never holds. A hold needs a glob or line match.

Its own index and cards come after S4, with plan review.

## State table (design, not a test list)

| Situation | What happens |
| --------- | ------------ |
| Gate passes, no watchpoint matches | No row. No For You, no PR section. |
| Gate passes, a show watchpoint matches | A row. For You with the fold closed, and the PR section. |
| Gate passes, an ask watchpoint matches (S2) | A row, a Look card in the same write, and a review forced if the task is Light. |
| The diff can't be read | A row with `skipped`. For You says so, and the run goes on. |
| Review sends it back, the fix passes the gate | A newer row. For You and the PR use it. |
| A watchpoint is edited after the run | For You still shows the snapshot taken at match time. |
| The worktree is removed | For You is unchanged, and "Open the whole diff" is hidden. |
| A project overrides one of your watchpoints to off | It isn't matched in that project. |
| No `watchpointNotes` were sent | The fold shows the hunks with no Agent or Reviewer line. |
| A Light task (no review) | The fold shows the Agent line and no Reviewer line. |
| The gate's base merge brings in main's migration | It isn't a hit: the diff starts at the base read after the gate. The one exception is a start-on-base merge that conflicted, where `moveBase` leaves the base in place; main's files are then hits, as the run's changes already include them. |
| A watchpoint row's detail fails to parse | It reads as skipped; the workstream's other evidence is unaffected. |

## Tests (per `.claude/rules/testing.md`)

- **One pure rule-table test** of `matchWatchpoints` and `effectiveWatchpoints`: dot-path globs, overrides and `off`, and
  a file under two watchpoints.
- **Extend `loop.spec.ts` test 1** (the real daemon and the fake adapter). Add a watchpoint whose glob covers the file the
  fake agent writes, then assert For You shows it, with the hunk and the agent's note.
- **No PR-body test is added.** A case in `pr-text.test.ts` gains a watchpoint input, which extends a test rather
  than adding one.
- S2 extends `inbox.spec.ts` with the Look card. S3a's line patterns join the rule-table test.
