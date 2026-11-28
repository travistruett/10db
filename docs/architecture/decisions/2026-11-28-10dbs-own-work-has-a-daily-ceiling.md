# 10db's own work has a daily ceiling, and a session with nothing to measure it by counts as one unmeasured

- **Date:** 2026-11-28

## Decision

Work 10db starts by itself (a fix task it files, a CI fix, its one re-run of a crashed or stuck run) stops for
the day at the project's ceiling; work the builder starts is never counted or held. The ceiling has three
measures, each checked against what `selfStartedToday` sums for the project's local day: dollars, the share of the
plan's limit, and a count of sessions that could not be measured.

How a session is counted, by what its account can tell:

- A session on a metered account (Bedrock, an API key, OpenRouter) with a cost above zero adds that cost to
  dollars.
- A session on a metered account that used tokens (input, output or cached, any above zero) and has no cost (null
  or 0) adds one to the unmeasured count. That is an OpenRouter session on a model its account's list gives no
  price, which `priceSessionAtListing` leaves as it was, and a Codex session that reports `costUsd: 0`. A metered
  session that used no tokens adds nothing.
- A session on a plan account adds its share of the plan's limit when it heard one, else one to the unmeasured
  count. A plan's dollars are never summed.

The unmeasured count is checked against the sessions ceiling on every kind of account, and Settings says so in
today's line ("n sessions not measured") and in the hint under the sessions field.

## Why

A metered session with no price added to no measure, so the ceiling never stopped 10db's own work on such a model:
a hole in the one brake on self-healing that spends the builder's money. Counting it as unmeasured keeps the
dollar sum honest (nothing is invented) and still lets the session count stop the work. Pricing it by a guess was
turned down: a wrong price looks like a measurement. Leaving it out was turned down: it is the case the brake is
for.
