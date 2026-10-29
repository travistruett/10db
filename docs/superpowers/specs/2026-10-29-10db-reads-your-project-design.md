# 10db reads your project: areas, hazards and setup proposed, used and learned

**Status:** written on 2026-10-29 from a conversation with the builder while dogfooding, before review. It
answers "how can 10db really get my project and how to orchestrate it, as frictionless as auto mode?"
**Extends:** `2026-10-28-10db-first-run-design.md` (§13 deferred "areas proposed from the repository" and
"a task's areas proposed from its description"; this spec takes both) and `2026-10-13-10db-factory-loop-design.md`
§8 (claims). **Depends on:** per-task placement (task "Choose Your folder or a separate copy for each task") for
§6.2 only.

Each part is marked **Built** (on `main`), **Queued** (a 10db task exists and may land first) or **Designed**.

## 1. Intent

Settings › Areas and hazards is a wall of globs, command prefixes and help lines (screenshot 2026-10-29 14:52).
The builder doesn't know what it is for or how to improve it. Network hosts is a list they don't know how to
fill. Both show 10db's mechanism instead of answering the builder's questions:

- What can run at the same time?
- What does 10db protect, and why?
- What does 10db think this project is?

The builder never needs to see areas, hazards, globs or command prefixes to start work. 10db reads the
repository, proposes how to run it, uses that proposal on every task, and gets better from what tasks
actually do. The builder sees a short summary in words, can change anything, and is asked only when 10db has
evidence a change would help.

**Success means:**

1. Adding a project shows "How 10db sees <project>" in under a minute: its parts, what it protects, how it is
   checked, how it is previewed, which hosts it needs, each with a one-line reason. One click accepts it.
2. A task is created without choosing areas. 10db proposes them from the task's words and the code, and
   shows them as chips the builder can change.
3. After 20 tasks, 10db has said at least once, with numbers, whether an area should split or merge, and the
   builder answered in one click.
4. Settings › Areas and hazards reads as a list of the project's parts in plain words; globs are one click away,
   not on the page.
5. Nothing from the repository runs to produce any of this.

**Non-goals:** choosing per task between your folder and a separate copy (its own task; this spec gives it
inputs), the shaping flow (chat and screenshots into tasks), Codex, a model picker for the assessment.

**Anti-goals:** running repository code to learn about it (`make -n`, `npm run`, a build), a proposal 10db can't
explain, changing a project's areas or hazards without the builder's yes, a suggestion with no evidence.

## 2. What areas and hazards are for

Said here because the page itself must say it in one line.

- **An area** is a part of the project. Two tasks working in your folder run at the same time only when their
  areas don't overlap, and a task may write only inside its areas (it asks for more mid-run with
  `request_claim`). In a separate copy (worktree mode) areas don't hold anything up: each copy is its own
  checkout (worktree design W9). **Built.**
- **A hazard** is something only one task may change at a time across the project, such as a lockfile, the
  migrations or the agents' own instructions. A task touching one, or running one of its commands, waits for
  the task holding it. Hazards are project-wide in both modes today. **Built.** Whether file-only hazards such as
  AGENTS.md and the lockfile should be per copy is the task "Stop tasks in separate copies queuing on each other
  for AGENTS.md and the lockfile". **Queued.**
- **Granularity is a trade-off.** Too wide and tasks take turns; too narrow and tasks stall asking for more.
  No one can pick it right up front, so 10db learns it (§7).

## 3. Words

| Daemon / docs     | UI says                                        |
| ----------------- | ---------------------------------------------- |
| area              | "part" in prose ("the Settings screens part"); the setting is still "Areas" |
| hazard            | "Protected" (the list), "one task at a time" (the rule)  |
| glob              | "Paths" (behind Edit)                          |
| hazard command    | "Commands that also count" (behind Edit)       |
| claim             | not shown; "is working in" ("Inbox count is working in Desktop: Inbox") |
| profile / assessment | "How 10db sees <project>"                   |

## 4. The assessment

### 4.1 Inputs: a read of the repository that runs nothing

**Built:** the folder inspection at setup (`apps/daemon/src/folders/inspect.ts`) reads small files without
following links and returns the branches, the default branch, the GitHub repo and gate candidates.

**Designed:** the same reader, extended to a **scan**, all as plain data:

