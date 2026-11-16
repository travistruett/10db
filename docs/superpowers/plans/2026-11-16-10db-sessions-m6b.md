# Sessions M6b: Do It, Changes, a pass of one, and the tab handover

## Brief

**What changes for you.** A chat's session bar gains **Do It…** (⌘⇧↩). Its sheet shows a title, a brief, where the
work goes, and which files you've left uncommitted in Your folder, with what happens to them. The chat's agent
writes the brief. If it hasn't written one in 60 seconds, the brief is the chat so far plus your last message. You
can edit it either way.
- **Separate copy:** an ordinary task in its own copy. It lands by the project's delivery. The task takes the
  chat's tab, and the chat becomes read-only. Your uncommitted files stay in Your folder.
- **Your folder, as a pass:** a pass of one, whose one page is "Whole project". It opens in its own tab beside the
  chat, with Sign Off, Close Pass… and Abandon Pass… as in the Workbench. The chat stays open, and reads only while
  the pass holds the folder. Your uncommitted files become the task's work. Abandon puts them back as they were.
- **A message sent while the folder is held** gets a fourth choice: Do It in a Separate Copy.
- **When a pass can't open because a chat is mid-turn**, in the Workbench or in the sheet, you get **Stop the Turn
  and Open** and **Open When It Ends**.
- **A task's tab has Changes** (⌘⇧D). It shows the diff against the base, and a pass of one adds All Turns and
  Last Turn.

**What it buys.** "Knock this out" goes from the conversation to a task without retyping anything. The task gets a
brief, its own branch and your delivery, or the pass's kept turns and one pull request.

**What could go wrong, and how we'd know.**
- **Do It Here racing another writer.** It stops the chat's own turn, and the pass opens only once that turn has
  given the folder back. While it waits, a new chat turn reads only and a task's first start waits. Real-git tests
  cover a feature branch, base on a PR project and on a `local` one, a refusal mid-merge or mid-bisect, and the
  state after the close. State-table rows cover the race with the release and with the settle.
- **A whole-project page and hazards.** Lockfiles and migrations still need their hazard. A judge row and a
  kept-work row prove it, and the adversarial review goes after them.
- **A sealed chat writing later.** Every late call from it (a background agent, the old `/mcp` token,
  `write_brief`) is refused, and a test shows it.
- **A wrong brief.** You read and edit it before Do It. The task never resumes the chat's agent session.

**Calls you might disagree with:**
1. **A pass of one stacks on a closed pass** that is waiting for its pull request, as Start Pass does today. The M6
   plan said refused.
2. **Separate copy isn't offered on a `local` project**, since such a project has no copies. The sheet says why and
   picks Your folder.
3. **In a pass of one, the migrations and deps hazards run in Your folder.** They still need their claim, but there
   is no Move to a Separate Copy card. A chat installs in place too, and there is no other page to disturb.
4. **The seal is Do It's last step**, not its first. If a restart cuts it short, recovery finishes it. If the task
   fails to start, the chat is left untouched.
5. **The brief turn always runs reading only.** If the chat's warm session can write, it reopens (a few seconds).
   The brief fills in when the agent's call lands; it doesn't stream character by character.
6. **A Task's tab lives in the window** (`localStorage`, as fresh tabs do), not in the database, so there is no
   migration. A cleared store loses the tab, never the task: the Board, the Workbench, the Inbox and the chat's
   "Started a task" row all reopen it.
7. **New Chat From This becomes a follow-up.** The sealed chat offers Open Task.
8. **What makes a pass "of one" is its task naming the synthetic page**, not `chats.pass_id`. A later Do It Here
   from the same chat rewrites `pass_id` while the first pass may still wait for its pull request.
9. **Open When It Ends keeps the project's delivery slot while it waits**, as M6a's waiting cut does, and a restart
   drops it.

**Needed from you:** nothing. No migration. Reply to approve.

---

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps
> use `- [ ]`. Read the M6 plan's Design section first
> (`docs/superpowers/plans/2026-11-15-10db-sessions-m6.md`): the holders, the module, the state × event table, the
> git tools, provider parity and the security table. This plan extends them and repeats none of it.

**Goal:** Do It hands a chat's work to a task, either in a separate copy or as a pass of one in Your folder, on
every account kind. A task's tab shows its thread and Changes, and lands the task.

**Spec:**
- Sessions design: S3, S15, S16, §6.7 (`sealed`), §7.1 (`mode`, `task_id`, `pass_id`), §7.3 (Do it), §7.4
- Sessions UI: §5.2, §8, §9, §14
- Roadmap: "### M6", the Do it bullets, the real-git tests and the e2e
- Decisions: `2026-11-14-abandon-pass-deletes-unsigned-pages-work.md`,
  `2026-11-09-a-close-fast-forwards-the-folders-branch.md`, and M6's record (amended here)

**Starting point:** `feat/sessions-m6b` at 0f77887f (M6a built and reviewed, main merged in). Merge `main` once M6a
lands, before Task 1.

## Design

### Do It, in order

`chat/do-it.ts` (new) owns both places. `POST /chats/:chatId/do-it` takes `{ place, title, brief }`, and for
`here` also `whenBusy?` (below). Both places are refused from `taken_over` ("Hand back first"), `sealed` and an
archived chat, before anything else.

**Separate copy (`place: worktree`):**
1. **Refused on a `local` project** ("This project lands locally, so it has no separate copies"), as
   `proposePlacement` would make the task shared.
