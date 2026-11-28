# The judge asks a plan-only project in a one-shot session

- **Date:** 2026-11-27

## Decision

With no Decisions account set (`JudgeConfig.accountId` null), a judge call whose project runs on a Claude plan
(`claude_subscription`) or a ChatGPT/Codex plan (`codex_signin`) is asked as one tool-less, one-shot question on
that project's own account: Claude Code's `complete` or Codex's tool-locked `completeWithCodex`, in a new empty
folder, at the account's Efficient tier and low effort (`daemon/project-question.ts`, shared with the stakeholder
answer writer). The project is the call's `projectId`, else its task's, else its workstream's task's
(`daemon/judge-session.ts`).

- The prompt carries the same system text, content, question and options as a direct call and asks for JSON only;
  the reply is read into the same typed answer (`judge/session-answer.ts`): an option matched ignoring case with its
  confidence clamped to 0..1, or a probability for every yes/no question. A malformed or unoffered answer is an
  error, never a low probability.
- One try, `SESSION_JUDGE_TIMEOUT_MS` (60 s) or the request's own longer timeout. At most two such questions run at
  once; a queued one waits under the call's own timeout.
- The row in `judge_calls` is a direct call's: the session's model, `attempts` 1, no cost. The caller applies its
  floor as before. A failed or timed-out session falls back as a direct call does, and its detail ends with "A
  Decisions account would have settled it."; a call that had no session keeps the no-credential detail.
- `crosses_limit` and `crosses_limit_second` never take this path: limits inside a session are judged as today, and
  they block a live tool call where a CLI start is too slow.
- A session call reports nothing to the judge's outage watch or `lastFallback`.
- Any call with a Decisions account set, and a project on an API-key or Bedrock account with none, is unchanged.

## Why

A plan login can't run judge calls (`PLAN_LOGIN_CANT_DECIDE`), so a builder with only a plan saw every judge row
fall to its rule or to them. Provider parity says a feature works on every account without moving the project to
another provider; the project's own account is the builder's billing line, so the question runs there.

The outage watch is about the Decisions account. A plan-project session failing says nothing about it, and calls
with no project would raise the outage card while plan-project calls cleared it, so the card would flap.

Turned down: running the limits decisions this way (too slow for a blocked tool call); counting the session's cost
from usage (a plan reports no dollar price per call).
