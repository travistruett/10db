# apps/daemon/src/session-setup

- `session-setup/` finds what comes along into a session (Settings › Trust): the project's `AGENTS.md`,
  `CLAUDE.md` and `.claude/rules/*.md` and the builder's `~/.claude/CLAUDE.md` as one instructions text
  (`readInstructions`), with what it left out and why (`leftOutNote`). It reads checkout files only through
  the safe reader (`readRepoConfigFile` from `sessions`), never by following a link; the builder's own file may
  be a link, but never into ground a lane can write.
- The builder's own MCP servers (`your-mcp-*.ts`): `readYourMcpConfig` reads `~/.claude.json`, `~/.codex/config.toml`
  and the enabled plugins' servers; `yourMcpConfigHash` is what an approval covers (secret-named env values and
  URLs with userinfo are masked); `planYourMcp` and `yourMcpForSession` plan one session's servers from the
  switches, approvals and login env; `yourMcpServerDtos` is Settings' list. A server that would run lane-written
  code is left out with a reason (`sandbox/your-mcp-launch.ts`). No secret value leaves this folder for a DTO.