2. **The chat's turn stops.** `engine.holdStarts(conv)` first, so `stop_settled` sees no queue and nothing chains.
   Then `engine.stop`, then `settled`.
3. **The task is created** through `services.createTask`: the title, the brief as `description`,
   `workspaceMode: worktree`, and a `chat_tasks` row. Then `services.settleSizing([taskId])`.
4. **In one synchronous run:** `services.startTask(taskId)`, then one write that sets the chat's `mode: hands_on`,
   `task_id` and `tab_position: null`, and stores a `handed_to` notice in the chat's thread.
5. **The seal:** `engine.seal(conv)`, which reduces `do_it` to `sealed`, closes the session and ends its row, so its
   token reaches nothing. `onState(sealed)` gives the hold back (M6a).
6. **The answer** is `{ taskId, place }`. The desktop puts a Task tab where the chat's tab was.

If step 3 or the start in step 4 throws, a task with no run is removed (`removeTask`), `releaseStarts` runs, and
the refusal reaches the sheet. Recovery (`finishSeals`, called after `engine.recover()` in `daemon/start.ts`) seals
any `hands_on` chat whose conversation is not `sealed`. A restart between steps 3 and 4 leaves the task on the
Board, unstarted, and the chat as it was.

**Here (`place: here`):**
1. **The holders that keep it out.** These are `folderHold.blockers(project, GitWork)` less this chat's own turn
   and wait. The chat's own wait is cancelled. A lane, an open or closing pass, or a takeover each refuse it,
   naming the holder, with a link (Open on Board, Open UI Workbench, Open Session). Another chat's turn refuses it
   too, unless `whenBusy` says otherwise (B10, below).
2. **`openPass`'s row checks** (`refuseOpen`, page rules aside) and the folder checks (`operationInProgress`,
   which now includes a bisect; a detached HEAD; `returnBranchProblem`) run before anything stops.
3. **The chat's own turn stops** as in the separate copy's step 2.
4. **`openPass` with `wholeProject`.** Its Cut job waits for the folder (`reserveGitWhenFree`) instead of refusing,
   under a deadline of `STOP_GRACE_MS + JOBS_STOP_DEADLINE_MS + 5 s`. It re-runs `refuseOpen` after the wait.
   - The open's write makes the whole-project task (`insertWholeProjectTask`), sets the chat's `task_id` and
     `pass_id`, and stores the `handed_to` notice, so a refused write leaves none of them.
   - After the write, the brief is stored as the page's first builder message and delivered (`PageMessages.deliver`),
     so the page's first turn starts.
5. **`releaseStarts`** follows, refused or not. What is queued runs and reads only while the pass holds, with
   M6a's notice naming it.

**B10: a refused open with a chat mid-turn.** `whenBusy` is `stop_turns` or `wait`, and it is offered only when
every holder is a chat's turn.
- **`stop_turns`** does step 3 for each holding chat.
- **`wait`** answers at once with `{ pending: true }`. The open waits in its Cut job (`pass/pending-open.ts`: one
  per project, with an `AbortController`).
  - `FolderDto.pendingOpen` is `{ name, waitsFor } | null`, and `DELETE /projects/:projectId/pending-open`
    cancels it.
  - A restart drops it.
- **Start Pass** (`POST /projects/:projectId/passes`) takes the same `whenBusy`, so the Workbench offers both
  buttons too.
- **While a pass open waits for the folder,** a lane's first start waits too: its `freeing` entry counts for
  `LaneStart` (`reserveGitWhenFree(…, { lanesWait: true })`), since the pass is about to hold. The scheduler's
  notice names "the pass ‘X’, opening".

**The brief (B1).** `POST /chats/:chatId/brief {draft?}` sends a fixed builder message, with `folder: read_only`:
"Write the brief for a task that does the work we agreed on, and call write_brief. Change nothing." When `draft`
is set, it adds "Include this request: {draft}".
- **`write_brief {title, brief}`** is a chat tool. `title` is a `Title` and `brief` is capped at
  `TASK_MESSAGE_MAX_CHARS`. It keeps the brief in memory (`chat/briefs.ts`) and emits `ChatChanged`.
- **After 60 s on the injected clock** with no call, or at once when the chat is `paused_account` or can't start,
  the brief is `briefFromChat` (`chat/brief.ts`): the chat's messages and replies, cut as `chatDigest` cuts them,
  then "The builder's last message: …", under the source `chat`.
- **Typing in the field** posts Stop.
- **`write_brief` from a session that is not the chat's open one, or after the seal,** is refused.

**The preview.** `GET /chats/:chatId/do-it` → `DoItPreviewDto`:
- the brief: `{ title, text, source: agent | chat | null, writing }`
- `changed`: at most 200 `{ path, status: M | A | D | R | ? }` and `more`, from a new `Git.changedEntries`, read
  against a private index the way `changedPaths` is
- per place, `offered` and `refusal: { code, message, link } | null`
- `runningTurn`, and `stacksOn` (the closed pass it would stack on)

### A pass of one (B3)

- **`WHOLE_PROJECT_PAGE`** (`@10db/contracts`, `page-areas.ts`) is an `AreaDef`: name `10db-whole-project`, a name
  `AreaName` can't spell, so no project area or hazard can share it. Its globs are `WHOLE_REPOSITORY_GLOBS`, its
  role is `page`, and its label is "Whole project". It is never saved in `projects.areas`.
