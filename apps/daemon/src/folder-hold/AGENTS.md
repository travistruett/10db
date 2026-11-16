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
