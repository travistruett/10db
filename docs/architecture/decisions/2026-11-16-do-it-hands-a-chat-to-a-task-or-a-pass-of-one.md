# Do It hands a chat's work to a task in a separate copy, or to a pass of one in Your folder

- **Date:** 2026-11-16
- **Amends:** `decisions/2026-11-15-a-chat-writes-under-the-folder-hold-and-10dbs-writers-keep-it-alone.md` (the
  hold gains a handover and a signal rule, and Do It is built on it)

## Decision

- **Order and guard** (`apps/daemon/src/chat/do-it.ts`). `taken_over` ("Hand back first"), `sealed` and archived
  chats are refused, and a per-chat in-flight guard refuses a second Do It. While it stands, Stop answers and
  changes nothing, Redo and archive are refused, a send to a chat doing a separate copy is refused, and a send
  during Do It Here queues and runs reading only after the open. A pending Open When It Ends that names the chat
  refuses Do It and archive for it.
- **Separate copy.** An ordinary task from the base branch, landing by the project's delivery, with a `chat_tasks`
  row. It is refused on a `local` project, which has no copies. Its areas are the brief's, else what the chat
  changed (its edits and the uncommitted files, by area), else the catch-all area; its criteria are the brief's,
  else "Does what the brief asks, and the project's checks pass." The chat's uncommitted files stay in Your folder
  and the commits HEAD has that the base lacks stay out of the copy; the sheet says both. The task starts before the
  seal, a failed start leaves the chat as it was, and the seal (`engine.seal`) is the last step. Recovery
  (`finishSeals`) finishes a cut-short seal.
- **A pass of one.** A pass whose one page is `WHOLE_PROJECT_PAGE` (`10db-whole-project`, a name `AreaName` cannot
  spell, never saved in `projects.areas`). A pass is "of one" because its task names that page, not because of
  `chats.pass_id`, which a later Do It Here rewrites. Every reader of a pass's areas reads `passAreasOf`: the
  judge, claims, kept work, the shared hold, the watcher, reviews and checks, labels. Add Page is refused. The
  chat is not sealed; it reads only while the pass holds the folder. The chat's uncommitted files become the
  task's work, and Abandon puts them back (`2026-11-14-abandon-pass-deletes-unsigned-pages-work.md`).
- **Hazards keep their rules in a pass of one.** A lockfile or migration is page work only with its claim, else it
  goes to the close's "files no page owns"; the watcher still cards a write outside every claim. The hazard ask
  answers `slow` and no Move card is made, since moving the only page out would empty the pass.
- **Stacking.** A pass of one stacks on a closed pass waiting for its pull request, as Start Pass does; it is not
  refused.
- **The brief.** The chat's agent writes it with `write_brief`, asked only between turns, on a read-only profile.
  Mid-turn, waiting on a card or the folder, or paused, the brief is the chat read back (`briefFromChat`) at once
  and the builder's turn is never stopped. After 60 s with no call the brief is the chat read back too. A send or
  Cancel during the brief turn stops it first. The brief lives in memory for 30 minutes. The task starts a new agent
  session from it and never resumes the chat's. The brief request is posted as a message with
  `purpose: 'brief'`, left out of every digest and brief the chat produces, **but a resumed session keeps the
  request in its own transcript**, so a chat resumed after a brief turn still carries "Change nothing" in what the
  agent remembers. This is accepted: the builder's next message states what to do and the agent follows it.
- **B10: a refused open with only chats' turns in the way** offers Stop the Turn and Open and Open When It Ends
  (`whenBusy`), on Start Pass and on Do It Here. Open When It Ends is one per project (`pass/pending-open.ts`), is
  cancelled by the update drain, and is lost at a restart.
- **Task tabs live in the window** (`localStorage`), so no migration: a cleared store loses the tab, never the
  task. Changes takes a `scope` (all turns or the last) for a pass of one.
- **The hold's handover and signal rule** (`folder-hold/`). `flushFree` reserves the git token for the oldest
  waiting entry inside the wake, so nothing runs between the wake and the reservation. Every wait on the folder
  takes its delivery job's signal; a handed-over token whose signal aborted is released before the wait rejects, and
  every caller wraps everything after the await in `try { … } finally { release }`. `lanesWait` makes an opening
  pass's `freeing` entry keep a lane's first start waiting too.
- **Do It's tasks get a `chat_tasks` row on purpose:** Recent counts them as filed, the chat's `edit_task` reaches
  them, and `remove_task` on one no longer asks (`chatMadeTask`), which is safe because Remove refuses a started
  task.
- **Provider parity.** Both places, the brief and Changes run on a Claude plan, on Bedrock or an API key and on a
  ChatGPT/Codex plan. `write_brief` reaches Codex through 10db's `/mcp`. No new gap.

## Why

"Knock this out" should go from the conversation to a task without retyping, and the two places differ in what the
builder wants: a copy leaves Your folder alone, a pass of one keeps the turns, Sign Off, one pull request and a
fast-forward. The whole-project page reuses the pass's machinery, so kept turns, Abandon and the close are not
rebuilt; the cost is that every reader of a pass's areas had to learn the synthetic page. The brief is asked only
between turns because stopping a builder's turn to write a brief would lose work; the chat read back is a brief the
builder can edit at once.

Turned down:

- **Resuming the chat's agent session in the task.** One agent session would have two writers, and the picture
  budget would start dirty. The digest carries the context.
- **A real area for the whole project.** It would collide with hazards and project areas, and be saved.
- **Refusing a pass of one on a closed pass.** Start Pass stacks; Do It Here should not be stricter.
- **A copy on a `local` project.** It has no copies; the sheet says so and offers Your folder.
- **Tabs kept by the daemon.** A migration for something a cleared store loses without losing the task.
