# An OpenRouter account runs a project's sessions on Codex, and is billed by its listed prices

- **Date:** 2026-11-21
- **Supersedes:** the refusal to run agents on an OpenRouter account that `decisions/2026-10-31-openrouter-makes-routine-decisions.md`
  left in place (OpenRouter powered decisions only).

## Decision

Design: `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`, "OpenRouter runs
projects on Codex". Evidence: `docs/architecture/research/spike-18-codex-on-openrouter.md`.

- An `openrouter` account runs the Codex harness in its own `CODEX_HOME`, with its key in `OPENROUTER_API_KEY`
  from the Keychain. A project, a chat, Plan and 10db's errands (Codex on the Efficient tier model) may use it.
- Its models are OpenRouter's own list read with the account's key, keeping models that list tool support, each
  with OpenRouter's price. OpenAI's models join the catalogue and are ranked into tiers; any other maker's model
  stays under its OpenRouter id and runs through a tier override.
- The kind is metered: a session's cost is its tokens at the listed price, and the account's month adds the
  `judge_calls` cost when decisions run on it, so one monthly cap covers both. A cap pause stops new sessions and
  moves projects to their backup; decisions keep running.
- A turn failing with OpenRouter's 402 ends the session as a refused payment and pauses the account, as other
  billing refusals do. Codex's "Model metadata for ... not found" `error` item is a warning, logged once per
  session.
- The `openrouter-api-key` Keychain item and its move into an account are removed: the item is deleted at start.

## Why

Spike 18 ran a real change through Codex on OpenRouter, so the refusal had no reason left. A builder with an
OpenRouter key can use any model OpenRouter serves without a second provider account.
