# packages/harness

The plugin dir 10db injects into every managed Claude Code session (spec §11.3): craft skills,
default persona definitions used for seeding, and hooks. Repos never copy any of it.

- `plugin/` is a Claude Code plugin: `.claude-plugin/plugin.json`, then `skills/`, `agents/`,
  `hooks/` as they are added. Keep skills short; they load into every session's context.
- Hook logic that needs daemon state runs in the daemon as SDK hook callbacks, not as scripts here.
  Script hooks here are only for terminal (takeover) sessions.
- `src/` exposes the plugin path and validated manifest to the daemon; it never imports the daemon.
