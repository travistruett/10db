# Claude.ai connectors are relayed under strict MCP config

- **Date:** 2026-11-14

## Decision

A Claude plan session gets the account's claude.ai connectors, as Claude Code gives them, while
`strictMcpConfig` stays on for every session.

- **The probe.** A short Claude Code start of its own reads the connectors: no prompt, no settings file
  (`settingSources: []`), `AUTOUPDATE_OFF`, a fresh empty `CLAUDE_CONFIG_DIR` and an empty cwd under
  `<dataDir>/connector-probe`, non-strict because a strict start lists none. The keychain lookup is pointed at the
  folder the session itself reads, so the probe reads the account's login and writes no entry of its own. The
  answer is kept 10 minutes, a failed read 60 seconds, and a session waits for it at most 12 seconds, then
  starts without connectors and says so.
- **The relay.** The session passes each connector back as an explicit `claudeai-proxy` entry through
  `setMcpServers`. A connector whose tool prefix a configured server already holds is left out.
- **The switch.** The project's Your MCP servers switch, app-wide or by override, turns connectors off too: no
  entry is passed and the probe never runs. A Codex session, an API-key session and a Bedrock session get none:
  Codex's apps stay off, and Claude Code offers none without a claude.ai login or on a third-party provider.
- **The probe stops at anything but a connector.** A list holding an entry of another scope is refused. It never
  starts when a `.mcp.json` sits in its folder or any folder above it, or `managed-mcp.json` exists on the Mac,
  since a non-strict start would run those servers outside any sandbox; Claude Code has no switch that skips
  managed config. The probe folder is refused when it is a link, and removed after every probe.

## Why

A strict session lists no connectors, and dropping `strictMcpConfig` would load `~/.claude.json`'s user and local
servers outside the approval and the launch, and the project's `.mcp.json` outside `srt`. The probe reads the
connectors without that, and the relay hands over exactly the entries that are connectors.

What stays open: a connector the builder turned off in their own Claude Code still comes in, because the probe's
fresh folder has no disabled list, and only 10db's switch turns it off.
