# An unattended judge call waits longer and is tried once more on a timeout

- **Date:** 2026-11-25

## Decision

- A judge call carries a budget (`JudgeBudget` in `@10db/contracts`): attended, the default, or unattended.
- An attended call (a chat, a pass, Plan, the sizing wait at a start) keeps one try of `JUDGE_TIMEOUT_MS` (4 s),
  since a person is waiting.
- An unattended call gets `JUDGE_UNATTENDED_TIMEOUT_MS` (12 s) a try and `JUDGE_UNATTENDED_ATTEMPTS` (2) tries.
  Only a timeout is tried again; an error, a missing key and a stopped call are not. The unattended calls are the
  first `crosses_limit` call of a session whose policy is unattended (a lane: a task's steps, its gate fixes and
  reviews) and the `test_value` call. The second opinion and acceptance keep their own budgets and one try.
- `judge_calls.attempts` records the tries a call took, and `latency_ms` the whole wait over them.
- The judge's outage card is raised for a failure that won't clear alone at once, as before. Any other needs
  most calls failing over 5 minutes (at least 5 failures, more failures than answers), or 2 minutes failing with
  no answer between. "5 failures in a row" and "10 minutes failing" no longer raise it.
- The card names the provider from the Decisions account's kind and the model the call asked: "Decisions run
  on OpenRouter, typesafe/jev-1.14."
- The budgets depend on who waits, never on the provider: OpenRouter, Anthropic API and Bedrock accounts get
  the same ones. A plan login can't run Decisions, so it falls back as before.

## Why

On 2026-11-25 between 22:00 and 23:00Z, typesafe/jev-1.14 on OpenRouter answered most calls in 0.3–1.5 s,
but 7 to 22 calls each 10 minutes ended `fallback_timeout` at 4.4–5.5 s, the worst during a Mac load of 25–35
on 10 cores. Each fell back to the rules, which skip more than the judge would, and the outage card fired for a
slow tail, naming "the provider". A crosses-limit replay on Bedrock (Haiku 5.5 first, Sonnet 5.5 second) missed
2 of 53 cases, both `make db-prepare`, whose make recipe makes the prompt large, and both "No answer within
4 s".

Nobody waits on a lane's call, so a longer wait costs little and a skip costs a step's work. A person in a chat
or a pass waits on every call, so their budget stays short. A single longer budget for every call was turned
down for that reason. A 12 s total split over two tries was turned down because the slow prompts need more than
4 s on one try. Retrying an error was turned down: a rejected key or a refused model fails the same way again.
