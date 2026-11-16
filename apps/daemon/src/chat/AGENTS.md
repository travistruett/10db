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
  which reads the query as text. `session-starts.ts` and `start-facts.ts` build Start from's three rules from a
  failed task, the base's commits of the last day and the area of `HEAD`'s files; a fact that can't be read
  offers nothing. `settings.ts` is Settings › Sessions.
- A chat's session stays warm after a turn that held Your folder, and its next turn that holds reuses it. Between
  turns, and from any session but the one the chat's hold belongs to (`holdingSession` in `hooks.ts`), its guard
  denies every call. At each turn's end `endJobs` stops what the session's commands left running, from the mark taken
  at its first Bash call (`sandbox/lane-processes.ts`). Only once they have stopped does `onState` give the folder back
  (`pendingReleases` in `hooks.ts`): the chat's next turn cancels that release, and a stop that fails closes the warm
  session first.
- `git-tools.ts` holds the chat's tools that change git in Your folder (`make_branch`, `switch_branch`, `pull`, `commit_changes`;
  Git's side is `git/chat-git.ts`; a call's `beforeWrite` repeats the hold check under the repo lock, `commit_changes` refuses a
  `.env*` file or one of the checkout's `secretFilesIn` files (a listed folder holds all under it) and stages only the paths it
  checked). Each runs only from the chat's open session while its turn holds the folder, refuses while a closed
  pass waits for its pull request and while HEAD or the named branch is under `10db/` (`git-names.ts`), and answers a warning naming
  the other chat when it commits everything in a shared folder. The shell's own git writes are refused with `CHAT_GIT_REFUSAL`
  (`git-rule.ts`), which names these tools.
- `push_branch`, `open_pull_request` and `merge_pull_request` (also `git-tools.ts`) reach GitHub through the daemon's pinned push
  and `gh -R` on the pinned repository: the push names one qualified ref and never forces, a pull request opens only for a branch
  pushed at its commit with its body in a file under the chat's folder that is removed after, and a merge builds its address from
  the pinned repository and the number and refuses a pull request whose head or base is under `10db/`. They are out of `allowedTools` so
  the session's judge sees each call (`JUDGED_OWN_TOOLS` in `trust/fast-path.ts`, which the fast path never settles; `JUDGED_CHAT_TOOLS` in `git-rule.ts`); the hook answers a bare allow where a judge runs and
  asks on the rules floor, and the chat's trust policy tells the judge a push and a pull request send data out and a merge writes
  to a live system.
- The folder routes (sessions spec §7.3): `GET /projects/:projectId/folder` (`FolderDto`, built by `folderView` in
  `folder-hold/view.ts` with each holder's words and whether it keeps a chat out; the branch is `symbolic-ref`, null
  when detached or unreadable), `folder` (`wait` | `read_only`) in the message and redo bodies (JSON and multipart),
  and `POST /chats/:chatId/stop-waiting`. `conversationLive` carries `waitingForFolder` for a chat; the desktop reads
  a chat's wait from the folder's `waiting_chat` holder instead.
