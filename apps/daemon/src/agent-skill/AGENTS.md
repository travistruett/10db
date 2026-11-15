# apps/daemon/src/agent-skill

Installs the `10db-task` skill the app ships into `<builderHome>/.10db/skills/10db-task` and links it at
`~/.claude/skills/10db-task` (Claude Code) and `~/.agents/skills/10db-task` (Codex).

- The home is always `builderHome`, never `homedir()`; every test passes a temp home and a temp shipped dir.
- A link path is judged by where it resolves, not by its text. Only a missing path or a link to nothing is
  written; a link to anywhere else, a real folder or a real file is the builder's and is left as it is.
- Turning the skill off removes only links that resolve to 10db's copy.
- The daemon never imports `@10db/agent-skill`; it copies the folder the build put beside `daemon.mjs`.
