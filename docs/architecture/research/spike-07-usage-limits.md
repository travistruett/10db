# Spike 07: The shape of usage-limit signals

- **Status:** PARTIAL
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:07`

## Question

The shape of the usage-limit error, and whether it includes a reset time.

## Result

The earlier probes recorded 36 `rate_limit_event` messages. Every one had `status: 'allowed_warning'` and
`rateLimitType: 'seven_day'`, with `utilization: 0.96` (a 0–1 fraction) and `surpassedThreshold: 0.75`. The
builder's weekly limit was at 96% when the spikes ran. `resetsAt` is in **seconds** since the epoch: every
sample was 18.8 hours ahead of the clock, the 2026-10-16 04:00 local weekly reset. Each event also carries fields
beyond the plan's type list:

- `unifiedWindows`, with `five_hour` and `seven_day`, each as `{ utilization, resetsAt }` (`five_hour`:
  utilization 0);
- `overageEnabled: true`.

No `assistant` frame carried an `error`. Overage: `overageStatus: 'rejected'`, `overageDisabledReason:
'out_of_credits'`, `isUsingOverage: false`, no `overageResetsAt`. So extra usage is enabled on the account but
can't be spent, because no credits are left. **The `rejected` path was not observed.** Forcing it would spend the
week's remaining quota, so its handling is designed from the types.

## Evidence

```
INFO events recorded: 36
INFO distinct statuses: ["allowed_warning"]
INFO distinct rateLimitType: ["seven_day"]
INFO assistant errors: []
INFO overage fields: [{"overageStatus":"rejected","isUsingOverage":false,"overageInUse":null,"overageDisabledReason":"out_of_credits","overageResetsAt":null}, …]
INFO any event using overage: false
INFO resetsAt samples: [{"unit":"s","hoursAhead":18.8,"rateLimitType":"seven_day"}, …]
PASS rate_limit_event observed: 36 event(s)
PASS resetsAt units consistent and plausible (0–8 days ahead)
PARTIAL rejected status observed: not forced (by design); handling is designed from the types
RESULT 07-rate-limit: no failures
```

The latest event in full: `{"status":"allowed_warning","rateLimitType":"seven_day","utilization":0.96,
"surpassedThreshold":0.75,"overageEnabled":true,"overageStatus":"rejected","overageDisabledReason":"out_of_credits",
"isUsingOverage":false,"resetsAt":1792148400,"unifiedWindows":{"five_hour":{"utilization":0,"resetsAt":1792098000},
"seven_day":{"utilization":0.96,"resetsAt":1792148400}}}`.

## Consequence for M1

- M1b adapter maps `rate_limit_event` with `status: 'rejected'` → `usage_limit { resetsAt: resetsAt × 1000 }`
  (seconds, confirmed live; M1b's "below 10¹² = seconds" rule holds). It maps an `assistant` frame with
  `error: 'rate_limit'` to the same event, with `resetsAt` from the latest event, or now + 5 h if none.
- M1a moves every lane on that provider to `PAUSED_LIMIT` and schedules a wake at `resetsAt`.
- The fake adapter scripts both shapes.
- `allowed_warning` with `utilization` (0–1) is recorded for the frontier data, and pauses nothing.
  `unifiedWindows` gives both windows' utilization in one event, so it is the better source for that record.
- An event with `isUsingOverage: true` (or `rateLimitType: 'overage'`) is treated like `rejected`: lanes pause
  instead of silently spending extra usage, using `overageResetsAt` when present. The builder can turn overage
  use on later as an explicit setting. On this account, overage is enabled but out of credits.
