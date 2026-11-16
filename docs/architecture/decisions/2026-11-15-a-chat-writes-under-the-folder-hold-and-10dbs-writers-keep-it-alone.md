# A chat writes in Your folder under a folder hold, and 10db's writers keep it to themselves

- **Date:** 2026-11-15
- **Amends:** `decisions/2026-11-14-sessions-is-a-top-level-screen-and-a-chat-is-attended.md` (its chat no longer
  reads only; the writes it deferred to M6 are here)

## Decision

- **Your folder has holders** (sessions spec §7.3, `apps/daemon/src/folder-hold/`). A task's lane, a pass (open,
  closing or closed and unsettled) and a taken-over chat are read from rows; a chat's turn, a waiting chat and
  10db's own git work in progress live in memory and end with the daemon. `exclusion.ts` is the table as a pure
  function.
  - **Attended holders share.** Two chats, or a chat and a chat in the builder's terminal, write at once and each is
    told about the other. Committing everything while the folder is shared warns rather than refuses.
  - **10db's writers exclude a chat.** A running or waiting task, an open or closing pass and 10db's git work (a
    batch's branch cut, the switch back, a pass's open, a settle's two branch moves) keep a chat's turn from
    writing. The chat waits or reads only, as the builder picks.
  - **A closed pass limits only the four folder git tools** (`make_branch`, `switch_branch`, `pull`,
    `commit_changes`), which wait "until its pull request merges". Its merge moves the return branch by
    compare-and-swap.
  - **A folder with uncommitted changes never refuses a chat.**
- **A turn writes only while it holds the folder, on a profile that follows the hold.** Holding: the checkout
  writable with `.git` denied (Edit, Write and NotebookEdit judged per call on real paths; MultiEdit and unknown
  edit tools refused). Not holding: Plan's read-only profile with judged commands. A warm session opened with the
  other profile is closed first and resumes the same agent session (Claude `resume`, Codex `thread/resume`). A
  writable session stays warm after its turn and closes only when the next turn needs the other profile (the
  folder was taken or lost in between), and the guard refuses every call from a session that is not
  the one the chat's hold now belongs to, so a background agent cannot write after its turn.
- **A held send asks first.** The composer offers Wait for It (the message runs once the folder frees, ahead of
  any task that has not started), Send Reading Only, and File as Tasks. The latest send's choice applies to the
  whole queue. A chat that waits keeps its place while the builder is at the screen: a task's first start yields
  to it. Stop, Redo, archive and a restart drop the wait.
- **Git writes go through 10db's tools.** The kernel keeps `.git` closed, so a git write typed in the chat's shell
  is refused with the tools' words. `make_branch`, `switch_branch`, `pull` and `commit_changes` run the daemon's
  pinned git under the repo lock with hooks, filters, attributes and submodule recursion off, and commits carry
  the builder's identity. `push_branch`, `open_pull_request` and `merge_pull_request` stay out of `allowedTools`
  and reach the judge (a push and a pull request send data out; a merge is limit 4). No tool forces a push, and
  every tool refuses 10db's branches (`10db/…`, a batch's, a pass's).
- **The builder's pre-commit hooks do not run on a chat's commits.** The tools say so. Running the project's
  checks on them is a follow-up.
- **Background jobs stop at release.** What a turn's commands left running is stopped when the turn gives the
  folder back, so a dev server started in a chat ends with the turn. A job that outlives a turn is a follow-up.
- **Docker follows the project's switch**, while the turn holds, as for lanes.
- **Claude chats turn on file checkpointing**, so rewind has history. Codex has no equivalent and says so.
- **Provider parity.** Every part runs on a Claude plan, on Bedrock or an API key (the judge
  `capabilities.judge` names) and on a ChatGPT/Codex plan. The one gap is Codex's file checkpointing.

## Why

The trust line puts the security in the kernel sandbox and the judge, not in a rulebook, so a chat may write the
way Claude Code does in a terminal. The only rules kept are for the sandbox's integrity and for 10db's own
writers: a task's commit or a pass's sign-off would take a chat's edits as its own, and a pass's merge would be
broken by a commit under it. Attended holders share because the builder is at the screen and a refusal would be a
wait on the builder. The hold is derived from rows wherever a row exists, so a restart cannot lose it, and held in
memory only for what a restart ends anyway.

Turned down:

- **One chat at a time.** A second terminal does not refuse the first in Claude Code, and a warning is enough.
- **A write profile for the whole chat.** A task's edits would then land under a chat's, so the profile follows
  the turn.
- **Letting the shell run git.** Hooks, filters and credentials run there; the daemon's git has them off.
- **Refusing a message while a task holds the folder.** The builder gets the choice instead of a dead end.
