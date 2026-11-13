# One adapter seam with capabilities, and the UI never reads a provider

- **Date:** 2026-11-12

## Decision

- Every agent is an `AgentAdapter` (`apps/daemon/src/sessions/types.ts`). `open(spec)` starts every session of
  every kind; `start` and `startShape` are gone. `AgentSessionSpec` is a core shared by every session plus a
  `profile`: `lane` (a task's session: workstream, sequence, allowed tools, permission mode) or `explore` (the
  engine's attended conversation, a chat or Plan: system prompt, tool lists, agents). Each adapter switches on the
  profile.
- Each adapter reports `AgentCapabilities` (`AgentCapabilitiesDto` in `@10db/contracts`): harness, label,
  steer (`inject` or `queue`), receipts, read-back, picture formats, slash commands, plan, reasoning, subagents,
  model switching, takeover, dollar cost, and `judge`: who judges a call against the trust line's policy
  (`native`, `tendb` or `rules`, `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` §4). Today's
  judge by account kind is reported; the trust line's T3 adds the model, and T5 adds 10db's judge. The tables
  are in `sessions/capabilities.ts`, per spec §5.3 of `docs/superpowers/specs/2026-11-11-10db-sessions-design.md`.
- A capability says what the agent can do, not what 10db has wired yet. Takeover is built with Open in Terminal,
  model switching between turns with the explore engine, Codex's slash commands with streaming, and Codex's
  `plan` with the explore engine on Codex (Sessions M5b; until then `codex-adapter.ts` ends an explore session
  at once). Nothing reads those four capabilities before their feature exists.
- An adapter that injects a message into a running turn reports receipts. `capabilities.test.ts` checks it for
  every adapter and account kind.
- `providerOf` is a table from account kind to adapter id (the `Provider` vocabulary). The routed adapter is a
  registry keyed by it. A new agent is one `Provider` value, one row and one adapter.
- The daemon reads a capability where it once compared a provider; the runner's read-back reads `readBack`.
- The desktop never imports `providerOf` or `Provider` (ESLint). Every new view that names an agent shows
  `capabilities.label`. Some account settings still choose words by account kind (`views/settings/accounts/`).
  The rule doesn't reach those, and a follow-up task moves them onto capabilities.
- Claude Code stays on the Agent SDK directly and Codex on `codex app-server` directly. Another agent comes through
  the Agent Client Protocol, as its own adapter with its own spec.

## Why

- Two start methods kept two copies of one session's shape, and Plan could not run on Codex without a third.
  One `open` with a profile is the narrowest seam both owners need (research T1 §4,
  `docs/architecture/research/2026-11-11-sessions-research.md`).
- A UI that branches on the provider has to change for every new agent. Capabilities say what the agent can do,
  which is what the UI needs, so Gemini through OpenRouter or any later agent needs no UI change.
- Delivery counts an injected message delivered only by a receipt (spec §6.2 rule 3). An adapter that injects
  without receipts would lose messages, so the rule is a tested invariant, and an agent without receipts queues.
- The guard needs Claude Code's in-process hooks, and Codex's exactly-once receipts need app-server's
  `clientUserMessageId`. ACP v1 carries neither (research T2, T3), so the two built agents stay direct.
- Turned down: an id type separate from `Provider` (two names for one thing), and a `providerOf` kept as a switch
  (each new agent edits a function rather than adding a row).
