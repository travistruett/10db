# Work is shaped in a structured chat: an Agent SDK session in 10db's own UI, not a terminal

- **Date:** 2026-11-02
- **Amends:** `docs/superpowers/specs/2026-10-29-10db-goals-design.md` §12, phase 4 ("New Goal as a native
  conversation in 10db, its own terminal-like session")

## Decision

New goals and tasks are shaped in **Shape**, a structured chat that replaces Adopt a Plan… as Factory's call to
action (`docs/superpowers/specs/2026-11-02-10db-brainstorm-chat-design.md`):

- The conversation is a Claude Agent SDK session the daemon runs, as it runs lanes, read-only on the project's
  checkout: its tool lists allow only `Read`, `Grep`, `Glob`, `Agent` and its own MCP tools, and the PreToolUse
  hook (lanes' `judgePreToolUse`) denies any path outside the checkout. The UI renders the SDK's typed messages;
  there is no PTY or embedded terminal.
- The sidebar is built only from typed MCP tool calls (`propose_plan` and the rest) that the daemon validates and
  stores as proposals, never parsed from chat text.
- Claude writes every proposal field; the daemon derives numbers (hours, size buckets, the preview); Jev, through
  the judge, only nudges.
- No proposals until the builder presses Propose; Convert starts nothing.

## Why

- Typed tool calls are the only reliable source for a structured sidebar; reading a plan out of terminal text
  would be screen-scraping.
- The SDK gives what the design depends on: the PreToolUse hook and `canUseTool` for confinement, interrupt, resume
  by session id and token usage (factory-loop decision 5).
- The builder's terminal brainstorms fail in four ways (no picture of where it stands, running ahead, hand-carried
  output, forgetting); each needs structure a terminal doesn't have.
- Turned down: an embedded terminal over the takeover PTY (no structure, no confinement beyond the terminal's),
  parsing `claude -p` stream-json by hand (the SDK already does it, and it is 10db's fallback adapter), and per-turn
  model scoring beside Claude's own sizing (two sources for one field; a second opinion's finding).
