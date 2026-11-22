# 10db's decisions run on any account with an API: OpenRouter, an Anthropic API key or Bedrock

- **Date:** 2026-11-21
- **Amends:** `decisions/2026-10-31-openrouter-makes-routine-decisions.md` (the judge asks OpenRouter only)

## Decision

Design: `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`, "Decisions on any API
account".

- `JudgeConfig.accountId` may name an OpenRouter, Anthropic API key or Bedrock account
  (`DECISION_ACCOUNT_KINDS`, `powersDecisions` in `@10db/contracts`). A plan login (Claude or ChatGPT) can't:
  "a plan login has no API for quick decisions" (`PLAN_LOGIN_CANT_DECIDE`).
- The judge asks the credential's own API (`judge/ask.ts`): OpenRouter's three request shapes as before,
  Anthropic's Messages API with a JSON-schema output, or Bedrock's runtime signed by the account's AWS profile or
  bearer token. Confidence on the last two is the answer's own, clamped to 0..1.
- **Switching the account is one change.** Every decision's model becomes the new account's default (OpenRouter:
  `typesafe/jev-1.13`; the others: the account's Efficient tier model, by the id the account is called with), and
  the switch is refused unless that model answers a test decision first. A model named with it must belong to the
  account's list. An account whose model list hasn't loaded is refused. A call in flight finishes on the old
  account, since the credential is read per call.
- On Anthropic and Bedrock a decision's model is one the account lists; on OpenRouter the test decision is the check,
  as before.
- The Decisions account can't be archived: switch Decisions first.
- When its secret is missing or changed, every call falls back to 10db's rules and Settings › Decisions says so.
- The benchmarks sync reads the Decisions account's key when it is OpenRouter, else any live OpenRouter account's,
  else is off; an Anthropic key or a Bedrock token never goes to openrouter.ai.

## Why

A builder with a Claude or Bedrock account should not need a second vendor's key to get judgment. The test on every
switch keeps `crosses_limit`, which decides what a lane may do, from running on a model that can't answer. A plan
login has no API for a quick call; running decisions on one through a short session is a follow-up task.

Turned down: keeping OpenRouter as the only decision provider (a second key for every Claude-only builder);
per-decision accounts (a decision's account is app-wide, like its floor).