- **Structure:** the tracked file list (`git ls-files` through the daemon's pinned git), file counts per folder to
  depth 4, and workspace definitions (`pnpm-workspace.yaml`, `package.json` workspaces, Cargo workspaces,
  `pyproject` packages, Go modules), each package's name and folder.
- **Frameworks by marker:** Next.js (`app/` route groups, `pages/`), Django (`apps/*/models.py`, `manage.py`),
  Tauri (`src-tauri/`), Rails, and so on. A marker only names candidate seams (a route group, a Django app); it
  never decides alone.
- **Hazard candidates:** lockfiles and manifests, migration folders (`**/migrations/**`, `drizzle/`, `alembic/`),
  generated folders the repo declares (`.gitattributes linguist-generated`, a `generated/` folder, a header
  comment), the agents' instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`), CI config.
- **Check, preview and seed:** gate candidates (**Built**), dev-server candidates from `package.json` scripts
  named `dev`/`start`, `Procfile`, `docker-compose.yml` services; files a fresh copy lacks that the checkout has
  (`.env`, `.env.local`) for the worktree seed.
- **Hosts:** registries named by lockfiles and package-manager config. This part is the task "Work out a
  project's network hosts from its package setup…". **Queued.**
- **History:** for the last 500 commits on the default branch, the files each changed
  (`git log --name-only --no-merges`, pinned git, no hooks). From it, how often each pair of candidate parts
  changes in the same commit.

The scan is capped (100,000 tracked files, 500 commits, 30 s) and says what it skipped.

### 4.2 Turning the scan into a proposal

**Queued (first slice):** "Propose a new project's areas from its repository, for the builder to edit" builds a
proposal at setup from structure, through one daemon function. This spec extends that function; it doesn't
replace it.

**Designed:**

1. **Candidates** from structure: each workspace package; inside a large app, its framework seams (route groups,
   Django apps, `src/views/*`); a shared folder (`lib/`, `components/`, `packages/ui`) as its own part.
2. **Merge by history:** two candidates that change together in more than 40% of the commits touching either
   become one. A candidate with fewer than 1% of the repository's files and no history of its own merges into
   its parent.
3. **Fit score:** the share of the last 500 commits whose files fall inside one part. Shown with the proposal
   ("87% of your last 500 commits stay inside one part"). A proposal under 60% says so and offers the next-wider
   one.
4. **Naming and reasons by a model:** one read-only Claude Code run, on the project's account, in the lane
   sandbox with only Read, Glob and Grep, given the scan and the candidates as data. It returns, validated by
   zod: for each part a name, a one-line description in words ("the Settings screens"), and a reason citing the
   evidence ("its own route group; changed alone in 31 of 34 commits"); and the same for each hazard. It may
   rename, describe and explain; it may not add a glob the scan didn't produce. If the run fails or is off
   (offline, no account), the proposal still appears with folder names and the numeric reasons.

**Call D1:** a Claude Code run, not a direct API call. 10db runs on the builder's subscription
(`apiKeySource: none` in the session logs), has no API key, and already runs read-only steps in the sandbox.

**Call D2:** the model never sees file contents beyond what the scan read (manifests, configs, the file list).
Cheaper, faster, and it can't be steered by text in the repository.

### 4.3 What the builder sees: "How 10db sees <project>"

Shown at setup after the folder is picked and before the project is saved, and later from Settings. One screen,
in this order, each row with its reason and an Edit link:

1. **Parts** (areas): name, description, file count; files in no part counted on one row ("212 files in no
   part: root config"), which go to a default part, never left unowned.
2. **Protected** (hazards): name, what it covers in words, and where 10db found it ("pnpm-lock.yaml and every
   package.json: found from pnpm").
3. **Checked by** (gate), **previewed with** (dev server, new), **copied into each new copy** (seed),
   **allowed hosts** (queued task), **base branch**.

Accept All saves everything. Any row can be edited in place first. The fit score sits under Parts.

## 5. Settings › Areas and hazards, rebuilt

**Built today:** an editor of name, globs and commands per row, with help lines under each (`project-areas.tsx`).

**Designed:** the page becomes the "How 10db sees" view for Parts and Protected:

- One line at the top: what parts are for, and whether they matter for this project right now ("Tasks run in
  separate copies, so parts don't hold tasks up; they still limit what a task may change").
- Parts as rows: name, description, file count, the last 3 tasks that worked in it, and a quiet warning on a part
  that suggestions say to split or merge.
- Protected as rows, each with its source.
- Edit opens a drawer per row with name, description, paths and commands, and the path examples there, not on the
  page. Add Part opens the same drawer.
- Look Again runs the assessment and shows what changed beside the current rows; nothing changes until accepted.

Network hosts becomes the same shape (host, source, Remove as a default button); its task owns that page.

## 6. Every task's parts, proposed

### 6.1 Areas from the task's words

**Built:** the New Task form requires the builder to pick areas.

**Designed:** when a task is saved, 10db proposes its parts: the model reads the title, description and criteria
with the part list and descriptions, and searches the code (Read, Glob, Grep) for the files named or implied. The
form shows the proposed parts as removable chips with "proposed" until the builder changes them. A task the
builder saves before the proposal returns keeps "every part" and narrows when it arrives, unless it has started.
The 10db-task skill and the builder MCP use the same proposal.

### 6.2 Where a task runs

Out of scope (per-task placement task). This spec gives that planner its inputs: a task's proposed parts, the
hazards they touch, and whether a part is flagged "breaks the dev server mid-change" (a lockfile, a config the dev
server reads at start).

## 7. Learning from what tasks do

**Built:** the watcher sees every write a lane makes; `request_claim` records asks; claims record waits.

**Designed:** for each finished task, 10db records the parts it was given, the files it changed (from its
commits), the parts it asked for mid-run, and how long it waited on another task's part. From the last 50
finished tasks of a project it computes, nightly and after every 10 tasks:

- **Split:** a part where tasks' changes fall in two disjoint halves (by folder) in at least 80% of the tasks that
  touched it, and at least 3 waits happened in it. Suggests the two halves, with numbers.
- **Merge:** two parts asked for together mid-run in at least 5 tasks. Suggests one part.
- **Missing:** a folder written by at least 3 tasks that sits in the default part. Suggests a part for it.
- **Drift:** a new workspace package or framework seam since the last assessment. Suggests a part for it.

A suggestion is one low-urgency Inbox card with the evidence ("In 14 of the last 16 tasks in Desktop, the changes
stayed inside either settings/ or board/; tasks waited on Desktop 5 times") and Apply / Not Now / Never For This
Part. Applying it changes the project's parts and appends an event; running tasks keep their claims until their
next session. At most one suggestion card per project at a time.

## 8. Decisions to make in review

- **D1** Claude Code run for the model step (above). **(call)**
- **D2** The model sees the scan, not file contents. **(call)**
- **D3** Thresholds (40% co-change, 80% split, 5 asks, 50 tasks) are starting values in one module, tuned from
  this project's data after 100 tasks. **(call)**
- **D4** A default part always exists and owns every file in no other part, so a task is never blocked by "no
  area". **(call)**
- **D5** The assessment re-runs only when asked (Look Again) or when drift is detected, never on its own schedule.
  **(call)**

## 9. Open questions for the builder

1. Should accepting a suggestion ever happen without a card, for example a Missing part when a folder clearly is
   one? (Recommendation: no, until 100 tasks show the suggestions are right.)
2. Should the assessment run for existing projects on upgrade? (Recommendation: show "How 10db sees" once with
   Look Again, accept or dismiss.)

## 10. Build order

Each is a 10db task; dependencies in brackets.

1. **Scan:** extend the folder inspection to the scan of §4.1, as data, with caps. (none; coordinates with the
   queued proposal task, which owns the first proposal function)
2. **Proposal from scan and history:** candidates, merge by co-change, fit score (§4.2 1–3). (1, the queued
   proposal task)
3. **Model naming and reasons:** the read-only run of §4.2 4, with the fallback. (2)
4. **"How 10db sees <project>" at setup** (§4.3). (3, the queued hosts task)
5. **Settings › Areas and hazards rebuilt** (§5), with Look Again. (4)
6. **A task's parts proposed** (§6.1), in the New Task form, the skill and the builder MCP. (3; the MCP task)
7. **Task outcomes recorded** (§7, the record only). (none)
8. **Suggestions** (§7), one card at a time. (5, 7)

## 11. Not covered

- Per-task placement (its own task).
- A part's own check command (run only the desktop tests for a desktop task).
- Knowledge per part (decisions and principles scoped to an area exist in the factory spec; not used here).
