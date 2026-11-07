# Models come from a catalogue, so no account keeps a model map

- **Date:** 2026-11-07
- **Amends:** decision 105 (it drops the account's model map and offered aliases, and changes nothing else
  about accounts), and the sentence of
  `decisions/2026-11-05-plan-runs-commands-and-project-tools-through-the-lane-broker.md` that has the launcher set
  `ANTHROPIC_DEFAULT_<ALIAS>_MODEL` for each mapped alias

## Decision

10db knows which models exist and what each is for from a catalogue, not from a table in the source or a map the builder
fills in. The design is `docs/superpowers/specs/2026-11-06-10db-model-catalogue-design.md`; this records what was built
and the points where the build settled a question.

- **Sources.** The models come from models.dev (`apps/daemon/src/catalogue/`) and from each account's own list (what its
  agent reports). The catalogue is fetched daily, 24 hours after the last fetch, and by the Refresh button on Settings › Models, and only a real change
  counts (a hash of IDs, prices, statuses, families, dates and efforts). A release carries a snapshot written at build
  time (`scripts/release/fetch-catalogue.mjs`, run by `scripts/release/build-macos.sh`) that the daemon starts from until
  a fetch works; a release build whose fetch fails fails. The snapshot is not committed.
- **Tiers.** A model's tier comes from its output price: within a maker, only the newest model of each family is ranked,
  Strongest is 30% or more of the highest price left, Fast is 10% or less, and the rest are Balanced. Only models some
  account really offers are ranked, so the tiers depend on what is offered: today's ChatGPT tiers rest on the GPT 5.6
  prices Codex offers, and when Codex offers GPT 6.1, Sol moves to Balanced and Terra to Fast. A builder who disagrees
  overrides a tier in the account's drawer.
- **No map.** `modelChoice` in an account's settings holds `tierOverrides` (a model ID per tier) and nothing else;
  `modelMap` and `aliases` are gone, and a forward-only migration removed them from stored settings. The account drawer
  shows one dropdown per tier, default Automatic, listing only what that account offers, grouped as on the Models page.
  A gateway that reports no list gets a text field per tier. An override naming a model the account's list lacks, or has
  marked unusable, gives way to the tier's automatic choice.
- **A Bedrock account** offers Claude Code's own list plus the catalogue's newest model of each Claude family, at the
  builder's word. That is an exception to "the account's list is the final word": Claude Code's list on Bedrock runs
  behind the catalogue, and the builder wants the newest model without waiting for it.
- **No environment variable names a model.** The launcher sets no `ANTHROPIC_DEFAULT_*`, and `session-env.ts` strips
  those a login shell exports. A model is launched by its concrete ID. Claude Code's four aliases survive only as the
  Agent tool's `model` argument on a subscription or an API key. A Plan session's agents on Bedrock and on a gateway run
  on the session's model, because the aliases resolve to older models there, and the session's prompt says so.
- **Prices.** Each account's own price for a model is stored beside the maker's list price. Budget ceilings still use
  Artificial Analysis's cost per task, which is a per-task measurement and not a price per token.
- **Left as they were.** The Plan conversation keeps its role default and picks from the account's whole list. While
  another account of the same maker has a list, an account that hasn't been read yet has its models left unranked, so a
  fresh account does not move a tier.
- **A guard.** `tests/repo/src/model-names.test.ts` fails when non-test source names a model, with an allowlist that
  gives a reason for each entry (today only Claude Code's Agent tool aliases).

## Why

A ChatGPT plan could not run until the builder filled in a map, because 10db understood only Claude Code's four aliases,
and a map is a table someone has to keep current as models change. A catalogue plus each account's own list makes a new
model reachable without an app release and without anyone's edit. Price is a proxy for strength, but it is the one signal
every maker publishes, and Artificial Analysis's scores (which need the builder's key and do not cover every model) never
set a tier. Ranking only what is offered keeps one maker's retired or unavailable models from pushing the rest down a
tier. The Bedrock exception exists because Claude Code's list there is the stale one. Environment variables that name a
model were turned down because they made the account's list not the only word on what runs, and each one would be a place
to edit when a model changes.
