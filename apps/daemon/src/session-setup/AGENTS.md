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
- `planYourMcp` also says whether claude.ai connectors come along (`connectorsOn`): only while the Your MCP servers
  switch is on. A server with an `oauth` block is passed on to Claude as the entry declares it
  (`yourMcpForSession`); no token is read here or anywhere
  (`docs/architecture/decisions/2026-11-14-mcp-sign-ins-stay-in-each-agents-own-store.md`).
- A plugin's server has two names. 10db's, `plugin_<plugin>_<server>` (`yourMcpName`), is what Trust, Codex and
  tool names use. A Claude session registers it as Claude Code does, `plugin:<plugin>:<server>`
  (`claudePluginServerName`, carried as `claudeName`), because Claude Code files an MCP sign-in under
  `<registered name>|<sha256 of type, url and headers>`: under any other name the builder's own sign-in is not
  found and the server reads `needs-auth`. Its tools are `mcp__plugin_<plugin>_<server>__*` either way.
