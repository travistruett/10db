# apps/daemon/src/chat

- `chat/` is Sessions' chat (sessions spec §7.1, decision
  `decisions/2026-11-14-sessions-is-a-top-level-screen-and-a-chat-is-attended.md`): a tab of its own over an
  explore conversation the engine runs. `service.ts` keeps the chat's row (`chats`, `chat_tasks` in
  `@10db/db`'s `store/chats.ts`): it creates the conversation on the project's account, takes the message
  route's chat branch (the message queued with its `mentions` and pictures, the chat titled from its first line,
  `last_activity_at` touched), moves the tab, and changes the model and the effort (`conversations.effort`, read by the launch of the next session; an effort-only change closes a warm session, as a model change on an agent that cannot switch does) only between turns. Archive goes through
  `ExploreEngine.retire` (a start cancelled, a turn stopped with its partial kept, a card withdrawn, a warm
  session closed with its row ended, so its token reaches nothing), then removes `<dataDir>/conversations/<id>/`.
- `hooks.ts` is the chat as an engine owner: the attended explore profile (Plan's read-only sandbox through the
  shape preparer, read tools, `Task` and `Agent`, the web where a judge sees each call, the builder's setup, no
  write tool and none of Plan's agents), the attended `TrustPolicy`, and every chat tool in `allowedTools`.
  `confinement.ts` is its PreToolUse hook. `live-sessions.ts` names each chat's open session, so a tool's card
  is told to the engine and goes when the session ends. When 10db's judge stops answering mid-session, the hook judge's `onFloor` writes one notice in the
  chat's thread (`floorNoticeText`); Plan's owner does the same in its own thread.
- `tools.ts` holds the chat's tools on `/mcp` (`mcp/chat-tools.ts` is the server's side): each is the builder's
  tool (`builder/tools.ts`) held to the chat's project. `tool-policy.ts` is the table of what asks:
  `remove_task` on a task the chat did not file, and retire, withdraw and supersede every time, raise a
  permission card owned by the conversation; a Stop or archive withdraws it, and so does the project's human
  wait passing, inside the call's own timeout of that wait plus 5 minutes, so a late Allow finds it closed. A
  conversation's card never folds with another. A knowledge card quotes the record and its id, and a record
  of another project is refused before any card. `create_task` records the task in
  `chat_tasks`; `edit_task` answers the old values for Undo; `set_title` is cut at a word to 28 characters and
  never replaces the builder's name.
- `conversation-files.ts` serves `GET /conversations/:id/files?q=` from `git ls-files` of the checkout the daemon
  resolves from the conversation (a chat's is its project's; a task's comes with Do It), ranked by `file-rank.ts`,
  which reads the query as text. `settings.ts` is Settings › Sessions.
- A chat's session stays warm after a turn that held Your folder, and its next turn that holds reuses it. Between
  turns, and from any session but the one the chat's hold belongs to (`holdingSession` in `hooks.ts`), its guard
  denies every call. At each turn's end `endJobs` stops what the session's commands left running, from the mark taken
  at its first Bash call (`sandbox/lane-processes.ts`). Only once they have stopped does `onState` give the folder back
  (`pendingReleases` in `hooks.ts`): the chat's next turn cancels that release, and a stop that fails closes the warm
  session first.
- `git-tools.ts` holds the chat's tools that change git in Your folder (`make_branch`, `switch_branch`, `pull`, `commit_changes`;
  Git's side is `git/chat-git.ts`; a call's `beforeWrite` repeats the hold check under the repo lock, `commit_changes` refuses a
  `.env*` file (a template excepted) or one of the checkout's `secretFilesIn` files (a listed folder holds all under it) and stages only the paths it
  checked). Each runs only from the chat's open session while its turn holds the folder, refuses while a closed
  pass waits for its pull request and while HEAD or the named branch is under `10db/` (`git-names.ts`), and answers a warning naming
  the other chat when it commits everything in a shared folder. The shell's own git writes are refused with `CHAT_GIT_REFUSAL`
  (`git-rule.ts`), which names these tools.
