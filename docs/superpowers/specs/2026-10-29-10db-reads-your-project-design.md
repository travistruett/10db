# 10db reads your project: areas, hazards and setup proposed, used and learned

**Status:** written on 2026-10-29 from a conversation with the builder while dogfooding, then revised after a
plan-reviewer pass (Fable): the model step became a read-only task after save, the default part is computed,
waits and touched paths get recorded, and suggestions apply when their part is free.
**Extends:** `2026-10-28-10db-first-run-design.md` (§13 deferred "areas proposed from the repository" and "a
task's areas proposed from its description"; this spec takes both) and `2026-10-13-10db-factory-loop-design.md`
§8 (claims). **Depends on:** per-task placement (10db task "Choose Your folder or a separate copy for each
task") for §6.3 only.

Each part is marked **Built** (on `main`), **Queued** (a 10db task exists and may land first) or **Designed**.

## 1. Intent

Settings › Areas and hazards is a wall of globs, command prefixes and help lines (screenshot 2026-10-29 14:52).
The builder doesn't know what it is for or how to improve it. Network hosts is a list they don't know how to
fill. Both show 10db's mechanism instead of answering the builder's questions:

- What can run at the same time?
- What does 10db keep to one task at a time, and why?
- What does 10db think this project is?

The builder never needs to see areas, hazards, globs or command prefixes to start work. 10db reads the
repository, proposes how to run it, uses that on every task, and gets better from what tasks actually do. The
builder sees a short summary in words, can change anything, and is asked only when 10db has evidence a change
would help.

**Success means:**

1. Adding a project shows "How 10db sees <project>" in under a minute from the folder's structure and history,
   and refines its names and reasons in place within a few minutes after save. One click accepts it.
2. A task is created without choosing parts: 10db proposes them and shows them as chips the builder can change.
3. After 50 finished tasks, 10db has said at least once, with numbers, whether a part should split or merge, and
   the builder answered in one click.
4. Settings › Areas and hazards reads as a list of the project's parts in plain words; paths are one click away,
   not on the page.
5. Nothing from the repository runs to produce any of this.

**Non-goals:** choosing per task between your folder and a separate copy (its own task; this spec gives it
inputs), the shaping flow, Codex, a model picker for the assessment.

**Anti-goals:** running repository code to learn about it (`make -n`, `npm run`, a build); a proposal 10db can't
explain; changing a project's areas or hazards without the builder's yes; a suggestion with no evidence; model
output reaching a stored glob, a claim key or the guard's rules without code-level checks.

## 2. What areas and hazards are for

Said here because the page itself must say it in one line.

- **An area** is a part of the project. Two tasks in your folder run at the same time only when their areas
  don't overlap, and a task may write only inside its areas, asking for more mid-run with `request_claim`
  (`apps/daemon/src/guard/judge.ts:105-119`). A path in no area is denied for every task. In a separate copy
  (worktree mode) areas don't hold tasks up (worktree design W9). **Built.**
- **A hazard** is something only one task may change at a time across the project, such as a lockfile, the
  migrations or the agents' instructions. Hazards are project-wide in both modes. **Built.** Whether file-only
  hazards should be per copy is the task "Stop tasks in separate copies queuing on each other for AGENTS.md and
  the lockfile". **Queued.**
- **Setup today** makes one area, `repo` over `**` (`apps/desktop/src/views/project-setup/project-input.ts`), and the New Task form hides the picker
  when there is one area. So most builders never see areas, and every task in a shared checkout serializes.
  **Built.**
- **Granularity is a trade-off.** Too wide and tasks take turns; too narrow and tasks stall asking for more. No
  one picks it right up front, so 10db learns it (§7).

## 3. Words and names

| Daemon / docs | UI says |
| --- | --- |
| area | "part" in prose; the setting stays "Areas". Shown by its label ("Desktop: Inbox"), keyed by its name (`desktop-inbox`) |
| hazard | "One at a time" (the list and the rule). Not "protected", which the guard's cards already use for other paths |
| glob | "Paths" (behind Edit) |
| hazard command | "Commands that also count" (behind Edit) |
| claim | not shown; "is working in" ("Inbox count is working in Desktop: Inbox") |
| assessment | "How 10db sees <project>" |

**Designed (contracts):** `AreaDef` gains `label` (display name, ≤ 60 chars), `description` (≤ 140), `reason` (≤
200) and `source` (`setup` · `assessment` · `builder` · `suggestion`); `HazardDef` gains `label`, `description`,
`source` and `restartsDevServer` (true for a lockfile or a config a dev server reads at start, for §6.3). The
`name` slug (`^[a-z][a-z0-9-]*$`, `entities.ts:36`) stays the only key claims, tasks and `request_claim` use.
Model prose never becomes a key. The db baseline is regenerated, per `packages/db/AGENTS.md`.

## 4. The assessment

### 4.1 The scan: a read of the repository that runs nothing

**Built:** the folder inspection at setup (`apps/daemon/src/folders/inspect.ts`) reads named small files with
lstat, `O_NOFOLLOW` and a 256 KiB cap, and returns branches, the default branch, the GitHub repo and gate
candidates. It runs before the project exists, so its git calls are unpinned (`git.ts` `inspect`), with hooks,
attributes and config selectors off (`run.ts`).

**Queued:** "Propose a new project's areas from its repository, for the builder to edit" adds a workspace-based
proposal at setup through one daemon function. **That task owns the first workspace reader.** This spec's scan
extends it and is built after it lands (§10), so two agents never write a second reader.

**Designed:** the scan, all as data, with the inspection's guarantees and none of a pinned checkout's:

- **Structure:** the tracked file list (`git ls-files -z`), file counts per folder to depth 4, and workspace
  definitions (`pnpm-workspace.yaml`, `package.json` workspaces, Cargo workspaces, `pyproject` packages, Go
  modules).
- **Framework seams by marker:** Next.js route groups under `app/`, `pages/`, Django `apps/*/models.py`, Tauri
  `src-tauri/`, `src/views/*`. A marker names a candidate; it never decides alone.
- **Hazard candidates:** lockfiles and manifests, migration folders (`**/migrations/**`, `drizzle/`,
  `alembic/`), generated folders the repo declares (`.gitattributes linguist-generated`, a `generated/` folder),
  the agents' instructions (`AGENTS.md`, `CLAUDE.md`, `.claude/`, `.codex/`), CI config. No source file is read
  to find these.
- **Check, preview and seed:** gate candidates (**Built**); dev-server candidates from `package.json` script
  names (`dev`, `start`), `Procfile` process names and `docker-compose.yml` service names; for the worktree seed,
  the **names** of ignored files the checkout has (`.env`, `.env.local`), never their contents (the sandbox treats
  them as secrets, `sandbox/project-access.ts`).
- **Hosts:** the queued task "Work out a project's network hosts from its package setup…". **Queued.**
- **History:** the files each of the last 500 first-parent commits on the default branch changed
  (`git log --first-parent --name-only -z`).

**Limits:** one abort signal across the whole scan (30 s); 100,000 tracked files; 200 manifest and config files,
each through the inspection's single-file guard and a zod schema per format; 4 MiB of manifest bytes and 2 MiB of
`git log` output in total. YAML is parsed with a safe schema only (a new, pinned dependency, decided in its own
record). The scan returns what it skipped, and the proposal says so.

**Risk owned here:** after save, Look Again and drift (§7) parse manifests that lanes can write, and their result
can end up in the guard's rules. The daemon's rule is that no process outside a sandbox acts on lane-writable
input (`apps/daemon/AGENTS.md`). Mitigation: the scan is parsing as data with caps; candidate paths come only from
the file list and workspace definitions; every string shown is length-capped with control characters removed; no
change applies without the builder's yes.

### 4.2 The proposal from the scan

**Designed:**

1. **Candidates:** each workspace package; inside a large app, its framework seams; a shared folder (`lib/`,
   `components/`, `packages/ui`) as its own candidate; a top-level folder with 20 or more tracked files.
2. **History unit:** this repo, like many, squash-merges, so a first-parent commit is one pull request. A PR that
   spans four packages says the feature did, not that the packages belong together. So co-change counts only
   commits that touch **at most 3 candidates**, and ignores every hazard file (lockfiles, manifests, migrations).
3. **Merge:** two candidates merge when, among the commits that touch either, more than 40% touch both, and each
   has at least 5 such commits. A candidate under 20 files with no commits of its own merges into its parent;
   size alone never merges a candidate with its own commits (so `src-tauri/` stays).
4. **Fit score:** among the last 500 first-parent commits, the share whose non-hazard files fall inside one
   part. Shown as "87% of your last 500 changes stayed inside one part". Under 60%, the proposal says so and offers
   the next-wider one.
5. **The rest:** files in no candidate are counted on one row ("212 files: root config, scripts").

All of this runs in the daemon from the scan, before save, with folder names as labels and the numbers as
reasons.

### 4.3 Names and reasons: a read-only task after save

The model can't run before save: sessions need a workstream (`sessions/types.ts:29`), the lane sandbox needs a
project and an account, and every git call but `inspect` needs a pin.

**Designed (call D1):** saving the project creates and starts one system task, "Read <project>", on a new
read-only flow with one step, `assess`, on the project's account, in the lane sandbox, with Read, Glob and Grep
only (`ToolAccess.ReadOnly`, `permissions/rules.ts:52-65`). It is a normal workstream, so lanes, the account check,
usage accounting, recovery and the Board all apply; its card sits in In progress like any task. Its prompt carries
the scan and the proposal as data. It answers through one new lane MCP tool, `propose_parts`, whose input is
validated by zod and then by code:

- a label, description and reason per candidate (lengths capped, control characters removed);
- merges or splits only between candidates the scan produced: every glob in the output must be in the scan's
  candidate set (set membership in code, not in the prompt);
- the same for hazard labels and descriptions.

"How 10db sees" refines in place when it answers. If the task fails or the builder has no account ready, the
folder-name proposal stands and the task can be started again.

**Call D2 (replaces the first draft's):** the model reads the repository through Read, Glob and Grep, so text in
the repository can steer what it says. Its output is therefore untrusted: it may only label and explain what the
scan found, and every field is checked as above before the builder sees it. Nothing it writes becomes a key, a
glob or a rule without passing those checks and the builder's yes.

### 4.4 What the builder sees: "How 10db sees <project>"

Shown at setup after the folder is picked (from §4.2), refined after save (from §4.3), and later in Settings. One
screen, each row with its reason and an Edit link:

1. **Parts:** label, description, file count; the rest on one row. The fit score under them.
2. **One at a time:** label, what it covers, and where 10db found it ("pnpm-lock.yaml and every package.json:
   found from pnpm").
3. **Checked by** (gate), **previewed with** (dev server), **copied into each new copy** (seed names), **allowed
   hosts** (shown when the hosts task has landed), **base branch**.

Accept All saves everything. Any row can be edited in place first.

## 5. The rest of the project

**Built:** a path in no area is denied for writes (`judge.ts:115-118`), and setup's `repo` area over `**` hides
that.

**Designed (call D4):** with proposed parts, the files in no part form **the rest**: computed by the classifier
as "matches no stored area", never stored as a glob. It is claimable like an area under the reserved name `rest`.
A path in the rest belongs to no other area, so holding `rest` never lets a task write inside another part, and
the watcher's stray detection keeps working. `rest` can't be renamed, removed or given paths in Settings.

## 6. Every task's parts

### 6.1 Proposed when the task is made

**Built:** the New Task form requires areas, hidden with one area. `TaskPatch` has no `areas` (`entities.ts:314`).

**Designed:**

- **In the daemon, no model:** on save, a matcher proposes parts from paths and file names in the title,
  description and criteria (matched against each part's paths) and from words matching part labels and
  descriptions. The form shows them as chips marked "proposed".
- **Through a model-backed client:** the builder MCP (10db task "Let any MCP client the builder uses list, create,
  edit and start 10db tasks") and the `10db-task` skill pass the parts their own session chose from the code;
  10db validates names as today.
- **No parts:** a task with no parts is saved as "choosing parts", shown on its card, and isn't launchable until
  the builder picks or the matcher finds some. It never launches holding every part.
- **Editable while not running:** `TaskPatch` gains `areas`, refused while the task's workstream is active.

### 6.2 Cost

The per-task proposal runs no session. The only model run is the "Read <project>" task (§4.3), at setup and on
Look Again or drift.

### 6.3 Where a task runs

Out of scope (per-task placement task). This spec gives that planner its inputs: a task's parts, the hazards they
touch, and `restartsDevServer`.

## 7. Learning from what tasks do

### 7.1 What gets recorded (Designed; none of it is recorded today)

- **Touched paths:** at each `commit` tool call, the paths committed (`input.paths`, `mcp/tools.ts` `commit`) are
  stored with the workstream, so they survive a squash-merged branch's deletion.
- **Blocked launches:** when the scheduler can't acquire a task's claims (`scheduler.ts:176-193`, where today it
  `continue`s silently), it records "blocked: kind, name, held by, since" once per wait, and closes it when the
  task launches.
- **Refused asks:** a refused `request_claim` records the name asked for, beside `heldBy` (`tools.ts:290-293`
  stores only `heldBy` and the card id).
- **Granted asks:** already claims rows created after launch. **Built.**

### 7.2 Suggestions

**Window and trigger:** the last 50 finished tasks of a project, recomputed after every 10 finished tasks. The
structure scan also runs then, for drift. Thresholds live in one module (call D3) and are tuned from this
project's data after 100 tasks.

- **Split:** a part where, in at least 80% of the tasks that touched it, the changes stayed inside one of two
  disjoint halves (by folder), and tasks were blocked on it at least 3 times.
- **Merge:** two parts asked for together mid-run in at least 5 tasks.
- **Missing:** a folder in the rest written by at least 3 tasks.
- **Drift:** a new workspace package or framework seam since the last assessment. Drift starts a new "Read
  <project>" task (call D5: the structure scan runs on the trigger above; the model runs only on Look Again or
  drift).

A suggestion is one Inbox flag with choices (`InboxKind.Flag`, answered through `onFlagAnswer`), low urgency,
with the evidence ("In 14 of the last 16 tasks in Desktop, changes stayed inside either settings/ or board/; tasks
were blocked on Desktop 5 times") and Apply / Not Now / Never For This Part. Never is stored per project and part
in app settings. At most one suggestion card per project at a time.

**Applying:** the project store refuses removing or renaming an area a running task holds
(`store/projects.ts:101-135`). So Apply is **deferred**: the change is stored as pending, the card says "Applies
when no task is working in Desktop", and it applies in the first transaction after the last claim on those parts
is released. New tasks proposed in the meantime use the new parts once applied.

## 8. Settings › Areas and hazards, rebuilt

**Built today:** an editor of name, globs and commands per row with help lines under each (`project-areas.tsx`).

**Designed:**

- One line at the top: what parts are for, and whether they hold tasks up in this project right now ("Tasks run in
  separate copies, so parts don't hold them up; they still limit what a task may change").
- Parts as rows: label, description, file count, the last 3 tasks that worked in it (from §7.1's record), and a
  quiet note on a part with a pending suggestion. The rest as its last row.
- One at a time as rows, each with its source.
- Edit opens a drawer per row: label, description, paths, commands, with the path examples there. Add Part opens the
  same drawer.
- Look Again starts a "Read <project>" task and shows what changed beside the current rows; nothing changes until
  accepted.

Network hosts takes the same shape (host, source, Remove as a default button); its own task owns that page.

## 9. Decisions to make in review

- **D1** The model step is a read-only system task after save, answering through `propose_parts`. **(call)**
- **D2** The model's output is untrusted and may only label and explain the scan's candidates, checked in code.
  **(call)**
- **D3** Thresholds are starting values in one module, tuned after 100 tasks. **(call)**
- **D4** The rest is computed, claimable as `rest`, never stored as a glob. **(call)**
- **D5** Structure scan after every 10 finished tasks; model run only on Look Again or drift. **(call)**
- **D6** A task with no parts waits in "choosing parts" rather than launching with every part. **(call)**
- **D7** Suggestions apply when their parts are free. **(call)**

## 10. Build order

Each is a 10db task; dependencies in brackets. Tasks with a model path test it with the fake adapter (the boundary
in `apps/daemon/AGENTS.md`) and add a `TENDB_LIVE_CLAUDE=1` live test that never runs in `make gate`.

1. **Contracts and db:** `AreaDef` and `HazardDef` fields of §3, `TaskPatch.areas` refused while active, the
   reserved `rest` name, a regenerated baseline. (none)
2. **The rest, computed:** classifier, guard and watcher treat files in no stored area as `rest` (§5). (1)
3. **Scan:** extend the queued proposal task's reader to §4.1, with the limits. (the queued proposal task)
4. **Proposal from scan and history:** candidates, the history unit, merge, fit score, the rest (§4.2). (1, 3)
5. **"Read <project>" task and `propose_parts`:** the read-only flow, the system task at save and on Look Again,
   the code checks of §4.3. (4)
6. **"How 10db sees <project>" at setup and after save** (§4.4); the hosts row shows once the hosts task has
   landed. (4, 5)
7. **Existing projects:** show "How 10db sees" once on upgrade with Look Again; accept or dismiss. This is the path
   this project is on. (6)
8. **Task outcomes recorded** (§7.1). (none)
9. **Settings › Areas and hazards rebuilt** (§8), with Look Again. (6, 8)
10. **A task's parts proposed** (§6.1): the matcher, "choosing parts", chips in the New Task form and the drawer.
    (1, 2)
11. **Suggestions** (§7.2) with deferred apply. (8, 9)

## 11. Not covered

- Per-task placement (its own task).
- A part's own check command (run only the desktop tests for a desktop task).
- Knowledge per part (scoped decisions and principles exist in the factory spec; not used here).