- **`passAreasOf(db, passId)`** (`@10db/db`, `store/passes.ts`) is `[WHOLE_PROJECT_PAGE]` when a task of the pass
  names it, and the project's areas otherwise. `isWholeProjectPass(db, passId)` reads the same thing.
  `passPageAreas` builds on it.
- **Every reader of the pass's areas** takes `passAreasOf` in place of `project.areas`:
  - the lane's judge input (`runner/runner.ts`, the `areas` and `inPass.pages` near `judgePreToolUse`)
  - the commit tool's judge (`mcp/tools.ts`, the `inPass` block)
  - claims (`scheduler/scheduler.ts` near `passHeldAreas`; `startPassTasks`)
  - kept work (`pass/kept-work.ts` `pageClaims` and `pageMatcher`) and `pass/shared-hold.ts`
  - review and checks (`delivery/pass-review.ts`, `runner/turn-checks.ts`, `runner/check-targets.ts`)
  - labels (`pass/view.ts`, `pass/abandon.ts`)
  - Add Page (`pass/join.ts`), which refuses with "A pass of one holds the whole project"
- **Hazards keep their rules.** The judge already checks a hazard after the page (`judgeRelative`), so a lockfile
  needs its hazard. `pageMatcher`'s "a hazard counts only outside the pass's pages" doesn't apply to a whole-project
  pass: a path in a hazard is the task's page work only when the task holds that hazard. Anything else is left to
  the close's "files no page owns". `passHazardAsk` answers `slow` for a whole-project pass on every delivery, so
  there is no Move card, and the thread says the hazard runs in Your folder.
- **Opening one.** `PassOpenInput` gains `wholeProject: { title, brief, chatId }` in place of `taskIds` and `pages`.
  `refuseOpen` skips the page-area rule and `passPagesProblem`, and keeps the open pass, the unfinished batch and
  the lanes. `insertWholeProjectTask` (`store/tasks.ts`) skips `refuseUnknownAreas`, marks `made_by_pass_id`, and
  stores the brief as `description`. Abandon retires it, as it retires any task the pass made.
- **The Workbench** lists a pass of one even in a project with no page area, so its live pass is read before the
  setup is.

### State × event table (extends M6's)

Columns are this chat's own state, then the folder's other holders. "Rel." is M6a's release: the jobs stop, then
`releaseTurn`.

| Event | own turn running, chained or waiting on a card | own message parked (wait) | free, or a closed pass | lanes | open or closing pass | another chat's turn | takeover (M7) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Do It Here** | `holdStarts`, Stop (a card withdrawn), `settled`; the open waits for rel., then opens | `cancelWait` (the message stays queued); opens | opens; on a closed pass it stacks (`stackOn`) | refused, naming the task; Open on Board | refused, naming it; Open UI Workbench | refused, offering Stop the Turn and Open, and Open When It Ends | refused, naming it; Open Session. This chat's own: "Hand back first" |
| **Do It, separate copy** | `holdStarts`, Stop, the task starts, then sealed: rel. | `cancelWait`; sealed | runs; sealed | runs (a copy needs no folder) | runs | runs | runs. This chat's own: "Hand back first" |
| Stop the Turn and Open | n/a | n/a | n/a | n/a | n/a | each holder: `holdStarts`, Stop; the open waits for every rel., then `releaseStarts` each | n/a |
| Open When It Ends | n/a | n/a | n/a | n/a | n/a | pending; new chat turns read only and first starts wait (`freeing`); opens at the last rel.; Cancel aborts | n/a |
| A lane's first start while an open waits | | | waits, notice "the pass ‘X’, opening" | n/a (Here was refused) | n/a | waits | waits |
| A lane's first start while the open is still queued behind other delivery work | | | starts; the open refuses after its wait, naming the task, and `releaseStarts` runs | | | | |
| This chat's queued messages after the open | run reading only, with M6a's notice naming the pass | | | | | | |
| The settle racing the release | Settle (Ship queue) and the open (Cut queue) both take `reserveGit`: whichever is second waits (`reserveGitNaming` or `reserveGitWhenFree`). The open stacks on whatever the settle left. Neither moves a branch the other is moving | | | | | | |
| Daemon restart mid-Do-It | Memory is gone: held starts, the pending open, the brief. A branch an open made with no row is taken back by today's pass recovery (`pass-recover.ts`, dirt trailers). A `hands_on` chat not `sealed` is sealed (`finishSeals`). A task made but not started stays on the Board | | | | | | |
| Do It after the turn's deadline | The open gives up and refuses: "The chat's turn didn't stop in time", then `releaseStarts` | | | | | | |
| A pass of one closes, or is abandoned | The chat's next turn writes again, since the folder is free (M6a) | | | | | | |
| `write_brief` after the seal, or from an old session | refused (the token is ended; `holdingSession`) | | | | | | |

**Races, designed once:**
1. **The own turn's release and the open.** The open's `reserveGitWhenFree` waits for this chat's pending release
   (`pendingReleases`, after `endJobs`). Its `freeing` entry keeps every chat out meanwhile, this chat's queue
   included, which is held anyway.
2. **The release and a lane's start.** A pass open's `freeing` entry counts for `LaneStart`, and the scheduler's
   `STARTING` write reads `blockers` again (M6a), so no first start slips between the release and the open's
   reservation.
3. **Seal and start.** The task starts before the seal, so a failed start leaves a chat that still works. The seal
   can't fail outside `taken_over`, which step 1 refused.

