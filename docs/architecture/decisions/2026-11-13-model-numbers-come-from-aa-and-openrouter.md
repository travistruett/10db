# A model's numbers come from Artificial Analysis and OpenRouter, are shown with their source, and never route

- **Date:** 2026-11-13

## Decision

- **Shown, not routed on.** Routing reads `model_profiles`, which keeps Artificial Analysis's (AA's) values only.
  The OpenRouter sync writes `openrouter_measures` and nothing else: no profile, no score a role is picked by.
  A role never gets a different model because OpenRouter's numbers arrived.
- **The merge rule, per figure, first match wins.** Intelligence, Coding and Agentic: AA for that effort, else AA's
  score as OpenRouter relays it, on the model's Max effort row only. Cost per task: AA alone, scaled to the account
  as before; OpenRouter's own evaluation cost is never shown as cost per task. Speed: OpenRouter's p50 on the
  account's provider (Anthropic for a Claude plan or Anthropic key, Amazon Bedrock for Bedrock, OpenAI for a
  ChatGPT or Codex plan or an OpenAI key), else the median across the providers that have one, else AA's. A
  provider without a throughput is skipped, never read as zero, and a speed row older than a day is ignored.
  Every figure on a model row names its source (`aa`, `aa_via_openrouter`, `openrouter`, or none).
- **Decision models** show a cost per million decisions and a time per decision, each with its source: the
  builder's own logged calls over 30 days, else OpenRouter's price over the builder's typical decision size (a
  fixed guess when no call can say) and OpenRouter's latency, else nothing.
- **Reading OpenRouter.** One sync, with the key of the account decisions run on: scores and the model list daily,
  each wanted model's speeds at most hourly, every request through one pacer at 20 a minute, under its
  documented rate limit. It never runs on a page view and never under `TENDB_JUDGE=off` or `TENDB_BENCHMARKS=off`.
- **OpenRouter's data stays the builder's own.** Its terms make its data and compilations OpenRouter's or its
  licensors' and allow use only as OpenRouter authorizes, and forbid scraping its site, reselling API access and
  building a competing service. 10db reads the documented API with the builder's own key and shows the result to
  that builder only. It never scrapes openrouter.ai pages, and never commits OpenRouter's numbers, puts them in a
  fixture or ships them in a release snapshot. AA numbers that arrive through OpenRouter keep AA's attribution
  and rules, and stay on the machine.
- **Provider parity.** Every account kind runs agent models and shows the same rule; only the provider the speed
  is read for differs, and a gateway, or no account chosen, takes the median. A builder with no OpenRouter account
  picked for decisions sees AA's numbers alone, as before, and decision models behave the same on every account
  kind because decisions always run on the OpenRouter account.

## Why

Scores from a second source are useful to see, but routing on them would make a model pick change with no change
by the builder, and the two sources do not measure the same thing: AA scores an effort, OpenRouter reads a model.
Showing the source beside every figure lets the builder weigh each, and keeping routing on AA alone keeps the
choice stable and testable (a routing test fixes a profile set, adds OpenRouter rows that would change the pick
if read, and asserts the pick is unchanged).

Speed is the one figure OpenRouter measures better than AA, per provider and recently, so it comes first for an
account whose provider is known. The relayed scores show on the Max effort alone because OpenRouter names a model,
not an effort, and a Max row is the one a bare model name stands for.

Turned down: merging the sources into the profiles (routing would follow whichever synced last); a fuzzy join of
OpenRouter's ids to the catalogue (a wrong row is worse than none, so a model with no exact, canonical or
normalised join shows no OpenRouter number); reading OpenRouter on a page view (a burst would trip its rate
limit).
