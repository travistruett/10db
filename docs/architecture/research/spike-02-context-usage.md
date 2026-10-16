# Spike 02: Context usage is readable after each turn

- **Status:** VERIFIED
- **Date:** 2026-10-15
- **Versions:** claude 2.1.300 (Claude Code) · Agent SDK 0.3.299 · Node v25.2.1
- **Command:** `pnpm --dir spikes/agent-sdk spike:02`

## Question

Context usage is readable after each turn.

## Result

`getContextUsage()` works between turns and mid-turn, and the session continues normally afterwards. The
probe line was `SCALE=0-100 of maxTokens (rounded to an integer)`: `percentage` is `100 × totalTokens /
maxTokens` rounded to the nearest whole number (22,074 / 1,000,000 → `2`; in the first run the raw ratio was 90.6 only
because of that rounding). For `claude-haiku-5-5`, `maxTokens` and `rawMaxTokens` were both 1,000,000. Latency in the recorded run: `summary` 7 ms after turn 1 and 10 ms after turn 2,
14 ms mid-turn (fired on the first assistant message, without blocking the pump); `full` 496 ms. Earlier runs
were in the same range. `isAutoCompactEnabled` was `false` and `autoCompactThreshold` was absent, so the threshold check
passed vacuously. Spike 3 traced that to the builder's own `autoCompactEnabled: false`, which reaches the session
despite `settingSources: ['project']`. With `settings: { autoCompactEnabled: true }`, the threshold is 967,000 of
1,000,000 tokens (96.7%). **The window is configurable.** With `settings: { autoCompactEnabled: true, autoCompactWindow: 200000 }`,
`maxTokens` and `rawMaxTokens` became 200,000 (`WINDOW_SETS_MAXTOKENS=yes`), the same 18,209-token baseline read
as 9%, and `autoCompactThreshold` was 167,000: **83.5% of the window, below M1a's 85% firm nudge**. On the default
1M window the threshold is 96.7%. `result.usage` gives per-turn
`input_tokens`/`cache_read_input_tokens`/`cache_creation_input_tokens` (2 + 14,298 + 7,774 = 22,074 for turn 2,
exactly `totalTokens`), so it could approximate the number, but `maxTokens` only comes from
`getContextUsage`.

## Evidence

```
INFO with settings.autoCompactWindow = 200000: {"percentage":9,"totalTokens":18209,"maxTokens":200000,"rawMaxTokens":200000,"isAutoCompactEnabled":true,"autoCompactThreshold":167000,"model":"claude-haiku-5-5"}
WINDOW_SETS_MAXTOKENS=yes
INFO usage after turn 1 (summary): {"percentage":2,"totalTokens":18209,"maxTokens":1000000,"rawMaxTokens":1000000,"isAutoCompactEnabled":false,"model":"claude-haiku-5-5"}
INFO usage after turn 2 (summary): {"percentage":2,"totalTokens":22074,"maxTokens":1000000,"rawMaxTokens":1000000,"isAutoCompactEnabled":false,"model":"claude-haiku-5-5"}
INFO latency ms: {"summary":7,"full":496,"summaryTurn2":10,"midTurn":14}
INFO percentage vs 100 × total / max: {"percentage":2,"exact":2.2074,"roundedToInteger":true}
SCALE=0-100 of maxTokens (rounded to an integer)
INFO autoCompactThreshold as % of maxTokens: {"raw":null,"pct":null}
PASS percentage is a number: 2 → 2
PASS maxTokens known: 1000000
PASS scale settled: 0-100 of maxTokens (rounded to an integer)
PASS usage grows with context: 18209 → 22074
PASS callable mid-turn without blocking: {"ok":true,"ms":14,"percentage":2}
PASS callable between turns without ending the session: ok
PASS auto-compact threshold above the 85% firm nudge: threshold ≈ unknown%
RESULT 02-context: no failures
```

The block above is verbatim from the last run, which added the `autoCompactWindow` probe. The first run failed
`scale settled` (ratio 90.58) because the integer rounding was not accounted for; the probe
now also accepts a `percentage` within 0.5 of the exact value.

## Consequence for M1

M1b Claude adapter computes context as `100 × totalTokens / maxTokens` from
`getContextUsage({ detail: 'summary' })`, called per assistant message. It must not use `percentage`, which is
rounded to an integer. M1a's 70% and 85% thresholds work on that exact value. With auto-compaction
set on explicitly (spike 3) and the default 1M window, it triggers at about 96.7% of `maxTokens`, so M1a's 70% and
85% thresholds sit below it, but 70% is 700k tokens. With `autoCompactWindow: 200000` the threshold is 83.5%, so
M1a's 85% firm nudge would never fire before compaction, and `nudgePct` must sit below 83.5%. A session's
baseline in a bare fixture repo is about 18k tokens (1.8% of 1M, 9.1% of 200k). M1b's live run assumes a 200k
window for `handoffPct` 12, which the models don't report unless `autoCompactWindow` is set.