### Follow-ups 3 and 4 from M6a's review

Both were fixed in M6a. The settle reserves only around its two moves (`movingBranch` in `pass-settle.ts`), and git
work that waits keeps new chat turns out (`freeing` in `hold.ts` `blockers`). A pass of one adds closed passes,
and their two-minute pull-request reads reserve nothing, so follow-up 3 stays fixed. Do It Here leans on follow-up
4's fix, so Task 6 adds a row for it. Neither blocks.

### Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| `write_brief` | the chat's `/mcp` tool, in `allowedTools` | the same | 10db's `/mcp` through the guard hook, as every chat tool |
| The brief turn | read-only profile | the same | the read-only `permissions.lane` profile |
| The 60 s fallback | daemon | daemon | daemon. A ChatGPT plan whose usage is paused falls back at once |
| Separate copy | a worktree task on the account's judge | the same | the same. Worktree tasks run on Codex today |
| Pass of one | a pass lane, as Workbench pages run | the same | the same. Passes run on Codex today |
| Changes, tabs, sheet | daemon and desktop | the same | the same |
| Gaps | none | none | none new. The chat's lack of file checkpointing (M6a) is unchanged |

### Security table pass (B12)

**M6's rows that M6b touches:**
- **1, 2, 6, 7 and 13** now also cover the pass-of-one lane. It is a pass lane, so the lane's rows hold, and Task
  3's judge rows add the whole-project page.
- **12:** the separate copy's batch branch and the pass's branch are 10db's, so the chat's tools refuse them.
- **13:** sealing adds a row (17).
- **14:** Do It Here's open reserves before `openPassBranch`, unchanged.

**New rows:**

| # | Attempt | What stops it | Test |
| --- | --- | --- | --- |
| 15 | A whole-project page writes a hazard file (lockfile, migration) without the hazard | the judge's hazard check after the page; `pageMatcher` keeps a hazard path only with its claim | `guard/judge.test.ts` row; `pass/kept-work.test.ts` row |
| 16 | A whole-project page writes `.git`, a gitfile, a protected path, or agent config (`.claude/settings*.json`, hooks, `.mcp.json`) | the lane's rows 1–2; agent config loads only after its hash is approved (trust line §2) | judge rows with the whole page held |
| 17 | A sealed chat calls later (a background agent, the old `/mcp` token, `write_brief`, a git tool) | the seal ends the session row, so the token reaches nothing; `holdingSession`; git tools need `holdsTurn` | `test/do-it-copy.test.ts` |
| 18 | The brief smuggles instructions to the task's agent | the builder reads and edits it before Do It; the task runs under the lane's rules; capped at `TASK_MESSAGE_MAX_CHARS` | `chat/brief.test.ts` cap row |
| 19 | Do It Here opens under another writer (a lane's start, another chat's take, the settle) | `reserveGitWhenFree` with `lanesWait`; `freeing`; the `STARTING` recheck; `refuseOpen` after the wait | `test/do-it-here.test.ts` |
| 20 | Abandon of a pass of one loses the builder's earlier uncommitted work | the Abandon puts dirt back (decision 2026-11-14) | `test/do-it-here.test.ts` abandon row |
| 21 | The preview's file list or the brief floods the daemon or the UI | 200 entries and `more`; the brief's cap | `chat/do-it.test.ts` |

### Migrations, contracts and the decision

- **Migrations: none.** `chats.mode` (`hands_on`), `task_id` and `pass_id`, and `tasks.made_by_pass_id`, all exist
  (`packages/db/src/schema.ts`). Briefs, held starts and pending opens are memory. Task tabs are `localStorage`.
  A task that finds it needs a column stops and tells the orchestrator, and the migration goes last.
- **Contracts:** `pnpm --filter @10db/contracts generate` after every new schema, with the output committed.
- **Decision record:** `docs/architecture/decisions/./2026-11-16-do-it-hands-a-chat-to-a-task-or-a-pass-of-one.md`,
  amending M6's record. It covers the order (seal last), the whole-project page and its hazards, stacking, no copy
  on `local`, the brief and its fallback, Task tabs in the window, and B10.

## Tasks

Each is red first (watch it fail for the reason named), then green, then committed, naming its paths. Run only
`pnpm exec vitest related --run --maxWorkers=2 <files>`, `tsc --noEmit -p`, and eslint on what changed.
Delivery tests use `-c vitest.delivery.config.ts`. Every git fixture sets `maintenance.auto=false`, `gc.auto=0`
and `receive.autogc=false`. Each commit that adds a tested behavior carries its value card.

### Task 0: Starting point

- [ ] Merge `main` after M6a lands. Run `pnpm install`.
- [ ] Read the `AGENTS.md` of `chat/`, `conversation/`, `folder-hold/`, `pass/`, `delivery/`, `guard/`, `runner/`,
  and desktop's `sessions/` and `workbench/`.

### Task 1: Contracts

**Files:**
- `packages/contracts/src/page-areas.ts`: `WHOLE_PROJECT_PAGE`
- `chat-tools.ts`: `WriteBrief` and its input
- `chat.ts`:
  - `DoItRequest {place, title, brief, whenBusy?}`
  - `DoItPreviewDto`, `DoItResult`, `BriefRequest`
