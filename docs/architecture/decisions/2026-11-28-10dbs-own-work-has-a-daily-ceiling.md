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

What is held, and how the builder is asked:

- A run is checked when `selfStarted || autoRerun`. A fix task or CI fix 10db filed is `selfStarted` for life, so a
  gate fix task counts against the ceiling; the builder's own run counts only the one session 10db re-runs after a
  crash, a stall or a recovery (`autoRerun`, cleared by the insert of that session). Second reviews, send-backs
  inside a builder run and judge calls are not counted.
- The ceiling never stops a running session. The scheduler leaves a checked run at the ceiling Queued with a
  `ceiling` wait and never launches it; the runner, about to start a further session of a checked run, puts it back
  with `requeue` once and the scheduler holds it. A tick reads each project once, so runs launched in the same tick
  can pass the ceiling by the lanes launched.
- One Money card per project, day and allowance, raised by the scheduler when it holds a checked run: Carry On Today
  raises the day's allowance by one ceiling of each measure and releases the waiting runs; Wait Until Tomorrow leaves
  them waiting, and a card that was answered is not raised again that day. A second ceiling after a Carry On Today
  raises a second card. Waiting work is kept, never dropped: it starts at local midnight or on Carry On Today, and a
  tick on a later day withdraws an unanswered card of an earlier day.
- On a project that moved to its fallback account the card says what that account has spent: "<Account> has spent $N
  today: carry on or wait for the plan".
- Settings › Billing holds the three fields (dollars, share of the plan's limit, sessions not measured; $10, 10% and
  20 by default) and today's counted line with the measure the project's account is counted in. The share is the
  account's whole rise while a session ran, so other use of the plan then counts as 10db's and 10db stops early,
  never late; Settings says so.

## Why

A metered session with no price added to no measure, so the ceiling never stopped 10db's own work on such a model:
a hole in the one brake on self-healing that spends the builder's money. Counting it as unmeasured keeps the
dollar sum honest (nothing is invented) and still lets the session count stop the work. Pricing it by a guess was
turned down: a wrong price looks like a measurement. Leaving it out was turned down: it is the case the brake is
for.