- `push_branch`, `open_pull_request` and `merge_pull_request` (also `git-tools.ts`) reach GitHub through the daemon's pinned push
  and `gh -R` on the pinned repository: the push names one qualified ref and never forces, a pull request opens only for a branch
  pushed at its commit with its body in a file under the chat's folder that is removed after, and a merge builds its address from
  the pinned repository and the number and refuses a pull request whose head or base is under `10db/`. They are out of `allowedTools` so
  the session's judge sees each call (`JUDGED_OWN_TOOLS` in `trust/fast-path.ts`, which the fast path never settles; `JUDGED_CHAT_TOOLS` in `git-rule.ts`); the hook answers a bare allow only where 10db's judge runs: Claude's auto mode approved all three
  unasked in a live check, so on it and on the rules floor the hook asks, and the chat's trust policy tells the judge a push and a pull request send data out and a merge writes
  to a live system.
- The folder routes (sessions spec §7.3): `GET /projects/:projectId/folder` (`FolderDto`, built by `folderView` in
  `folder-hold/view.ts` with each holder's words and whether it keeps a chat out; the branch is `symbolic-ref`, null
  when detached or unreadable), `folder` (`wait`) in the message and redo bodies (JSON and multipart),
  and `POST /chats/:chatId/stop-waiting`. `conversationLive` carries `waitingForFolder` for a chat; the desktop reads
  a chat's wait from the folder's `waiting_chat` holder instead. A send with `folder: wait` parks its turn until the folder frees; a send with no `folder` takes the folder when it
  is free.
- `finish-seals.ts` completes, once after recovery, a chat an old Do It linked to a task in a separate copy but did
  not finish with. `ChatService.stopForOpen` stops a chat's turn so a whole-project pass can open under it (its hold on
  the chat's starts only the open gives back); while it holds, Redo and archive are refused for the chat, and while a
  pass waits to open for a chat, archive is too. A chat sealed into a copy can't be archived while the copy's task is
  unfinished. `task-session.ts` is `GET /tasks/:taskId/session`; the Changes scope is `workstream-changes.ts`'s.
- `brief.ts` reads the chat back as a brief for old rows: it leaves out every `purpose: 'brief'` message and the reply
  it began.
- Do It's tasks get a `chat_tasks` row on purpose (Recent counts them as filed, `edit_task` reaches them,
  `remove_task` on one doesn't ask, `chatMadeTask` in `tools.ts`).