- `conversation.ts`: the `HandedToNotice {kind: 'handed_to', taskId, title, place}` member of `notice`
- `folder-hold.ts`: `FolderDto.pendingOpen`
- `passes.ts`: `PassOpenRequest.whenBusy`, and `PassViewDto.wholeProject`
- `task-session.ts`: `TaskSessionDto`, which carries:
  - the task, its place and branch, and its Board state
  - `conversationId | null`
  - `fromChat {chatId, title} | null`
  - `passId | null` and `workstreamId | null`
  - the pull request
- `workstream-changes.ts`: `ChangesScope` (`all` | `last`)
- regenerate

**Test (rung 1):** schema rows:
- a request without `whenBusy` parses
- a brief over the cap is refused
- `WHOLE_PROJECT_PAGE.name` fails `AreaName`, which is the point
- an old notice body still parses

Value: protects=Do It's shapes and the reserved page name; fails_when=a project area can collide with the synthetic
page or old notices stop parsing; why_new=no Do It schema exists; no_claim=any route.

### Task 2: `passAreasOf`

**Files:** `packages/db/src/store/passes.ts` (`passAreasOf`, `isWholeProjectPass`, and `passPageAreas` on them),
`store/tasks.ts` (`insertWholeProjectTask`), and tests.

**Test (rung 2, real SQLite):**
- an ordinary pass reads the project's areas
- a pass whose task names the page reads `[WHOLE_PROJECT_PAGE]`, and `passPageAreas` is its name
- `insertWholeProjectTask` stores the brief, `made_by_pass_id`, `shared` and the area, with no
  `refuseUnknownAreas` refusal

Value: protects=one answer to which areas a pass's rules read; fails_when=a pass of one reads the project's pages, or
an ordinary pass reads the synthetic one; why_new=`passPageAreas` reads project areas only; no_claim=its readers.

### Task 3: The judge, claims and kept work read `passAreasOf`

**Files:** `runner/runner.ts` (judge input), `mcp/tools.ts` (commit tool), `scheduler/scheduler.ts` (claims),
`delivery/pass-open.ts` `startPassTasks`, `pass/kept-work.ts`, `pass/shared-hold.ts`, `pass/move-copy.ts`
(`passHazardAsk` → `slow` for a whole-project pass), and tests.

**Test:**
- **rung 1, `guard/judge.test.ts`** (rows, with the whole page held and `deps` and `migrations` hazards):
  - `src/a.ts` is allowed
  - `pnpm-lock.yaml` is refused naming `deps`, and allowed once `deps` is held
  - `.git/config` and a gitfile are refused
  - an ordinary pass's rows are unchanged
- **rung 4, `pass/kept-work.test.ts`** (real git): a turn of a pass of one keeps `src/a.ts`, and leaves an unheld
  hazard's lockfile out
- **rung 2, `pass/move-copy.test.ts` (new; `passHazardAsk` has no test of its own):** a whole-project pass on a
  PR project answers `slow`, and an ordinary pass's `move` row stays

Value: protects=a whole-project page writes every file but hazards keep their claims; fails_when=a lockfile is
written or kept without its hazard, or a pass of one gets a Move card; why_new=the judge rows cover area pages
only; no_claim=the open.

### Task 4: The other readers

**Files:** `pass/view.ts` (the label "Whole project"), `pass/abandon.ts`, `delivery/pass-review.ts`,
`runner/turn-checks.ts`, `runner/check-targets.ts`, `pass/join.ts` (refuses Add Page), and tests.

**Test (rung 2):**
- the view's one page reads "Whole project"
- Add Page on a pass of one is refused with the words
- a review finding's target is the one page
- an ordinary pass is unchanged (existing rows stay green)

Value: protects=a pass of one reads as one page everywhere; fails_when=a reader falls back to project areas and
names no page or lets a second page join; why_new=each reader read project areas; no_claim=judge rules (Task 3).

### Task 5: `openPass` opens a pass of one

**Files:**
- `delivery/pass-open.ts`:
  - `wholeProject` input
  - `refuseOpen` without the page rules
  - the whole-project task and the chat's `task_id`, `pass_id` and notice, in the open's write
  - the brief delivered as the first message after the write, through `PassOpenDeps.firstMessage`
- `git/git.ts`: `BISECT_LOG` in `OPERATIONS_IN_PROGRESS`
- `test/pass-world.ts`, and tests

**Test (rung 4, real git, through `test/git-wrapper.ts`):**
- a project with no page area opens a pass of one
- the branch is at HEAD, and the return branch and start are recorded
- a dirty file is recorded as dirt
- the chat row has `task_id` and `pass_id`
- a refused write (a return branch under `10db/`) leaves no task, no chat link and no branch
- an open mid-bisect is refused in git's words (Start Pass gains this too)

Value: protects=a pass of one opens atomically on any project; fails_when=it needs a page area, leaves a task or
link behind on a refusal, or opens mid-bisect; why_new=`openPass` takes page tasks only; no_claim=the chat's turn.

### Task 6: The open waits for the folder, and B10's daemon side

**Files:**
- `folder-hold/hold.ts`: the `lanesWait` option on `reserveGitWhenFree`, whose `freeing` entry then counts for
  `LaneStart`
- `delivery/pass-open.ts`:
  - `waitForFolder: AbortSignal` → `reserveGitWhenFree` in the Cut job
  - `refuseOpen` again after the wait
- `pass/pending-open.ts`: one per project, with Cancel
- `folder-hold/view.ts`: `pendingOpen`
- the routes: `whenBusy` on Start Pass, and `DELETE /projects/:projectId/pending-open`
- tests

