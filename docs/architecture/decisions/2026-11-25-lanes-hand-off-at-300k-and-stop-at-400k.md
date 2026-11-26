# Lanes hand off at about 300k tokens and are told firmly at about 400k

- **Date:** 2026-11-25
- **Amends:** the context thresholds of `docs/architecture/research/spikes-summary.md` (M1b plan changes, item 3),
  which set 40 / 50

## Decision

A new project's context thresholds default to `handoffPct` 30 and `nudgePct` 40 (`ProjectInput` in
`packages/contracts/src/entities.ts`). On a 1M-token window a lane gets the soft nudge (finish the step it is on,
commit it, then call `write_handoff`) at about 300k tokens and the firm one (call `write_handoff` now) at about
400k. The runner's comparison is unchanged. Desktop setup sends no thresholds, so the contract's defaults are the
only source.

Existing projects: migration 0118 moves a project whose stored pair is exactly the old defaults (40 / 50) to
30 / 40. Every other stored pair, including one where only one of the two numbers was changed, is kept.

The thresholds are shares of the session's window, so they apply the same way on a Claude plan, on Claude through
Bedrock or an API key, and on a ChatGPT/Codex plan.

## Why

- Anthropic's docs and 2026 studies show accuracy and recall degrading gradually as context grows, with no
  threshold below which a session is safe, so an earlier handoff at a clean boundary costs little and keeps
  quality higher.
- 400k is the builder's chosen hard point; agent-os's context-cap hook moves to the same numbers, so both tools
  behave alike.
- Matching the old pair, not each column, keeps any project the builder tuned and never leaves a project with
  its firm nudge at or below its soft one (45 / 50 would become 45 / 40 if each column moved alone). Desktop
  setup always wrote 40 / 50 explicitly, so the stored pair is the only sign of an untuned project.

Turned down:

- Rewriting every project to 30 / 40: it overrides values the builder chose.
- Leaving every stored project alone: projects nobody tuned would keep handing off at about 400k and 500k.
