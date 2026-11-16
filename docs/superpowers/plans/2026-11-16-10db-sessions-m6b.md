# Sessions M6b: Do It, Changes, a pass of one, and the tab handover

## Brief

**What changes for you.** A chat's session bar gains **Do It…** (⌘⇧↩). Its sheet shows a title, a brief, where the
work goes, and the files you've left uncommitted in Your folder with what happens to them. Between turns the chat's
agent writes the brief; if it hasn't in 60 seconds, or the chat is mid-turn, the brief is the chat so far plus your
last message. You can edit it either way.
- **Separate copy:** an ordinary task in its own copy, from your base branch, landing by your delivery. It takes
  the chat's tab, and the chat becomes read-only. Your uncommitted files stay in Your folder.
- **Your folder, as a pass:** a pass of one, whose one page is "Whole project", in its own tab beside the chat, with
  Sign Off, Close Pass… and Abandon Pass…. The chat stays open and reads only while the pass holds the folder. Your
  uncommitted files become the task's work; Abandon puts them back as they were.
- **A message sent while the folder is held** gets a fourth choice: Do It in a Separate Copy.
- **A pass refused because a chat is mid-turn** (Workbench or sheet) offers **Stop the Turn and Open** and **Open
  When It Ends**.
- **A task's tab has Changes** (⌘⇧D); a pass of one adds All Turns and Last Turn.

**What it buys.** "Knock this out" goes from the conversation to a task without retyping: a brief, its own branch
and your delivery, or the pass's kept turns and one pull request.

**What could go wrong, and how we'd know.**
- **Do It Here racing another writer.** It stops the chat's own turn and opens only once that turn has given the
  folder back; meanwhile new chat turns read only and tasks' first starts wait. Real-git tests cover a feature
  branch, base on a PR and a `local` project, mid-merge and mid-bisect, the state after the close, and Stop pressed
  during Do It.
- **A whole-project page.** Lockfiles and migrations still need their hazard, and its writes raise no stray-write
  cards. Judge, kept-work and watcher rows prove it; the adversarial review attacks it.
- **A sealed chat writing later.** Every late call from it is refused, with a test.
- **A wrong brief.** You read and edit it first, and the task never resumes the chat's session.

**Calls you might disagree with (11):**
1. **A pass of one stacks on a closed pass** waiting for its pull request, as Start Pass does. M6 said refused.
2. **No separate copy on a `local` project:** it has no copies. The sheet says so and picks Your folder.
3. **A pass of one runs migrations and deps in Your folder** with their claim, without the Move card.
4. **The seal is Do It's last step.** A failed start leaves the chat as it was; recovery finishes a cut-short seal.
5. **The copy's areas are what the chat changed** (its edits and your uncommitted files, by area), else the
   catch-all; the agent may name them and the criteria in its brief. Cost if wrong: too few, and the lane waits on
   another task's claim when it asks for more; too many, and other tasks wait on it.
6. **The brief is asked only between turns.** Mid-turn, waiting on a card or waiting for the folder, the sheet
   takes the chat-so-far brief at once, and never stops your turn. Once you type, a late agent brief doesn't
   replace your text. The brief turn reads only, so a warm writing session reopens (a few seconds).
7. **A Task's tab lives in the window** (`localStorage`), so no migration. A cleared store loses the tab, never the
   task: the Board, the Workbench, the Inbox and the chat's row reopen it.
8. **New Chat From This is a follow-up.** The sealed chat offers Open Task.
9. **A pass is "of one" because its task names the synthetic page**, not `chats.pass_id`, which a later Do It Here
   rewrites.
10. **Open When It Ends** keeps the project's delivery slot while it waits, one per project; a restart or a 10db
    update cancels it.
11. **Start Pass also refuses mid-bisect.**

**Needed from you:** nothing. No migration. Reply to approve.

---

> **For agentic workers:** REQUIRED SUB-SKILL: superpowers:subagent-driven-development (or executing-plans). Steps
> use `- [ ]`. Read the M6 plan's Design first (`docs/superpowers/plans/2026-11-15-10db-sessions-m6.md`); this plan
> extends it and repeats none of it. `folder-hold/hold.ts`, `hold.test.ts` and `folder-hold/AGENTS.md` are shared
> with M7: whichever plan lands first carries the handover and the signal rule below, and the other cites them.

**Goal:** Do It hands a chat's work to a task, in a separate copy or as a pass of one in Your folder, on every
account kind; a task's tab shows its thread and Changes and lands the task.

**Spec:** sessions design S3, S15, S16, §6.7, §7.1, §7.3 (Do it), §7.4; sessions UI §5.2, §8, §9, §14; roadmap
"### M6"; decisions `2026-11-14-abandon-pass-deletes-unsigned-pages-work.md`,
`2026-11-09-a-close-fast-forwards-the-folders-branch.md` and M6's record.

**Starting point:** `feat/sessions-m6b` at 0f77887f. Merge `main` once M6a lands, before Task 1.

## Design

### Do It, in order