**Test (rung 2, `hold.test.ts`):**
- with a `lanesWait` entry pending, `blockers(LaneStart)` names it and a chat's take is refused (follow-up 4's row
  for a pass open)
- without the option, lanes are unchanged

**Test (rung 4, `delivery/pass-open.test.ts`):**
- an open that waits behind a chat's turn opens after the release
- Cancel rejects and leaves no branch
- a lane that starts while the open is queued behind another Cut job makes it refuse after its wait

**Test (rung 3, `app.request`):**
- `whenBusy: wait` answers `pending`, and the folder route shows it
- `stop_turns` stops the chat and opens

Value: protects=a pass open waits for a chat instead of failing, and nothing starts in the gap; fails_when=a lane
starts between the release and the open, or a cancelled wait leaves a branch; why_new=`openPass` only refuses a
busy folder; no_claim=Do It's own turn.

### Task 7: `engine.seal`

**Files:** `conversation/explore-engine.ts` (`seal(id)`: reduce `do_it`, await `settled`, end the session's row),
`explore-engine.test.ts`.

**Test (rung 2, real store, fake adapter):** a seal from `idle_warm` closes the session, from `running` stores
the partial, from `waiting_card` withdraws the card, and from `idle_cold` just seals. `taken_over` is refused. A
restart keeps `sealed`. The owner hears `onState(sealed)` once.

Value: protects=a sealed chat has no live session and gives its hold back; fails_when=a seal leaves a warm session or
its token alive; why_new=the reducer's `do_it` has no caller; no_claim=Do It's order.

### Task 8: `write_brief` and the brief

**Files:**
- `chat/tools.ts` (`write_brief`), `chat/briefs.ts`, `chat/brief.ts` (`briefFromChat`)
- `chat/tool-policy.ts` (`R`)
- `mcp/chat-tools.ts` (the description: a title, and a brief another agent works from, changing nothing)
- `chat/service.ts` (`brief(chatId, draft?)`)
- `POST /chats/:chatId/brief`
- tests

**Test:**
- rung 1, `brief.test.ts`: `briefFromChat` with and without a last message, and its cut
- rung 2, `test/chat-world.ts`:
  - a fake turn calls `write_brief`, and the preview's brief is the agent's
  - after 60 s on `ManualClock` with no call, it is the chat's
  - a paused account falls back at once
  - the send is `read_only`, so no hold is taken
  - a call from an older session is refused

Value: protects=the sheet always gets a brief within 60 s and only from the chat's live session; fails_when=no
fallback, or the brief turn takes the folder; why_new=no brief exists; no_claim=Do It.

### Task 9: The preview

**Files:** `git/git.ts` `changedEntries(repo, max)`, `chat/do-it.ts` `preview`, `GET /chats/:chatId/do-it`,
tests.

**Test:**
- rung 4, `git.test.ts`: M, A, D, R and `?` letters; the cap and `more`; no filter or fsmonitor runs (a marker)
- rung 3:
  - `here` is refused naming a lane, an open pass and a takeover, each with its link
  - another chat's turn gives `whenBusy` options
  - a closed pass gives `stacksOn`
  - a `local` project has no copy, and says why
  - mid-merge refuses `here`

Value: protects=the builder sees what happens to their files and why a place is refused before Do It;
fails_when=a refusal comes only at submit or files are hidden; why_new=`changedPaths` has no letters and nothing
previews Do It; no_claim=the submit.

### Task 10: Do It in a separate copy

**Files:**
- `chat/do-it.ts` (`doItCopy`, `finishSeals`), `chat/service.ts`
- archive refused while the chat's task is unfinished
- `daemon/start.ts`
- `POST /chats/:chatId/do-it`
- `test/do-it-copy.test.ts` (new, over `test/chat-world.ts` with a real git repo and the delivery harness)

**Test (rung 5):**
- **The real-git test:** a chat with uncommitted `notes.md` does it in a separate copy. The task's batch is cut
  in a worktree without `notes.md`, and `notes.md` stays in Your folder, unchanged.
- the chat is `sealed` and `hands_on`, its tab is closed, it has `task_id`, and the notice is stored
- a running turn is stopped first, and its partial is kept
- a refused start leaves the chat as it was, removes the task and runs the queue
- a restart between the write and the seal: `finishSeals` seals it
- row 17: the old token's `/mcp` call, `write_brief` and `commit_changes` are each refused after the seal
- archive is refused while the task runs

Value: protects=a separate copy starts once, leaves Your folder alone and leaves one writer per session;
fails_when=the chat survives as a writer, the copy takes the dirt, or a failed start seals the chat;
why_new=nothing hands a chat to a task; no_claim=the tab.

### Task 11: Do It Here

**Files:** `chat/do-it.ts` (`doItHere`), the route's `here` branch, `test/do-it-here.test.ts` (new, over
`test/chat-world.ts`, `test/pass-world.ts` and `test/fake-gh.ts`).

**Test (rung 5, real git):**
- **On a feature branch:** the pass's return branch is `feature`, and the chat's queued message runs reading only
  with the notice
- **On base, on a PR project:** after Sign Off and Close Pass, a PR is opened against `main` (fake `gh`), and
  `main` fast-forwards when it merges (`pr-watch` reads it as merged)
- **On base, on a `local` project:** `main` fast-forwards at the close
- **Refused mid-merge** (and mid-bisect): nothing stops, there is no branch, and the chat's turn goes on
- **After the close:** HEAD is on the return branch, the working tree holds the work and no dirt is left over, and
  the commit is the signed-off turn's