- A chat in the builder's terminal (`taken_over`) is the takeover service's (`takeover/AGENTS.md`). Archiving it asks `takeover.serialized`/`ended` first, so the hold and the files go with the archive; the settings route `PATCH /settings/sessions` names only the field it changes (`terminalApp`, `notifyReplies`), and an older PUT without `terminalApp` reads as Terminal.
- A session's place (`chats.work_place`, spec `docs/superpowers/specs/2026-11-17-10db-sessions-simplified-design.md`; decisions `decisions/2026-11-17-a-sessions-first-change-asks-where-the-work-happens.md`, `decisions/2026-11-17-a-session-on-a-new-branch-is-the-same-conversation-in-its-own-worktree.md`): null while it reads, then `choosing`, `here`, `moving` or `branch`. Every change is a compare-and-set in one transaction with its `ChatChanged` event and, where the state table says so, its Inbox card (`work-state.ts`, `work-card.ts`). `first-change.ts` records the question when a turn's first edit is refused; `work-service.ts` is `choose` (Here: hold, stop the turn, CAS, withdraw the card, post the carry-on message, release) and the move (`work-move`: claim the branch and path, cut the worktree through `delivery/chat-worktree-cut.ts`, restart the session on the same provider session id, record `branch`), with `work-recovery` finishing a move a restart interrupted. The bar and the card are two ways to the same CAS and one wins.
- `chatRoot(chat, project)` (`work-root.ts`) is the only place `chat/` picks a folder: the checkout while reading, choosing, moving or Here; the worktree on a branch; a branch with no worktree reads the checkout and `writes` is false. `confinement.ts` judges an edit against that root and, for a moved session, points an edit of the old path at the same file in the worktree. A turn takes the folder hold only on a Here session (`turnStarting`, `spec()`'s `writes`, `mustWait`, the push, pull-request and merge tools); a branch's terminal holds nothing (`takeover/`).
- Routes (`api/app.ts`, wired by `daemon/chat-services.ts`): `GET`/`POST /chats/:chatId/work` (a repeat of a settled choice answers 200, a different one 409 with `ChatWork`), `GET /chats/:chatId/changes`, `POST /chats/:chatId/{commit,pull-request,merge}` (the title row's git steps, `title-row-git.ts`, `next-git-step.ts`), `POST /chats/:chatId/archive` (a 409 carries what would be lost) and `/unarchive` (Reopen cuts the worktree again on the same branch).
- Removed with Do It: the brief, task tabs, the pass of one, Send Reading Only and the archive preview route. An old sealed chat opens read-only with a link to its task; `brief.ts` and `finish-seals.ts` remain only to read old rows.
- A chat's plan (`planOfConversation`; made by New Plan, Show Plan, a passing `propose_plan`, `start_shape` or an import; a kept plan after the migration): every chat's session gets Plan's `tendb-*` agents, allowed tools (`chatProfile(_, true)`) and folder, plan or not, so a plan made mid-session works on Claude and Codex without a restart. `hooks.ts` composes `PlanParts` (`shape/plan-parts.ts`) into the chat's hooks, so the chat owns the conversation and the plan adds its prompt, opening lines, digest, intake, read budget and turn-end checks. The prompt is the full rules (Claude's system prompt, Codex's `developerInstructions`) for a session that starts or resumes with a plan, else `PLANNING_STUB` (`shape/policy.ts`). A plan that starts mid-session owes the rules once (`ChatLive.planRules`, `peek`/`take`): the next `outgoing` peeks them into the builder's message and takes them once it is sent, and a passing `propose_plan` takes them as its answer's `rules`. Whether Codex's `thread/resume` `developerInstructions` replace the thread's own is not established (`ThreadResumeParams` calls them "Configuration overrides for the resumed thread"); the code relies on it. `spec()` makes the plan's folder (`<data>/shapes/<id>`) before `prepare`: the plan's own, or `planIdOfChat(chat.id)`'s before the chat has a plan, which the plan then takes as its id. The folder opens read-only to the file tools and the kernel (`LaneSessionInput.planFiles`; the confinement's `setupReads`, so it passes before the protected `<data>` root, never through a `readList`); `access.planFilesDir` lets the guard read it, and the read budget resolves the plan per call. `judgeChatCall` sends a Plan tool to `judgePlanTool`; the handlers answer `NO_PLAN_YET` where there is no plan (`shape/AGENTS.md`). Show Plan is `POST /chats/:chatId/plan` (`ChatService.showPlan`, `ensurePlanOfChat`). The chat's own model and effort are the plan's (a chat with a plan starts on the `plan` role's model, and `conversations.effort` holds the effort). Archive keeps a plan and its folder, so Reopen finds the plan as it was, and removes a chat with no plan's empty derived folder (warning, never failing, on an unexpected error); `GET /shapes/:id` and every link to a plan resolve through the chat (`ChatDto.planId`).
- **Full access** (`chats.full_access`, `ChatService.patch`; decision `decisions/2026-11-24-a-chat-the-builder-turns-full-access-on-for-runs-as-claude-code-does.md`): `spec()` starts the chat with no sandbox (`prepareFullAccess`, a broker with no file access), `judgeFullAccessCall` in `confinement.ts` as its hook (10db's own tools and the hold check, every other call a bare allow so Claude Code's auto or default mode decides) and no `createHookJudge` on Claude; a Codex chat keeps the hook judge and does not start without one. A Full access turn takes the folder hold wherever the chat works (`takesHold`, `mustWait`: the send waits, never runs read-only) and releases it once the SDK reports no background task (`backgroundRunning`, polled), within `JOBS_STOP_DEADLINE_MS`, past which the session closes. A turn that finds the folder taken as it begins parks (`parkForFolder`: `holdStarts`, then `watchFolder`) and never runs read-only. Accepted: a command detached with `&` or `nohup` outlives the hold, and a Codex session reports no background tasks so its hold goes back at the turn's end; a terminal `claude` or `codex` does the same. Turning it on records Here first on a reading chat; a change is refused while a turn runs or the chat is moving.
- A Claude chat that isn't Full access can run one command outside its sandbox (`dangerouslyDisableSandbox`; decision `decisions/2026-11-25-a-chat-asks-before-a-command-runs-outside-the-sandbox.md`). `hooks.ts` sets `unsandboxedAsk` and the `ShapeAccess`'s `unsandboxed: 'ask'` for it; `judgeChatCall` denies the flagged call from a subagent, and `outsideSandboxRefusal` (also the broker's `mayRun`, read again at the builder's yes) denies it unless the chat works Here, was opened able to write and its turn holds the checkout. A flagged call counts as a first change (`firstChangeOf`), so it asks where the work happens first. The guard (`shape/confinement.ts`) judges it as an unflagged one, refuses a background run, and turns what it lets through into an ask. A Codex chat has no such flag; its prompt says to suggest Full access.