`chat/do-it.ts` (new) owns both places. `POST /chats/:chatId/do-it` takes `{ place, title, brief, areas?,
acceptanceCriteria?, whenBusy? }`. Before anything: `taken_over` ("Hand back first"), `sealed` and archived are
refused, and **a per-chat in-flight guard** (`doing: Map<ChatId, place>`) refuses a second Do It ("Do It is
already under way for this chat"), from a double submit or another window. While Do It is in flight:
- **Stop** answers at once and changes nothing: the turn is already stopping and its starts stay held.
- **Redo and archive** are refused with the guard's words.
- **A send** to a chat doing a separate copy is refused ("This chat is handing its work to a task"), so nothing is
  left parked in a sealed chat. During Do It Here it queues, held, and runs reading only after the open.
- **The guard ends when the route answers.** It also covers each chat Stop the Turn and Open stopped, until the open
  is done, so their Stop can't release their starts before the open's `freeing` entry exists.
- **A pending Open When It Ends names its chat.** While it does, Do It in either place and archive are refused for
  that chat ("A pass is waiting to open for this chat; Cancel it first"); Stop and sends are normal.

**Separate copy (`place: worktree`):**
1. **Refused on a `local` project** ("This project lands locally, so it has no separate copies").
2. **The turn stops:** `engine.holdStarts(conv)` (so `stop_settled` sees no queue and nothing chains),
   `folderHold.cancelWait`, `engine.stop`, `settled`.
3. **The task** goes through `services.createTask`, which requires areas and criteria (`TaskInput`), from base:
   - **areas:** the brief's, each a project area (else refused, naming it); without them, `areasOfChat`
     (`chat/chat-areas.ts`): `classifyPath` (`guard/paths.ts`) over the chat's edit rows' paths and the folder's
     uncommitted paths, deduplicated; with none, the project's catch-all area, else its first area. The lane asks
     for more with `request_claim`, as any lane does.
   - **criteria:** the brief's, else "Does what the brief asks, and the project's checks pass."
   - the brief as `description`, `workspaceMode: worktree`, a `chat_tasks` row. Then `services.settleSizing`.
4. **In one synchronous run:** a write sets the chat's `mode: hands_on` and `task_id`; then
   `services.startTask(taskId)`; then a write stores the `handed_to` notice and sets `tab_position: null`, so the
   sheet stays mounted for a refused start. If the start throws, the first write is undone, the task removed
   (`removeTask`) and `releaseStarts` runs; the refusal reaches the sheet.
5. **The seal:** `engine.seal(conv)` reduces `do_it`, closes the session and ends its row, so its token reaches
   nothing. `onState(sealed)` gives the hold back (M6a).
6. **The answer** is `{ taskId, place }`; the desktop puts a Task tab where the chat's was.

`finishSeals` (after `engine.recover()` in `daemon/start.ts`) seals any `hands_on` chat whose conversation is not
`sealed`, starts its task if it has no run (a refused start shows as the tab's Board state), and stores a missing
`handed_to` notice with `tab_position: null`.

**Here (`place: here`):**
1. **Refusals, named, each with a link,** before anything stops:
   - `refuseOpen` (page rules aside): an open or closing pass, an unfinished batch, lanes in the folder;
   - `blockers(project, GitWork)` less this chat's own turn and wait: a takeover, another chat's turn (unless
     `whenBusy`, below), 10db's git work. `openPass`'s pre-queue `inUse` check takes `except: chatId`;
   - a pending open for the project ("A pass is already waiting to open: ‘X’");
   - the folder: `operationInProgress` (now with a bisect), a detached HEAD, `returnBranchProblem`.
2. **The turn stops** as in the copy's step 2 (its own wait cancelled; the message stays queued).
3. **`services.openPass` with `wholeProject`.** Its job, on the Your-folder queue (`jobKey` with
   `worktreePath: null`, which Cut and Ship share), waits with `reserveGitWhenFree(…, { lanesWait: true, signal })`,
   where `signal` is `AbortSignal.any` of the job's signal and a deadline of `STOP_GRACE_MS +
   JOBS_STOP_DEADLINE_MS + 5 s`; `jobs.stop()` at shutdown aborts it. `refuseOpen` runs again after the wait.
   - The open's write makes the task (`insertWholeProjectTask`), sets the chat's `task_id` and `pass_id`, adds a
     `chat_tasks` row and stores the `handed_to` notice, so a refused write leaves none of them.
   - The brief reaches the page through the one existing path: `services.openPass` posts each task's
     `description` as its first builder message (`daemon/services.ts`, after `deps.openPass`).
4. **`releaseStarts`** follows, refused or not. What is queued runs reading only while the pass holds.

**B10: a refused open with chats mid-turn.** `whenBusy` is offered only when every keeping-out holder is a chat's
turn; Start Pass (`POST /projects/:projectId/passes`) takes it too.
- **`stop_turns`:** step 2 for each holding chat, then the open as above, then `releaseStarts` for each.
- **`wait`:** answers `{ pending: true }` at once. `pass/pending-open.ts` keeps one per project with its
  `AbortController`; Start Pass and Do It Here are refused up front while it exists, so nothing queues behind it
  with a hanging request. The job's wait takes `AbortSignal.any([jobSignal, pending.signal])`. The update drain
  cancels it ("Cancelled for 10db's update"), so self-update's `jobs.pending()` never waits on it; a restart drops
  it. `FolderDto.pendingOpen` is `{ name, waitsFor } | null`; `DELETE /projects/:projectId/pending-open` cancels.
  The requesting chat's starts are released once its own turn has given the folder back, not held through the
  wait: its queued messages then read only while the open's `freeing` entry stands, or take the folder before the
  job runs, and the open waits for them too.

**The folder hold's two changes (shared with M7).**
- **Handover inside the wake.** `flushFree` reserves the git token for the oldest waiting entry that nothing keeps
  out (`gits.set`, `changed`) and resolves its promise with that token, so no take or start runs between the wake
  and the reservation; waiting git work goes first, in arrival order. `reserveGitWhenFree` returns that token.
- **`lanesWait`.** A `freeing` entry so marked counts for `LaneStart` too, since the pass is about to hold; the
  scheduler's `waitForFolder` shows its notice ("Waits for the pass ‘X’, opening") instead of returning early
  because every blocker is git work.
- **The rules:** every wait on the folder takes its delivery job's signal. A handed-over token whose signal has
  aborted by the time the caller resumes is released before `reserveGitWhenFree` rejects, so an abort in the same
  tick as the handover (Cancel, the deadline, `jobs.stop()`, the update drain) leaves no git holder. Every caller
  wraps everything after the await, its re-checks included (the open's `refuseOpen`), in
  `try { … } finally { releaseGit(token) }`, so a throw never leaves an unowned `git_work` entry.

**The brief.** `POST /chats/:chatId/brief {draft?}`:
- **Between turns only** (`idle_cold`, `idle_warm`, `ended_error`, with no folder wait): it sends, with
  `folder: read_only`, a message whose body carries `purpose: 'brief'`: "Write the brief for a task that does the work we agreed on,
  with its title, areas and acceptance criteria, and call write_brief. Change nothing." (and "Include this request:
  {draft}" when set). Being idle, `chooseReadOnly` applies, so the turn never runs on a writable hold.
- **Otherwise** (starting, running, waiting on a card, stopping, waiting for the folder, `paused_account`): no send;
  the brief is `briefFromChat` at once, with `reason: mid_turn` or `paused`. The builder's turn is never stopped.
- **`write_brief {title, brief, areas?, acceptanceCriteria?}`** (`brief` capped at `TASK_MESSAGE_MAX_CHARS`, at most
  8 areas and 8 criteria) keeps it in memory (`chat/briefs.ts`) and emits `ChatChanged`. A call from a session that
  is not the chat's open one, or after the seal, is refused.
- **After 60 s** on the injected clock with no call, the brief is `briefFromChat` (`chat/brief.ts`): the chat's
  messages and replies, cut as `chatDigest` cuts (12,000 characters), then "The builder's last message: …", cut so
  the whole fits `TASK_MESSAGE_MAX_CHARS`. Both, and `chatDigest`, leave out every `purpose: 'brief'` message and the
  agent's items of the turn it began, so no earlier request (cancelled, expired or before a restart) leaks "Change
  nothing" into a brief or a fresh session.
- **A brief turn never chains.** Cancel posts `DELETE /chats/:chatId/brief`, which stops the turn if it is still the
  brief's; a builder send while one runs stops it first, then runs as its own turn, taking the folder if free.
- **Lifetime:** kept per chat until Do It succeeds or 30 minutes pass; a restart drops it.
- **The sheet** stops taking the daemon's brief once the builder types in the field; typing stops nothing.

**The preview.** `GET /chats/:chatId/do-it` → `DoItPreviewDto`: the brief (`{ title, text, areas, criteria,
source: agent | chat | null, reason, writing }`); `changed`, at most 200 `{ path, status: M | A | D | R | ? }` and
`more`, from a new `Git.changedEntries` (private index, as `changedPaths`); per place `offered` and `refusal: { code,
message, link } | null`; `runningTurn`; `stacksOn`; and for the copy `base` and `leftOut`, the commits HEAD has that
origin's base lacks ("Starts from `main`. The 2 commits on `feature` that `main` lacks stay out of it.").

### A pass of one

- **`WHOLE_PROJECT_PAGE`** (`@10db/contracts`, `page-areas.ts`): an `AreaDef` named `10db-whole-project`, which
  `AreaName` can't spell, so no project area or hazard shares it; globs `WHOLE_REPOSITORY_GLOBS`, role `page`, label
  "Whole project". Never saved in `projects.areas`. `areaLabel(name, areas)` gives every view its label.
- **`passAreasOf(db, passId)`** (`@10db/db`, `store/passes.ts`) is `[WHOLE_PROJECT_PAGE]` when a task of the pass
  names it, else the project's areas; `isWholeProjectPass` reads the same; `passPageAreas` builds on it.
- **Every reader of a pass's areas** takes `passAreasOf`:
  - the lane's judge input (`runner/runner.ts`, `areas` and `inPass.pages` near `judgePreToolUse`) and the commit
    tool's (`mcp/tools.ts`)
  - claims (`scheduler/scheduler.ts` near `passHeldAreas`; `startPassTasks`)
  - kept work (`pass/kept-work.ts` `pageClaims`, `pageMatcher`), `pass/shared-hold.ts`
  - the watcher, which classifies by `project.areas` today, so every page write would be a stray: `watcher/strays.ts`
    (`findStrays`, `findClaimed`, `findForeignClaimWrites`), `watcher/pass-writes.ts`, `watcher/watcher.ts`'s
    classifications, and `runner/runner.ts` `claimedChanges` read `passAreasOf` for writes under Your folder's root
    while a pass holds it; a copy's root keeps `project.areas`, so a copy's writes are judged as today
  - review and checks (`delivery/pass-review.ts`, `runner/turn-checks.ts`, `runner/check-targets.ts`)
  - labels (`pass/view.ts`, `pass/abandon.ts`); Add Page (`pass/join.ts`) refuses: "A pass of one holds the whole
    project"
- **Hazards keep their rules.** The judge checks a hazard after the page (`judgeRelative`). `pageMatcher`'s "a hazard
  counts only outside the pass's pages" doesn't apply to a whole-project pass: a hazard path is page work only with
  its claim, else it goes to the close's "files no page owns". The watcher still cards a write outside every claim
  (an unclaimed hazard's file). `passHazardAsk` answers `slow` for a whole-project pass, and `pictures/preview-marks.ts`
  skips `askMoveToCopy` for one, so there is no Move card that would move the only page out.
- **Opening one.** `PassOpenInput.wholeProject: { title, brief, chatId }` replaces `taskIds` and `pages`;
  `refuseOpen` skips the page-area rule and `passPagesProblem`. `insertWholeProjectTask` (`store/tasks.ts`) skips
  `refuseUnknownAreas`, marks `made_by_pass_id`, stores the brief as `description`. Abandon retires it.
- **The Workbench** reads a live pass before its setup check, so a pass of one shows on a project with no page area.

### State × event table (extends M6's)

Columns: this chat's state, then the folder's other holders. "Rel." is M6a's release (jobs stop, then
`releaseTurn`).

| Event | own turn running, chained or on a card | own message parked | free, or a closed pass | lanes | open or closing pass | another chat's turn | takeover (M7) |
| --- | --- | --- | --- | --- | --- | --- | --- |
| **Do It Here** | `holdStarts`, Stop, `settled`; the open waits for rel. | `cancelWait` (stays queued); opens | opens; on a closed pass it stacks (`stackOn`) | refused (`refuseOpen`); Open on Board | refused; Open UI Workbench | refused, offering Stop the Turn and Open, Open When It Ends | refused; Open Session. Own: "Hand back first" |
| **Do It, separate copy** | `holdStarts`, Stop; task starts; sealed: rel. | `cancelWait`; sealed | runs | runs | runs | runs | runs. Own: "Hand back first" |
| Stop, during Do It | answered; nothing changes | the same | | | | | |
| Redo or archive, during Do It | refused: "Do It is already under way" | | | | | | |
| A send, during Do It | copy: refused; Here: queued, held, read only after the open | | | | | | |
| A second Do It (double submit, two windows) | refused by the in-flight guard; one task | | | | | | |
| Do It or archive while Open When It Ends names this chat | refused: "A pass is waiting to open for this chat; Cancel it first" | | | | | | |
| Stop on a chat that Stop the Turn and Open stopped | answered; its starts stay held until the open is done | | | | | | |
| Abort in the tick of the handover, or a re-check throws after it | the token is released; no `git_work` holder is left | | | | | | |
| A builder send while the brief turn runs, or Cancel | the brief turn stops; the send runs as its own turn | | | | | | |
| A copy's write in its worktree while a pass of one is open | judged against `project.areas`, as today | | | | | | |
| Stop the Turn and Open | n/a | n/a | n/a | n/a | n/a | each holder held and stopped; the open waits for every rel. | n/a |
| Open When It Ends | n/a | n/a | n/a | n/a | n/a | pending; new chat turns read only, first starts wait; opens at the last rel. | n/a |
| Start Pass or Do It Here while an open is pending | refused up front, naming it | | | | | | |
| Shutdown or 10db update while an open is pending | the job's signal aborts it; the drain cancels it, with a line | | | | | | |
| A lane's first start while an open waits | | | waits, "the pass ‘X’, opening" | n/a | n/a | waits | waits |
| A lane's first start while the open is queued behind other work | | | starts; the open refuses after its wait; `releaseStarts` | | | | |
| The brief asked | not sent; chat-so-far brief at once | the same | | | | | |
| The brief asked between turns | read-only turn, never on a writable hold | | | | | | |
| `write_brief` lands after the builder typed | kept, not shown over the typed text | | | | | | |
| The settle racing the open | One Your-folder queue runs them one after the other, and each reserves around its moves: the open stacks on what the settle left | | | | | | |
| Restart mid-Do-It | Memory goes: held starts, the pending open, the brief, the guard. An open's branch with no row is taken back (`pass-recover.ts`). A `hands_on` chat not `sealed` is sealed, and its task started if it has no run (`finishSeals`). A task created before the chat row's write stays on the Board, the chat as it was | | | | | | |
| The turn misses the deadline | the open refuses ("The chat's turn didn't stop in time"); `releaseStarts` | | | | | | |
| A pass of one closes or is abandoned | the chat's next turn writes again (M6a) | | | | | | |
| `write_brief` after the seal or from an old session | refused | | | | | | |

**Races, designed once:**
1. **Own release and the open.** The open's wait covers this chat's pending release (`pendingReleases`), and its
   `freeing` entry keeps chats out meanwhile.
2. **Release and a lane's start.** `lanesWait`, the handover inside `flushFree` and the scheduler's `STARTING`
   recheck leave no gap between a release and the open's reservation.
3. **Seal and start.** The task starts before the seal; the seal can't fail once `taken_over` is refused.
4. **Do It and the builder's own Stop.** The guard keeps Stop from releasing Do It's held starts.

### Follow-ups 3 and 4 from M6a's review

Both were fixed in M6a: the settle reserves only around its two moves (`movingBranch` in `pass-settle.ts`), and git
work that waits keeps new chat turns out (`freeing` in `hold.ts`). A pass of one's closed pass reserves nothing for
its pull-request reads, so 3 stays fixed. Do It Here leans on 4, so Task 6 adds its row. Neither blocks.

### Provider parity

| Feature | Claude plan | Bedrock / API key | Codex plan |
| --- | --- | --- | --- |
| `write_brief` | the chat's `/mcp` tool, in `allowedTools` | the same | 10db's `/mcp` through the guard hook |
| The brief turn | read-only profile | the same | read-only `permissions.lane` profile |
| Fallback | daemon | daemon | daemon; a paused ChatGPT plan falls back at once |
| Separate copy | a worktree task on the account's judge | the same | the same (worktree tasks run on Codex) |
| Pass of one | a pass lane | the same | the same (passes run on Codex) |
| Changes, tabs, sheet | daemon and desktop | the same | the same |
| Gaps | none | none | none new |

### Security table pass

M6's rows 1, 2, 6, 7 and 13 now also cover the pass-of-one lane (a pass lane); 12 covers the copy's batch branch and
the pass's branch; 14 is unchanged.

| # | Attempt | What stops it | Test |
| --- | --- | --- | --- |
| 15 | A whole-project page writes or keeps a hazard file without the hazard | the judge's hazard check; `pageMatcher` keeps it only with its claim | `guard/judge.test.ts`, `pass/kept-work.test.ts` rows |
| 16 | It writes `.git`, a gitfile, a protected path or agent config | lane rows 1–2; config loads only once its hash is approved (trust line §2) | judge rows, whole page held |
| 17 | A sealed chat calls later (background agent, old token, `write_brief`, a git tool) | the session row ends; `holdingSession`; git tools need `holdsTurn` | `test/do-it-copy.test.ts` |
| 18 | The brief smuggles instructions to the task's agent | the builder reads it first; lane rules; the cap | `chat/brief.test.ts` |
| 19 | Do It Here opens under another writer | `lanesWait`, the handover, `freeing`, the `STARTING` recheck, `refuseOpen` after the wait | `test/do-it-here.test.ts` |
| 20 | Abandon of a pass of one loses earlier uncommitted work | the Abandon puts dirt back (decision 2026-11-14) | `test/do-it-here.test.ts` |
| 21 | The file list or the brief floods the daemon or UI | 200 entries; the caps | `chat/do-it.test.ts` |
| 22 | A pass of one's writes hide among stray-write cards, or a stray hides in the whole page | the watcher reads `passAreasOf`; a write outside every claim is still carded | `watcher/strays.test.ts`, `watcher/pass-writes.test.ts` |
| 23 | The brief turn runs on a writable hold, or a builder message chains onto it | sent only between turns, `read_only`; a send or Cancel stops it first | `test/chat-world.ts` rows (Task 8) |
| 24 | An abort or a throw after the handover leaves an unowned `git_work` entry (every chat read only, every start waiting) | the release-before-reject rule and the callers' `finally` | `hold.test.ts`, `pass-open.test.ts` rows |

### Migrations, contracts and the decision

- **Migrations: none.** `chats.mode`, `task_id`, `pass_id` and `tasks.made_by_pass_id` exist
  (`packages/db/src/schema.ts`). Briefs, the guard, held starts and pending opens are memory; Task tabs are
  `localStorage`. A task that needs a column stops and tells the orchestrator; the migration goes last.
- **Contracts:** `pnpm --filter @10db/contracts generate` after every new schema, output committed.
- **Decision record** (Task 21): `2026-11-16-do-it-hands-a-chat-to-a-task-or-a-pass-of-one.md` in
  `docs/architecture/decisions/`, amending M6's record: the order and the guard, the copy's areas and criteria, the
  whole-project page and its hazards, stacking, no copy on `local`, the brief, Task tabs in the window, B10, and the
  hold's handover and its rules. It also says Do It's tasks get a `chat_tasks` row on purpose: Recent counts them as
  filed, the chat's `edit_task` reaches them, and `remove_task` on one no longer asks (`chatMadeTask` in
  `chat/tools.ts`), which is safe because Remove refuses a started task.

## Tasks

Each is red first (watch it fail for the reason named), then green, then committed, naming its paths. Run only
`pnpm exec vitest related --run --maxWorkers=2 <files>`, `tsc --noEmit -p`, eslint on what changed. Delivery tests
use `-c vitest.delivery.config.ts`. Git fixtures set `maintenance.auto=false`, `gc.auto=0`, `receive.autogc=false`.
Each commit adding a tested behavior carries its value card.

### Task 0: Starting point

- [ ] Merge `main` after M6a lands; `pnpm install`.
- [ ] Read the `AGENTS.md` of `chat/`, `conversation/`, `folder-hold/`, `pass/`, `delivery/`, `guard/`, `runner/`,
  `watcher/`, and desktop's `sessions/`, `workbench/`.

### Task 1: Contracts

**Files:** `packages/contracts/src/page-areas.ts` (`WHOLE_PROJECT_PAGE`, `areaLabel`); `chat-tools.ts`
(`WriteBrief`); `chat.ts` (`DoItRequest`, `DoItPreviewDto`, `DoItResult`, `BriefRequest`); `conversation.ts` (the
`HandedToNotice {kind: 'handed_to', taskId, title, place}` member of `notice`; `purpose?: 'brief'` on the message
body); `folder-hold.ts`
(`FolderDto.pendingOpen`); `passes.ts` (`PassOpenRequest.whenBusy`, `PassViewDto.wholeProject`); `task-session.ts`
(`TaskSessionDto`: the task, its place, branch and Board state, `conversationId | null`, `fromChat | null`, `passId`,
`workstreamId`, the pull request); `workstream-changes.ts` (`ChangesScope`); regenerate.

**Test (rung 1):** a request without `whenBusy` parses; a brief over the cap, or 9 areas, is refused;
`WHOLE_PROJECT_PAGE.name` fails `AreaName`; `areaLabel` says "Whole project"; an old notice body still parses.

Value: protects=Do It's shapes and the reserved page name; fails_when=a project area can collide with the synthetic
page or old notices stop parsing; why_new=no Do It schema exists; no_claim=any route.

### Task 2: `passAreasOf`

**Files:** `packages/db/src/store/passes.ts` (`passAreasOf`, `isWholeProjectPass`, `passPageAreas` on them),
`store/tasks.ts` (`insertWholeProjectTask`), tests.

**Test (rung 2, real SQLite):** an ordinary pass reads the project's areas; a pass whose task names the page reads
`[WHOLE_PROJECT_PAGE]`; `insertWholeProjectTask` stores the brief, `made_by_pass_id`, `shared` and the area without a
`refuseUnknownAreas` refusal.

Value: protects=one answer to which areas a pass's rules read; fails_when=a pass of one reads the project's pages or
an ordinary pass the synthetic one; why_new=`passPageAreas` reads project areas only; no_claim=its readers.

### Task 3: The judge, claims, kept work and the watcher read `passAreasOf`

**Files:** `runner/runner.ts` (judge input, `claimedChanges`), `mcp/tools.ts`, `scheduler/scheduler.ts` (claims),
`delivery/pass-open.ts` `startPassTasks`, `pass/kept-work.ts`, `pass/shared-hold.ts`, `pass/move-copy.ts`
(`passHazardAsk` → `slow`), `pictures/preview-marks.ts` (no `askMoveToCopy` for a whole-project pass),
`watcher/strays.ts`, `watcher/pass-writes.ts`, `watcher/watcher.ts`, tests.

**Test:**
- rung 1, `guard/judge.test.ts`, whole page held with `deps` and `migrations` hazards: `src/a.ts` allowed;
  `pnpm-lock.yaml` refused naming `deps`, allowed once held; `.git/config` and a gitfile refused; ordinary rows
  unchanged.
- rung 1, `watcher/strays.test.ts`: with the whole-page claim, `src/a.ts` is no stray; an unclaimed hazard's file is.
- rung 4, `pass/kept-work.test.ts`: a pass of one's turn keeps `src/a.ts` and leaves an unheld hazard's lockfile out.
- through the wiring, `watcher/watcher.test.ts`: a pass of one's page write in Your folder raises no card, while a
  copy's write in its worktree is still judged against `project.areas`.
- rung 2, extend `mcp/pass-move-copy.test.ts`: a whole-project pass asking for `deps` on a PR project gets no Move
  card and the in-place line.

Value: protects=a whole-project page writes every file, hazards keep their claims, and its writes aren't strays;
fails_when=a lockfile is written or kept without its hazard, the Inbox fills with stray cards, or a Move card takes
out the only page; why_new=judge, stray and move rows cover area pages only; no_claim=the open.

### Task 4: The other readers

**Files:** `pass/view.ts` ("Whole project"), `pass/abandon.ts`, `delivery/pass-review.ts`, `runner/turn-checks.ts`,
`runner/check-targets.ts`, `pass/join.ts` (refuses Add Page), tests.

**Test (rung 2):** the view's one page reads "Whole project"; Add Page is refused with the words; a review finding
targets the one page; the Abandon wording names "Whole project"; ordinary passes unchanged.

Value: protects=a pass of one reads as one page everywhere; fails_when=a reader falls back to project areas, names
no page or lets a second page join; why_new=each reader read project areas; no_claim=judge rules (Task 3).

### Task 5: `openPass` opens a pass of one

**Files:** `delivery/pass-open.ts` (`wholeProject`; `refuseOpen` without page rules; the task, the chat's `task_id`,
`pass_id`, `chat_tasks` row and notice in the open's write; `inUse` with `except`), `daemon/services.ts`
(`openPass` passes `wholeProject`; its first-message loop posts the brief), `git/git.ts` (`BISECT_LOG` in
`OPERATIONS_IN_PROGRESS`), `test/pass-world.ts`, tests.

**Test (rung 4, real git, `test/git-wrapper.ts`):** a project with no page area opens one; the branch is at HEAD with
return branch and start recorded; a dirty file is dirt; the chat row and `chat_tasks` link it; the brief is the
task's first builder message; a refused write (return branch under `10db/`) leaves no task, link or branch; an open
mid-bisect is refused (Start Pass too).

Value: protects=a pass of one opens atomically on any project with its brief as first message; fails_when=it needs a
page area, leaves a task or link on a refusal, or opens mid-bisect; why_new=`openPass` takes page tasks only;
no_claim=the chat's turn.

### Task 6: The hold's handover, `lanesWait`, the waiting open and B10's daemon side

**Files:** `folder-hold/hold.ts` (the handover in `flushFree`; `lanesWait`), `folder-hold/AGENTS.md`,
`scheduler/scheduler.ts` (`waitForFolder` shows the opening notice), `delivery/pass-open.ts` (`waitForFolder` with the
combined signal; `refuseOpen` after the wait), `pass/pending-open.ts` (one per project; refusals up front; the update
drain cancels), `folder-hold/view.ts` (`pendingOpen`), routes (`whenBusy` on Start Pass;
`DELETE /projects/:projectId/pending-open`), tests.

**Test:**
- rung 2, `hold.test.ts`: when a chat's turn releases, the waiting git entry holds the token before the release
  returns, and a take attempted in the same tick is refused (handover); an abort in the same tick as the handover
  leaves no git holder and the next take succeeds (row 24); two waiters are served oldest first; with a
  `lanesWait` entry, `blockers(LaneStart)` names it and a chat's take is refused (follow-up 4's row); without it,
  lanes are unchanged.
- rung 2, `scheduler.test.ts`: a queued first start shows "Waits for the pass ‘X’, opening".
- rung 4, `delivery/pass-open.test.ts`: a waiting open opens after the release; Cancel, and the job's own abort
  (`jobs.stop()`), each reject and leave no branch; the open's after-wait `refuseOpen` refusal releases its token; a lane that starts while the open is queued behind another job
  makes it refuse after its wait.
- rung 3, `app.request`: `whenBusy: wait` answers `pending` and the folder route shows it; a second Start Pass is
  refused up front; Do It in either place and archive of the chat it names are refused until Cancel; the update
  drain cancels it and `jobs.pending()` drops to 0; `stop_turns` stops and opens, and a Stop on a stopped chat
  meanwhile leaves its starts held.

Value: protects=a pass open waits for chats instead of failing, nothing slips into the gap, and nothing hangs a
shutdown; fails_when=a lane or chat takes the folder between wake and reservation, a pending open hangs an update,
or a request queues behind it; why_new=`flushFree` wakes without reserving and `openPass` only refuses;
no_claim=Do It's own turn.

### Task 7: `engine.seal`

**Files:** `conversation/explore-engine.ts` (`seal(id)`: reduce `do_it`, await `settled`, end the session row),
`explore-engine.test.ts`.

**Test (rung 2, real store, fake adapter):** a seal from `idle_warm` closes the session, from `running` stores the
partial, from `waiting_card` withdraws the card, from `idle_cold` just seals; `taken_over` refused; a restart keeps
`sealed`; the owner hears `onState(sealed)` once.

Value: protects=a sealed chat has no live session and gives its hold back; fails_when=a seal leaves a warm session or
token alive; why_new=the reducer's `do_it` has no caller; no_claim=Do It's order.

### Task 8: `write_brief` and the brief

**Files:** `chat/tools.ts` (`write_brief`), `chat/briefs.ts`, `chat/brief.ts` (`briefFromChat`),
`chat/tool-policy.ts` (`R`), `mcp/chat-tools.ts` (description), `chat/service.ts` (`brief`), `POST
/chats/:chatId/brief`, tests.

**Test:**
- rung 1, `brief.test.ts`: `briefFromChat` and `chatDigest` leave out every `purpose: 'brief'` message and its
  turn's reply, including a second request after an earlier brief; the last message is the builder's own; a 12,000-character digest plus a long last message stays
  under `TASK_MESSAGE_MAX_CHARS`.
- rung 2, `test/chat-world.ts`: a fake idle turn calls `write_brief` and the preview has the agent's brief, areas and
  criteria; after 60 s on `ManualClock`, the chat's; asked while `running`, `waiting_card` or parked, no message is
  posted and the chat's brief is there at once, the turn untouched (row 23); the send takes no hold; Cancel stops
  the brief turn, and a builder send during it stops it and runs as its own turn, taking the folder; a call from an
  older session is refused; 30 minutes on, the brief is gone.

Value: protects=the sheet gets a brief within 60 s, never stops or rides the builder's turn, and leaves out its own
prompt; fails_when=the fallback says "Change nothing", a brief turn runs on the writable hold, or Stop kills the
builder's turn; why_new=no brief exists; no_claim=Do It.

### Task 9: The preview

**Files:** `git/git.ts` `changedEntries(repo, max)`, `chat/do-it.ts` `preview`, `chat/chat-areas.ts`
(`areasOfChat`), `GET /chats/:chatId/do-it`, tests.

**Test:**
- rung 4, `git.test.ts`: M, A, D, R and `?`; the cap and `more`; no filter or fsmonitor runs (a marker).
- rung 1, `chat-areas.test.ts`: edit-row and uncommitted paths map to their areas; none → the catch-all, else the
  first area.
- rung 3: `here` refused naming a lane, an open pass and a takeover, each with its link; another chat's turn gives
  `whenBusy`; a closed pass gives `stacksOn`; a `local` project has no copy and says why; mid-merge refuses `here`;
  on `feature` two commits ahead, the copy's `base` and `leftOut`.

Value: protects=the builder sees files, base and refusals before Do It; fails_when=a refusal comes only at submit or
files and left-out commits are hidden; why_new=nothing previews Do It; no_claim=the submit.

### Task 10: Do It in a separate copy

**Files:** `chat/do-it.ts` (`doItCopy`, the guard, `finishSeals`), `chat/service.ts` (Stop, Redo, archive and send
under the guard; archive refused while the chat's task is unfinished), `daemon/start.ts`, `POST
/chats/:chatId/do-it`, `test/do-it-copy.test.ts` (new, over `test/chat-world.ts`, a real git repo and the delivery
harness).

**Test (rung 5):**
- **real git:** a chat with uncommitted `notes.md` does it; the batch is cut in a worktree without `notes.md`, which
  stays in Your folder unchanged.
- the task has the chat's areas (an edit under `api`) and the fallback criterion; it starts from base.
- the chat is `sealed`, `hands_on`, tab closed, with `task_id`, a `chat_tasks` row and the notice.
- a running turn is stopped first, its partial kept; Stop pressed meanwhile leaves the starts held; a send meanwhile
  is refused; a double submit makes one task.
- a refused start leaves the chat as it was (its tab still open), removes the task, runs the queue.
- a restart after the chat row's write: `finishSeals` seals it, starts the task, stores the notice, closes the tab.
- row 17: the old token's `/mcp` call, `write_brief` and `commit_changes` are refused after the seal.
- archive is refused while the task runs.

Value: protects=a copy starts once, leaves Your folder alone and leaves one writer per session; fails_when=the chat
survives as a writer, the copy takes the dirt, a double submit makes two tasks, or a failed start seals the chat;
why_new=nothing hands a chat to a task; no_claim=the tab.

### Task 11: Do It Here

**Files:** `chat/do-it.ts` (`doItHere`), the route's `here` branch, `test/do-it-here.test.ts` (new, over
`test/chat-world.ts`, `test/pass-world.ts`, `test/fake-gh.ts`).

**Test (rung 5, real git):**
- **on a feature branch:** the return branch is `feature`; the queued message runs reading only, with the notice.
- **on base, PR project:** after Sign Off and Close Pass, a PR against `main` (fake `gh`); `main` fast-forwards when
  `pr-watch` reads it merged.
- **on base, `local` project:** `main` fast-forwards at the close.
- **refused mid-merge** and mid-bisect: nothing stops, no branch, the turn goes on.
- **after the close:** HEAD on the return branch, the work in the tree with no dirt left over, the commit the
  signed-off turn's.
- **Abandon (row 20):** the earlier uncommitted file is back as it was.
- **Stop during Do It Here:** answered, the starts stay held, the open opens; Redo is refused.
- **races:** own turn running → the open waits for `pendingReleases`, then opens; a lane queued during the turn
  doesn't start first; the deadline refuses and runs `releaseStarts`; a settle and the open run one after the other
  and the pass stacks.
- another chat's turn → refused naming it; `stop_turns` opens; `wait` releases this chat's starts once its own turn
  has released.

Value: protects=Do It Here opens only after every writer is out, on any branch and delivery, and lands as a pass
lands; fails_when=it opens under a turn or lane, mid-merge, a Stop undoes its hold, or the close leaves HEAD or the
tree wrong; why_new=passes open only from the Workbench; no_claim=the views.

### Task 12: Changes and the task's session

**Files:** `delivery/workstream-changes.ts` (`scope`), `?scope=` on `GET /workstreams/:id/changes`,
`GET /tasks/:taskId/session`, `test/workstream-changes-api.test.ts`, `test/pass-api.test.ts`.

- **A pass task:** `all` runs from the pass's `startSha` to the task's kept tip; `last` is the latest ended turn's
  kept commit against its kept base (`listPassTurns`), which is today's answer while Ready.
- **A separate copy:** `all` and `last` are today's `baseHead` to head. Once its worktree is gone the route answers
  409, and the panel says so.
- **`fromChat`** reads `chat_tasks`, so a later Do It from the same chat doesn't lose it.

**Test (rung 4, `app.request`):** two kept turns: `all` shows both, `last` the second, with the page working on a
third; a copy's `all` matches today's; a finished copy's 409; the session DTO's `fromChat`, `passId` and place for
both kinds, after a second Do It.

Value: protects=Changes shows every turn or the last; fails_when=Last Turn reads a stale kept commit or All Turns the
folder's dirt; why_new=the route shows one kept commit only; no_claim=the panel.

### Task 13: The Do It sheet, and the fourth choice

**Files:** desktop `views/sessions/do-it-sheet.tsx`, `do-it-words.ts`; `session-bar.tsx` (**Do It…** as a
`SplitButton` with File as Tasks in its menu; disabled in `taken_over`, "Hand back first"); `session-keys.ts` (⌘⇧↩);
`conversation/composer.tsx` (`ComposerHeld.onDoItSeparately`, opening the sheet on Separate copy with the draft);
`daemon/chat-queries.ts`; tests.

**How it behaves (UI spec §8.1):** Where is `placement-choice.tsx`; the brief shows "Writing the brief…" until it
fills, and a dimmed line when it is the chat's ("The chat is mid-turn, so this brief is the chat so far."); the copy's
line names its base and left-out commits; the areas and criteria show under the brief; the agent and model as one
dimmed line; "The turn that's running stops first." above the buttons; refused places disabled with their link; a
submit refusal in red beside Do It; typing in the field stops taking the daemon's brief. On success the copy replaces
the chat's tab with a Task tab, and Here opens one to its right.

**Test (rung 3, `renderWithDaemon`):** each place's words; Show N More; a refused Here; the fallback line; a late
brief doesn't replace typed text; Cancel posts the brief's delete; ⌘↩ submits; the fourth choice sends the draft; axe passes. Then click the sheet
once against the real daemon (`/browse`) before Task 14, so the DTOs match.

Value: protects=the builder sees place, files and fate before Do It; fails_when=a refused place can be picked, a
late brief erases typing, or a submit error loses the brief; why_new=no sheet exists; no_claim=the tabs.

### Task 14: Task tabs and the handover

**Files:** `views/sessions/task-tabs.ts` (pure functions over `tendb.sessions.tasks`, as `fresh-tabs.ts`);
`strip-tabs.ts` (`{ kind: 'task' }`); `session-tab.tsx` (`folder`, `git-branch` glyphs); `sessions-search.ts`
(`?task=`); `task-tab.tsx`, `task-bar.tsx`; `chat-entries.ts` (the `handed_to` row: "Started a task: … · Separate
copy · Open", "Started a pass: … · Your folder · Open"); the sealed chat's read-only line with Open Task;
`closed-tabs.ts`; `open-session.ts` (Inbox: a whole-project pass's and a copy's cards open the task's tab);
`views/board/task-drawer.tsx` (Open Session for a task with a session place); tests.

**The copy's tab:** "From chat: {title}", then the description as the builder's first row, then the task's thread
(`ConversationList` over `TaskSessionDto.conversationId`, `useConversationLive`); the run's live line; the bar
"Task · Separate copy · `10db/…`"; the composer only while the run runs ("Messages reach this task while it runs.");
finished, "Finished · in review: pull request #n · CI running" with Open on Board and Open Pull Request; merged,
"Done · merged as `abc1234`."; failed, the failure line in `failureLine`'s words with Open on Board.

**Test (rung 3):** a hands-off replaces the chat's tab at its place; the sealed chat opens read-only with Open Task;
the Inbox card and the Board drawer open the task's tab; ⌘⇧T brings back a closed one; a cleared store still reaches
the task from the chat's row; the failed and done lines.

Value: protects=the task takes the chat's place and both stay reachable; fails_when=the strip loses the task or the
sealed chat can be written to; why_new=tabs are chats only; no_claim=the pass's controls.

### Task 15: The pass-of-one tab

**Files:** `views/sessions/pass-tab.tsx`, `pass-tab-bar.tsx`, reusing the Workbench's `page-thread.tsx`,
`page-composer.tsx`, `page-ask.tsx`, `retry-turn.tsx`, `pr-button.tsx`, `close-pass-modal.tsx`,
`close-progress.tsx`, `abandon-modal.tsx`, `closed-pass-line.tsx`; `workbench-view.tsx` (live pass before setup);
`page-list.tsx`, `page-picker.tsx` and the Board's area chips through `areaLabel`; tests.

**What it shows:** "From chat" and the brief first; the bar "Task · Your folder · lands on `main`"; Close Pass… once
something is signed off, filled when nothing works; Abandon Pass… in `⋯`; the close's lines, then "Done · `main` is at
`abc1234`."; the chat's kind line reads the pass (M6a).

**Test (rung 3):** Ready with nothing typed makes Sign Off primary; typing makes Send primary; Close Pass… opens the
pass's modal; a closed pass shows its line; the Workbench lists "Whole project" on a project with no page area; a
Board chip reads "Whole project", never `10db-whole-project`.

Value: protects=a pass of one lands from its tab as a pass does and reads by its label; fails_when=a control is
missing, the Workbench hides it, or the raw name shows; why_new=the controls live in the Workbench only;
no_claim=e2e.

### Task 16: The Changes panel

**Files:** `views/sessions/changes-panel.tsx`, `changes-files.ts`, ⌘⇧D, tests.

**How it behaves (UI spec §9):** "Changes +41 −6" in Task tabs only; opens by itself once at 1100 px or wider, then
the builder's choice holds per tab; the header names the base; the latest check line under it, with Send to Agent
when it failed; a pass of one adds All Turns · Last Turn; the jump list, and diffs through the kit's
`hunk-diff.tsx` (unified, split from 720 px); a line number quotes the line into the composer; "No changes yet.";
a finished copy: "This task's copy is gone. Its pull request has the changes.", with Open Pull Request.

**Test (rung 3):** the scope toggles the query; the first open happens once; the quote lands in the draft; the check
line's Send to Agent posts; a gone copy's line; a Chat has no Changes.

Value: protects=the builder reads a task's diff beside its thread; fails_when=Changes shows on a chat, Last Turn
reads All, or a gone copy errors; why_new=no panel; no_claim=diff rendering.

### Task 17: B10 in the Workbench and the sheet

**Files:** `views/workbench/start-pass.tsx`, `do-it-sheet.tsx`, `views/sessions/pending-open-line.tsx` ("Opens when
the chat ‘X’ ends its turn · Cancel", on the Workbench and the chat's bar; "Cancelled for 10db's update"), tests.

**Test (rung 3):** a chat holder offers both buttons; a lane or takeover neither; Open When It Ends shows the line and
Cancel posts the delete; the line goes when the folder route drops it.

Value: protects=a refusal by a chat's turn has a one-click way out; fails_when=the offers show for a lane or takeover
or a wait can't be cancelled; why_new=the refusal had only words; no_claim=the daemon's wait.

### Task 18: e2e, click-through, then review

**Files:** `apps/desktop/e2e/sessions.spec.ts`, `script-book.json` (a brief turn that calls `write_brief`, and the
page's first turn).

**Test (rung 5, real daemon, fake sessions)**, on a `local` project with no gate command, as `workbench.spec.ts` sets
one up:
1. A chat's turn commits the builder's edit (`commit_changes`), as M6a's e2e does (no sandbox in e2e).
2. The builder leaves `todo.md` uncommitted. **Do It…**: the scripted brief fills; the sheet lists `todo.md`; pick
   Your folder, as a pass; Do It.
3. The pass's tab opens to the right; its scripted first turn edits a file and is Ready.
4. Sign Off: "Signed off · landed as …".
5. Close Pass…: the close's lines, then "Done · `main` is at …"; the folder is on `main` with the commit.
6. The chat's line reads "Chat · Your folder · on `main`" again.

Then click through by hand against the real daemon (`/browse`): both places, a refused Here, Open When It Ends,
Changes, a copy's tab on a PR project, dark and light. Then the code review of Tasks 13–17, converging as
`.claude/agents/code-reviewer.md` says.

Value: protects=chat → Do It Here → turn → Sign Off → close through daemon and UI; fails_when=any seam breaks;
why_new=no e2e hands a chat to a task; no_claim=Claude or Codex themselves.

### Task 19: Adversarial review

Dispatch `code-reviewer` (opus) on Tasks 1–12 with M6's security table and rows 15–24: the whole-project page
(hazards, `.git`, agent config, kept work, the watcher), the sealed chat's late calls, the brief and its turn, Do It's
guard and races, the hold's handover, and that the chat's dirt doesn't travel to the copy. Blocking findings get at
most two fix rounds.

### Task 20: Live checks

Results go in the PR, never CI. `apps/daemon/test/do-it.live.test.ts` on `live-chat-daemon.ts`, in a real repository
outside every temp root.

| Check | Account | What to show |
| --- | --- | --- |
| LC6 | Claude plan | an idle brief turn calls `write_brief`, reading only, within 60 s |
| LC7 | Codex | the same through 10db's `/mcp` (needs the builder's ChatGPT sign-in, as LC3) |
| LC8 | Bedrock or API key | Do It Here: the page's first turn edits; Sign Off lands it |

### Task 21: Docs

- the decision record, amending M6's
- sessions spec §7.3: the page key, the copy's areas and criteria, stacking, no copy on `local`, the order and guard,
  the brief only between turns, hazards and the watcher in a pass of one, B10
- UI spec §5.2 (Task tabs in the window), §8.1 (the brief's timing, `local`, the copy's base), §8.2 (New Chat From
  This deferred), §9 (`scope`, a gone copy)
- roadmap: M6b's row; `AGENTS.md` notes of `chat/`, `conversation/`, `folder-hold/` (the handover and the signal
  rule), `pass/`, `delivery/`, `watcher/`, desktop `sessions/`, `workbench/`
- `docs/security.md`: rows 15–24

## Follow-up tasks to file

- New Chat From This: a fresh chat seeded from a sealed chat's digest.
- A pass of one never waits for a page claim against a copy task editing the same files; decide whether a
  whole-project page should claim against copies.
- Task tabs kept by the daemon, if tabs should follow the builder across windows.
- Open When It Ends that survives a restart.
- The brief streaming into the field as the agent writes it.