- **Abandon (row 20):** the builder's earlier uncommitted file is back as it was
- **The release race:**
  - own turn running → the open waits for `pendingReleases`, then opens
  - a Your-folder lane queued during the turn doesn't start before the open
  - the deadline passing refuses, and `releaseStarts` runs
- **The settle race:** a closed pass's settle and Do It Here run one after the other, and the new pass stacks
- another chat's turn → refused, naming it; `stop_turns` opens

Value: protects=Do It Here opens only after every writer is out, on any branch and delivery, and lands as a pass
lands; fails_when=it opens under a turn or lane, mid-merge, or the close leaves HEAD or the tree wrong;
why_new=passes are opened only from the Workbench with no chat; no_claim=the views.

### Task 12: Changes and the task's session

**Files:**
- `delivery/workstream-changes.ts`: `scope`. `all` on a pass task runs from the pass's `startSha` to the task's kept
  tip; `last` is today's answer. A separate copy's `all` is today's `baseHead` to head.
- `?scope=` on `GET /workstreams/:id/changes`
- `GET /tasks/:taskId/session` → `TaskSessionDto`
- `test/workstream-changes-api.test.ts`, `test/pass-api.test.ts`

**Test (rung 4, through `app.request`):**
- two kept turns: `all` shows both and `last` the second
- a separate copy's `all` matches today's
- the session DTO's `fromChat`, `passId` and place for both kinds

Value: protects=Changes shows every turn or the last on a pass of one; fails_when=All Turns drops a turn or reads the
folder's dirt as the task's; why_new=the route shows one kept commit only; no_claim=the panel.

### Task 13: The Do It sheet, and the fourth choice (B5, B9)

**Files:**
- desktop `views/sessions/do-it-sheet.tsx`, `do-it-words.ts`
- `session-bar.tsx`: **Do It…** as a `SplitButton`, whose menu holds File as Tasks; disabled in `taken_over`
  with "Hand back first"
- `session-keys.ts`: ⌘⇧↩
- `conversation/composer.tsx`: `ComposerHeld.onDoItSeparately`, a fourth choice that opens the sheet on Separate
  copy with the draft
- `daemon/chat-queries.ts`
- tests

**How it behaves:**
- The sheet follows UI spec §8.1, with the words in `do-it-words.ts`.
- **Where** is the Board's `placement-choice.tsx`.
- **The brief** shows "Writing the brief…" until it fills, and a dimmed line when it is the chat's.
- **Refusals** are disabled rows with their link.
- **A submit refusal** shows in red beside Do It.
- **On success,** Separate copy replaces the chat's tab with a Task tab, and Here opens one to the chat's right.

**Test (rung 3, `renderWithDaemon`):**
- each place's words
- the file list's Show N More
- a refused Here
- the fallback line
- typing stops the brief
- ⌘↩ submits
- the fourth choice opens the sheet with the draft in the request
- axe passes

Value: protects=the builder sees place, files and fate before Do It; fails_when=a refused place can be picked or a
submit error loses the brief; why_new=no sheet exists; no_claim=the tabs.

### Task 14: Task tabs and the handover (B6)

