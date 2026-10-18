# packages/harness

The plugin dir 10db injects into every managed Claude Code session (spec §11.3): craft skills,
default persona definitions used for seeding, and hooks. Repos never copy any of it.

- `plugin/` is a Claude Code plugin: `.claude-plugin/plugin.json`, then `skills/`, `agents/`,
  `hooks/` as they are added. Keep skills short; they load into every session's context.
- `plugin/skills/*/SKILL.md` are the five craft skills (planning, test-first, review-checklist,
  brainstorming, handoff). Each is under 2 KiB (2048 bytes) and starts its description with 'Use when';
  `src/harness.test.ts` enforces both. Refer to 10db's MCP tools by their full names (`mcp__10db__commit`), never to
  `git commit`.
- `plugin/personas/<key>.md` holds the default personas, one per flow role: frontmatter `name`, `role`, `tools` (only `implement` edits) and optional `skills` (names from `SKILL_NAMES`), then the instructions, under 4 KiB, naming 10db's tools in full. The daemon seeds each one whose key is missing on first start and never overwrites a builder's edit. `src/personas.test.ts` enforces the shape.
- Hook logic that needs daemon state runs in the daemon as SDK hook callbacks, not as scripts here.
  Script hooks here are only for terminal (takeover) sessions.
- `src/` exposes the plugin path and validated manifest to the daemon; it never imports the daemon.
