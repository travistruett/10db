# apps/daemon/src/folder-hold

Who holds a project's checkout, Your folder (sessions spec §7.3). Every call is synchronous, so a take and a
lane's start can't interleave.

- `exclusion.ts` is the holder table as a pure function (`exclusion(holder, asker)`) with `holderWords`, the sentence
  part that names a holder in a notice, a refusal or a warning. A lane or a pass never excludes 10db's own git
  work here: its callers keep today's checks (`lanesInProjectCheckout`, `passHoldingFolder`), so a shared batch's own
  row never blocks its cut or its switch back.
- `hold.ts` reads a pass (`passHoldingFolder`), a lane (`folderLanes`) and a taken-over chat from rows, and keeps a
  chat's turn and 10db's git work in progress in memory. A restart keeps the rows and drops the memory.
  `takeTurn` shares with other chats and takeovers and returns the limits a closed pass puts on the folder git tools;
  `reserveGit` is what 10db's own git work takes before it moves HEAD.
- Every change of the memory entries emits `FolderHoldChanged` for the project.
- `reserveGitWhenFree` is a handover: the wake (`flushFree`) reserves the git token for the oldest waiting entry
  that nothing keeps out and resolves with it, so no take or start runs between the wake and the reservation. Every
  wait takes its delivery job's signal. A token handed over in the same tick as an abort is released before the
  call rejects, so an abort leaves no git holder. A caller wraps everything it does after the await, its re-checks
  included, in `try { … } finally { releaseGit(token) }`, so a throw never leaves an unowned `git_work` entry.
- `takeOver(projectId, chatId, enter)` is a chat's move to the builder's terminal: it checks `blockers` for a
  `Takeover` asker, runs `enter` (which writes `taken_over`) in the same synchronous call, then announces the
  change; a throw from `enter` takes and announces nothing. `handBack(projectId, chatId, leave)` runs `leave`,
  announces, and serves waiters, so 10db's git work that waited for the takeover is handed the folder (the wake's
  reservation) before the chat's held message, which `chat/service.ts` parks as a waiter. `takenOverChats` skips
  archived chats, so an archived chat never holds.