**Files:**
- `views/sessions/task-tabs.ts` (pure functions over `tendb.sessions.tasks`, as `fresh-tabs.ts` does)
- `strip-tabs.ts` (`{ kind: 'task' }`)
- `session-tab.tsx`: the `folder` and `git-branch` glyphs
- `sessions-search.ts` (`?task=`), `task-tab.tsx`, `task-bar.tsx`
- `chat-entries.ts`: the `handed_to` row, "Started a task: … · Separate copy · Open"
- the sealed chat's read-only line, with Open Task
- `closed-tabs.ts` (task tabs join the stack)
- `open-session.ts` (Inbox: a whole-project pass's cards, and a separate copy's, open the task's tab)
- tests

**The separate copy's tab:**
- "From chat: {title}" first, then the task's description as the builder's first row, then the task's thread
  (`ConversationList` over `TaskSessionDto.conversationId`, with `useConversationLive`)
- the run's live line; the Board state in the bar: "Task · Separate copy · `10db/…`"
- the composer only while the run runs: "Messages reach this task while it runs."
- Finished: "Finished · in review: pull request #n · CI running", with Open on Board and Open Pull Request

**Test (rung 3, `renderWithDaemon`):**
- a hands-off replaces the chat's tab at its place
- the sealed chat opens read-only with Open Task
- the Inbox card opens the task's tab
- ⌘⇧T brings back a closed task tab
- a cleared store still reaches the task from the chat's row

Value: protects=the task takes the chat's place and both stay reachable; fails_when=the strip loses the task or the
sealed chat can be written to; why_new=tabs are chats only; no_claim=the pass's controls.

### Task 15: The pass-of-one tab (B7)

**Files:** `views/sessions/pass-tab.tsx`, `pass-tab-bar.tsx`, and the Workbench's `page-thread.tsx`,
`page-composer.tsx` (Sign Off), `page-ask.tsx`, `retry-turn.tsx`, `pr-button.tsx`, `close-pass-modal.tsx`,
`close-progress.tsx`, `abandon-modal.tsx` and `closed-pass-line.tsx`, used as they are. Also
`workbench-view.tsx` (a live pass before the setup check), and tests.

**What it shows:**
- the bar: "Task · Your folder · lands on `main`"
- Close Pass… once something is signed off, and the filled primary when nothing works
- Abandon Pass… in `⋯`
- the close's lines, then "Done · `main` is at `abc1234`."
- the chat's kind line reads the pass (M6a)

**Test (rung 3):**
- Ready with nothing typed makes Sign Off the primary
- typing makes Send the primary
- Close Pass… opens the pass's modal
- a closed pass shows its line
- the Workbench lists the pass of one as "Whole project" on a project with no page area

Value: protects=a pass of one lands from its tab exactly as a pass does; fails_when=a control is missing or the
Workbench hides it; why_new=the controls live in the Workbench only; no_claim=e2e (Task 18).

### Task 16: The Changes panel (B8)

**Files:** `views/sessions/changes-panel.tsx`, `changes-files.ts`, ⌘⇧D, and tests.

**How it behaves (UI spec §9):**
- "Changes +41 −6" in the bar, for Task tabs only
- it opens by itself once, at 1100 px or wider, and the builder's choice then holds per tab
- the header names the base; a pass of one gets All Turns · Last Turn
- the jump list, and the diffs through the kit's `hunk-diff.tsx` (unified, or split from 720 px)
- clicking a line number quotes the line into the composer
- "No changes yet."

**Test (rung 3):**
- the scope toggles the query
- the first open happens once
- the quote lands in the draft
- a Chat has no Changes

Value: protects=the builder reads a task's diff beside its thread; fails_when=Changes shows on a chat or Last Turn
reads All; why_new=no panel; no_claim=diff rendering (the kit's).

### Task 17: B10 in the Workbench and the sheet

**Files:** `views/workbench/start-pass.tsx`, `do-it-sheet.tsx`, `views/sessions/pending-open-line.tsx`
("Opens when the chat ‘X’ ends its turn · Cancel", on the Workbench and the chat's bar), and tests.

**Test (rung 3):**
- a chat holder offers both buttons
- a lane offers neither
- Open When It Ends shows the line, and Cancel posts the delete
- the pending line goes when the folder route drops it

Value: protects=a refusal by a chat's turn has a one-click way out; fails_when=the offers show for a lane or
takeover, or a wait can't be cancelled; why_new=the refusal had only words; no_claim=the daemon's wait.

### Task 18: e2e, click-through, then review

**Files:** `apps/desktop/e2e/sessions.spec.ts`, `script-book.json`.

**Test (rung 5, real daemon, fake sessions):** on a `local` project with no gate command, as `workbench.spec.ts`
sets one up:
1. A chat's turn commits the builder's edit (`commit_changes`), as M6a's e2e does, since the e2e daemon runs no
   sandbox.
2. **Do It…**: the sheet lists the uncommitted file; pick Your folder, as a pass; Do It.
3. The pass's tab opens to the right. Its first turn (scripted) edits a file and is Ready.
4. Sign Off: "Signed off · landed as …".
5. Close Pass…, then Close: the close's lines, then "Done · `main` is at …". The folder is back on `main` with the
   commit.
6. The chat's line reads "Chat · Your folder · on `main`" again.

**After that:**
- Click through by hand against the real daemon (`/browse`): both places, a refused Here, Open When It Ends, Changes,
  and a separate copy's tab on a PR project, in dark and light.
- Then the code review of Tasks 13–17. Rounds converge as in `.claude/agents/code-reviewer.md`.

Value: protects=chat → Do It Here → turn → Sign Off → close through the daemon and UI; fails_when=any seam breaks;
why_new=no e2e hands a chat to a task; no_claim=Claude or Codex themselves.

### Task 19: Adversarial review (B12)

Dispatch `code-reviewer` (opus) on Tasks 1–12 with M6's security table and rows 15–21 above. It attacks:
- the whole-project page (hazards, `.git`, agent config, kept work)
- the sealed chat's late calls
- the brief
- Do It Here's races
- the separate copy's worktree, and that the chat's dirt doesn't travel

Findings that block are fixed in at most two rounds.

### Task 20: Live checks

Record the results in the PR, never in CI. `apps/daemon/test/do-it.live.test.ts` runs on
`live-chat-daemon.ts`, in a real repository outside every temp root.

| Check | Account | What to show |
| --- | --- | --- |
| LC6 | Claude plan | the brief turn calls `write_brief`, reading only, within 60 s |
| LC7 | Codex | the same through 10db's `/mcp` (needs the builder's ChatGPT sign-in, as LC3; written and left waiting if absent) |
| LC8 | Bedrock or API key | Do It Here: the page's first turn edits; Sign Off lands it |

### Task 21: Docs

- the decision record, which amends M6's record
- sessions spec §7.3:
  - the page key
  - stacking
  - no copy on `local`
  - the seal's order
  - hazards in a pass of one
  - B10
- UI spec §5.2 (Task tabs in the window), §8.1 (the brief fills when the call lands; `local`), §8.2 (New Chat From
  This deferred), §9 (`scope`)
- roadmap: M6b's row and plan
- `AGENTS.md` notes: `chat/`, `conversation/`, `folder-hold/`, `pass/`, `delivery/`, desktop `sessions/` and
  `workbench/`
- `docs/security.md`: rows 15–21

## Follow-up tasks to file

- New Chat From This: a fresh chat seeded from a sealed chat's digest.
- A Task tab kept by the daemon rather than the window, if the builder wants tabs to follow them across windows.
- Open When It Ends that survives a restart.
- The brief streaming into the field as the agent writes it.
