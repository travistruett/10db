# apps/daemon/src/session-setup

- `session-setup/` finds what comes along into a session (Settings › Trust): the project's `AGENTS.md`,
  `CLAUDE.md` and `.claude/rules/*.md` and the builder's `~/.claude/CLAUDE.md` as one instructions text
  (`readInstructions`), with what it left out and why (`leftOutNote`). It reads checkout files only through
  the safe reader (`readRepoConfigFile` from `sessions`), never by following a link; the builder's own file may
  be a link, but never into ground a lane can write.
