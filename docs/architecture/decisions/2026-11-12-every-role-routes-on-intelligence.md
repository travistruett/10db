# Every role routes on Artificial Analysis's Intelligence Index

- **Date:** 2026-11-12
- **Supersedes:** decisions 57 and 66; amends decision 56

## Decision

Every step role (plan, plan review, implement, review and QA) is routed on the Artificial Analysis
Intelligence Index. 10db keeps no Coding or Agentic score: a model profile's `scores` holds `intelligence` alone,
`model_profiles` has no `coding` or `agentic` column (migration `0063_drop_retired_scores`), a step records no
score kind, and the benchmark status lists no missing scores. The router has no fallback from a role's own
score to Intelligence, so its reasons say "at or above N intelligence" for every role. The starting needs
(`routing/catalogue.ts`) and the rule floors (`routing/floors.ts`) keep their numbers and are read as
Intelligence Index points. Settings › Models and benchmarks shows no Coding column.

## Why

Artificial Analysis no longer publishes a Coding Index or an Agentic Index. Its free API keeps
`artificial_analysis_coding_index` and `artificial_analysis_agentic_index`, marked deprecated and always null,
and names no successor. Since then every implement and QA step was compared on Intelligence by decision 66's
fallback, with a note on each step saying so. The fallback and the two retired scores only carried that note.

The Intelligence Index (version 5) is a quarter coding: its Coding category is FrontierCode-AA 2.0 and
Terminal-Bench 4.0, beside Knowledge Work, Science and General.

Turned down:

- The Engineering Index, one of AA's new domain indexes on the free tier. It is mostly engineering knowledge,
  science and reasoning; agentic coding is 15% of it, so routing implement steps on it would reward knowledge
  over building software.
- AA's per-benchmark scores (Terminal-Bench, FrontierCode-AA), from which a coding score could be rebuilt. Only
  the paid tier's endpoints return them, and 10db routes on the builder's own free key.
- Keeping the score kinds for steps already stored with one. 10db runs on one machine; a stored step's
  `score` key is left in place and nothing reads it.
