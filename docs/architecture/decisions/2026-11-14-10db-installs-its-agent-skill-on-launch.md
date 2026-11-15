# 10db ships the 10db-task skill and installs it for Claude Code and Codex on every launch

- **Date:** 2026-11-14

## Decision

- The `10db-task` skill's source lives in `packages/agent-skill`. The daemon build bundles it into the app, and its
  checks import the New Task rules from `@10db/contracts`.
- On every launch, with the Settings switch "Agents in any repo can use 10db" on (the default), a daemon on the
  default data dir writes the skill to `~/.10db/skills/10db-task` and links `~/.claude/skills/10db-task` and
  `~/.agents/skills/10db-task` to it. It creates a missing link, replaces one that points at nothing, and leaves
  any other link, folder or file alone, naming it in Settings. Turning the switch off removes only its own links
  and copy.
- The skill never comes along into a managed session: it acts for the builder with the UI token.
- The skill sends its version with every call. A daemon shipping a different version refuses with "restart 10db".

## Why

- The builder chose install-on-launch with a switch over installing only on a click (2026-11-14): an app update
  then updates the skill, and a new Mac needs no step.
- The skill drifted from the API while it lived in agent-os, untested by 10db's suite. Beside the API, imported
  rules and a test against a real daemon make a breaking change fail 10db's gate.
- Links rather than copies in `~/.claude` and `~/.agents`: one copy for both tools, and an owned path 10db can
  rewrite atomically without touching what the builder made.
- Never taking over a link that points elsewhere keeps a builder's own dev copy safe. The move off agent-os
  still works without a special case: agent-os deletes its copy, and its links then point at nothing.
- Turned down: the Claude Code plugin marketplace (Claude Code only, so Codex would need a second channel); a
  click-to-install button only (the skill falls behind after an update); folding the skill onto the builder MCP
  tools now (the bridge lacks most of the skill's commands, so that is its own task).
