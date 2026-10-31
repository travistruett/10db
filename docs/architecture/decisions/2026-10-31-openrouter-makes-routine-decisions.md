# 10db asks fast models for its routine decisions through OpenRouter, and keeps its rules as the fallback

- **Date:** 2026-10-31
- **Amends:** factory spec §7 for routing only (a model may now skip a review step); permissions stay as
  the decision that lanes run in auto mode inside the sandbox (2026-10-31) says.

## Decision

Design: `docs/superpowers/specs/2026-10-31-10db-openrouter-decisions-design.md`.

- The daemon's **judge** (`apps/daemon/src/judge/`) asks a model a typed question through OpenRouter with one key
  (Keychain service `10db`, account `openrouter-api-key`): TypeSafe's System One models on OpenRouter's
  `systemone` endpoint, any other model on its chat completions endpoint with a JSON-schema answer. It never
  throws; off, no key, timeout, an error or an unparseable answer each fall back to today's rule.
- Every call is logged (`judge_calls`), and Settings › Decisions shows the key's status (never the key), a
  connection test, a master switch, each decision's switch, model and confidence floor, and the recent calls.
  `TENDB_JUDGE=off` keeps a daemon from reading the key.
- **The first decision is whether a change needs its review step.** Risk tags, a pinned review and a large diff
  always review. Otherwise the judge may skip the review when it answers `skip` at or above the floor (0.8 by
  default, model `typesafe/jev-1.13`). It acts from day one.

## Why

On 2026-10-31, 10db's event log showed 45 finished tasks averaging 7.3 hours of wall time for 36 minutes of
sessions; every task paid for a review queue and session, and 36 of 44 reviews sent nothing back. A System One call
costs about $0.0002. The builder chose OpenRouter for every model so the model behind a decision can change without
code, and chose to act from day one with every call logged.

Turned down: TypeSafe's own API and SDK (a second key and vendor, and no other models); a shadow period before
acting (the builder's choice; the log and the per-decision switch cover a bad answer); letting a model answer
permission cards (auto mode does that, inside the sandbox). This supersedes the plan in task "Make 10db's routine
decisions with a fast System One model when the builder adds a key, and with today's rules when not", whose rule
that a model may never skip a step is relaxed for the review step only: the gate has passed and CI still decides.
