# 10db model catalogue design

**Status:** designed, not built. Written 2026-11-06, and reviewed that day: an engineering review on real catalogue data, and a
plan review against the code.

## Why

A ChatGPT plan account can't run until the builder hand-fills a Model map, because 10db only understands Claude Code's
four aliases. With an empty map, `modelMap[alias] ?? alias` sends the word `sonnet` to Codex. The builder rejected this:
nobody should maintain a map, and no model should be hard-coded. 10db should know what every integration can run and
what each model is good for, and the work should flow to the right one. The list has to stay current without an app
release.

The builder's picture: 10db builds a catalogue, records what each integration provides, annotates the catalogue with
prices and scores whenever it changes, and shows it all in one clear list.

## Goals

- Adding an account makes its models routable with no model entry by the builder.
- A new model, price or retirement reaches 10db without an app release.
- One list shows every model with its tier, where it's available, Intelligence and Coding scores, price, speed and use.
- Every step shows the model that ran and why.
- It costs nothing to run: free sources, with the builder's own keys where one is needed.

## Non-goals

- Running lanes through OpenRouter. It is a data source here, and still only runs the judge's decisions.
- Comparing vendors to choose one. A project's account decides the vendor, and routing stays inside that account.
- Changing a step's need, floors, budget ceilings or the escalation ladder, beyond reading models from the catalogue.
- Connect, which is the separate change `2026-11-06-connect-signs-an-account-in-from-the-app.md`.
- The agent profiles editor. Personas already hold a role, instructions, skills, a minimum score and a pin, and a project's
  team binds them. Managing them on a screen is the next project. This one provides what it needs: role settings at both
  levels, patterns and task overrides, with plain Settings forms.

## Deferred

- **Preferring the model with the most room under usage limits.** Claude names limits per family, nothing shows Codex's
  are per model, and 10db stores them per account, so the rule would only work on Claude. Flat-rate accounts use the
  same rule as every other account until limits are available per model. Decided in review, 2026-11-06.

## Anti-goals

This fails, even if it works, if:

- A model ID, alias or price ordering sits in the repo as data someone must update.
- An unknown model is silently treated as strongest or weakest, so work lands on it by accident.
- A source being down stops work that could otherwise run.
- A model changes under a step that has already started.
- A named model gets its own rule in code. Fable is reached through settings and patterns like any other model.
- Artificial Analysis data reaches the repo, fixtures or docs. The rule in `AGENTS.md` stands.

## What exists to build on

- `apps/daemon/src/routing/catalogue.ts`: three tiers, but only for the four Claude aliases, with AA slugs in code.
- `apps/daemon/src/routing/router.ts` and `role-defaults.ts`: route by score, else by role default. `role-defaults.ts`
  considers only the Claude aliases.
- `apps/daemon/src/benchmarks/`: a daily AA sync using the builder's own key, storing into `model_profiles`, joined by
  slug. It works for any provider in principle, but only Claude profiles are seeded.
- `model_profiles`: scores, cost per task, speed, and observed step counts, per provider, model and effort.
- `packages/contracts/src/accounts.ts`: `modelMap` and `aliases` in account settings.
- Alias strings outside routing: `SHAPE_AGENT_MODELS`, `NAMING_MODEL` in `area-namer.ts`, `UNPLANNED_MODEL` in
  `packages/db/src/store/workstreams.ts`, `CLAUDE_CODE_ALIASES` in `environment/launch.ts`, and the seeded team.
- The desktop has no page for any of this model data today.

## The design

Four layers, each answering one question.

### 1. What can this account run?

The account's own live list is the final word. It says what can run, never how good it is.

| Kind                                   | Source                              | Status                  |
| -------------------------------------- | ----------------------------------- | ----------------------- |
| ChatGPT plan                           | Codex `model/list`                  | run live on 2026-11-06  |
| Every kind that runs on Claude Code    | the Agent SDK's `supportedModels()` | documented; not run yet |

Subscription, API key, Bedrock and gateway accounts all run on Claude Code, so one call covers them with no AWS or
provider API code. If the first step of the work shows a kind returns aliases with no `resolvedModel`, that kind uses
the no-list rule below until a later change gives it a list.

A list refreshes on Connect, on a successful identity check, and at most daily when a session starts on the account.
When a read fails, the last stored list stands and the page shows its age.

### 2. What is this model?

The catalogue is fetched at runtime, so it needs no app release.

**models.dev** (`https://models.dev/api.json`, MIT, updated within hours) is the one source: name, family, price, limits,
reasoning support, release date and status, for 235 providers. It lists Bedrock's exact IDs and OpenRouter's models and
prices, so one fetch fills in Claude, ChatGPT, Bedrock and OpenRouter. Only the providers 10db reaches are kept from the
5.9 MB file.

A release embeds a catalogue snapshot generated in CI, so a first launch with no network still knows its models. The
snapshot is a build output and is not in git. A fetched catalogue replaces it. If the fetch fails during a release build,
the build fails. Tests and the gate never reach the network: they use a small committed fixture of real IDs and prices,
with no AA data.

10db checks the catalogue daily, and only a real change counts: a hash of the IDs, prices and statuses it uses.

Model IDs join in this order: exact ID within the vendor; then a normalised ID (case, dots and hyphens, vendor prefix).
Bedrock IDs match exactly under models.dev's `amazon-bedrock` provider. An ID that doesn't join is **Unknown**. A fuzzy or best-guess match is never made.

### 3. How strong is it?

When the catalogue changes, 10db annotates the changed models:

- Artificial Analysis scores and speed with the builder's own key, under its free tier of 100 requests a day. The list
  endpoint is one request. Scores stay in the local database, and the page credits Artificial Analysis.
- While a routable model has no score, 10db asks again once a day, because AA measures a model after it launches.

An AA slug joins by one rule for every maker: the model's normalised ID, or that ID followed by `-<effort>`, looked up
among the slugs AA actually lists. Nothing per-vendor lives in the repo, and a slug that doesn't match leaves the model
unscored.

A model's efforts come from the account's list when it reports them, as Codex and the SDK do. Where a list reports none,
every `Effort` value is assumed, as 10db does today.

With no AA key, or no AA entry for a model, the rest still works: only those columns are empty.

### 4. Which tier is it?

No source publishes tiers, so 10db derives them from price. A model has one tier, shown in one column, whichever account
offers it.

The ranked set is one maker's models that any of the builder's accounts offers. The maker is the catalogue's, so Claude
on Bedrock ranks with Claude on a subscription. Bedrock and gateways keep only models their runtime can run: Claude
Code runs Anthropic's models there, so another maker's model on those accounts is listed as Not runnable and never
routed.

1. Retired and hidden models are left out.
2. Within each family, only the newest model is ranked, using models.dev's `family` and `release_date`. Older versions
   can cost more than newer ones, so they are listed as Superseded and not routed automatically.
3. Compare output price against the most expensive model left. Strongest is 30% or more of it, Fast is 10% or less, and
   the rest are Balanced.
4. A maker with one model fills every tier. The nearest-tier rule in `role-defaults.ts` covers a tier an account has
   nothing in.

Within a tier, an Automatic step with no scores takes the tier's cheapest model the account offers, and **Top of tier**
takes its most expensive. So Opus keeps today's plan and review work, and Fable takes the high-stakes steps. Fable is
enabled for routing, and the settings and patterns above decide when it runs.

Tiers never compare makers. A model with no price is Unknown.

Artificial Analysis scores never set a tier. They appear in the list and feed the existing check that a model clears a
step's need.

This gives the expected tiers on 2026-11-06's prices: Fable and Opus Strongest, Sonnet Balanced, Haiku Fast; Astra and Sol
Strongest, Terra Balanced, Luna Fast. Price is a proxy, so the first step of the work rechecks it against the current
catalogue, and a tier dropdown corrects a wrong result. If the rule can't produce those tiers, stop and bring it back to
the builder.

## Choosing a model

The builder said: be smart, be flexible and configurable, roles and patterns can be set up, and tasks can override. They
also want Fable used for the right things, not excluded. No model gets special treatment in code.

### What the builder sets

A setting is a tier, a specific model, or Automatic. The first setting that applies wins:

1. **The task's own setting.**
2. **A pattern**, the project's before the global ones.
3. **The role's setting**, the project's before the global one.
4. **10db's default for the role**: the table in `2026-10-28-routing-role-defaults.md`.

A pattern is a rule of the form "when this work matches, use this". It matches on any of: role, risk tag, area, and
whether the step is a retry. It sets a tier, a specific model, or **Top of tier**. So "security review uses Fable" and
"anything in `billing` uses Strongest" are both data the builder owns. 10db seeds one editable pattern: work tagged
security, auth or migration uses Top of tier.

"Pattern" is the word here because Settings' Routing rules already means sending a question to a person.

### What 10db works out

The setting decides the pool of models, and the router chooses inside it, so a tier filters `route()`'s candidates. A
step still gets its model when the work is planned, which keeps the cost preview, budget ceilings and escalation working.

- **Normal step:** the cheapest model in the pool that clears the step's need and floors.
- **Top of tier:** the strongest model in the pool. A floor or an escalation also takes the step there, then one tier up.
- **Budget ceilings** still apply on per-use accounts: an over-budget choice is handled as it is today.
- **Automatic:** the pool is everything the account offers.

New models need no approval. They join their tier when the catalogue changes, and existing settings and patterns decide
when they run. A retired model named by a setting falls back to the tier's automatic choice and says so.

Every step shows what ran and which setting or pattern chose it.

## Routing

- Routing stops naming aliases. Role defaults and fixed choices such as the area namer name a tier.
- A persona pin stays a concrete model, because holding a persona to one model is what a pin is for. If its account
  doesn't offer that model, or it has retired, the step takes the tier's automatic choice and says so in its reason.
- A Plan conversation's picker lists the account's whole list, grouped by tier, Unknown models included. Agents a Plan
  session launches keep Claude Code's own aliases, because the Agent tool takes those.
- The launcher writes the concrete model ID on the step, and a step never changes model once started. If the account no
  longer offers the planned model when the step starts, it takes the tier's automatic choice and says so.
- Claude Code's own aliases remain only where Claude Code itself requires one, such as an agent's `model` field and the
  `ANTHROPIC_DEFAULT_*` values the launcher sets. They are generated from the tiers.
- `settings.modelMap` and `settings.aliases` go away. `v0.1.0` is tagged, so migrations are forward-only
  (`packages/db/AGENTS.md`). A `--custom` migration renames the four aliases in stored rows to their canonical IDs, and
  removes those two keys from `accounts.settings`, because the settings schemas are strict and would reject them. Those
  four names in one frozen migration are history, not data anyone updates. The builder has said no installed data needs
  protecting, so the migration has one regression test and no rehearsal.
- `step.reason` carries the explanation already: which tier, which model and why.

### Overriding a tier

Each account has one dropdown per tier in its drawer, listing only what that account offers, with **Automatic** as the
default. This replaces the map, and most people never touch it.

A gateway that lists no models is the one case with typed entry: the builder names a model ID against a tier, because
nothing else can say what it serves.

### Unknown models

An Unknown model appears in the list and its account's dropdowns, and can be chosen by hand. Automatic routing never
selects it.

An account whose tiers can't be filled, because all its models are Unknown, refuses to start a step with a card that
says so and links to its dropdowns.

## The Models page

Settings already has a placeholder, `SettingsSectionKey.Models` ("Models and benchmarks"), which this fills.

- A segmented control filters by **All, Fast, Balanced, Strongest**. An account filter sits beside it.
- One sortable row per model: name and ID, tier, where it's available, Intelligence, Coding, input and output price,
  speed, and how many of the builder's steps used it.
- Clicking a row opens a drawer: every source's facts and their age, scores per effort, first-pass rate and escalations
  from `model_profiles`, and accounts offering it.
- A model with no data shows a dash, never a zero. Unknown models are marked and sort last.
- The page states where its data came from and when, with credit to Artificial Analysis.
- Only models 10db can reach are listed: not the whole 235-provider catalogue.

## Regression contract

Before routing changes, capture today's choices in one table test: for an unconfigured Claude project, one row per role
and risk tag, with the model and effort it gets now. The new code must give the same answers. The one listed exception
is the seeded pattern, which takes security, auth and migration work to the top of the tier. A test also moves a project
to another account and checks its steps re-resolve there.

## Storage

`model_profiles` stays the one home for model data, so the router, the sync and the Models page can't disagree.

- A row is a model and effort, keyed by the catalogue's canonical model ID (`claude-opus-5-5`), not an alias. It gains
  price, family, maker, tier, status and release date. Scores and observed step counts stay where they are.
- A small table records what each account offers: the canonical ID, the ID that account launches with (for Bedrock,
  `us.anthropic.claude-opus-5-5`), its reported efforts and when it was last seen.
- The fetched catalogue is one stored document, read and written whole.
- Role settings and patterns get their own tables, global or per project.
- `SEED_PROFILES` and `FAMILIES` go away when routing moves off aliases. `DEFAULT_FLOWS` and the role defaults stay.

A step stores both its concrete model and the setting that chose it. A project can move to another account between
planning and launch or part way through a step, and today that works because a step names an alias. Now each session
start re-resolves the setting when the account no longer offers the model, and saves the result on the workstream. A
model with no account row launches under its canonical ID.

Account lists come through the existing identity probe, so there's no new adapter method. `SeenAccount.models` already
carries Codex's list, and Claude's probe adds `supportedModels()`.

Parsing follows two rules at the boundary. An entry that fails validation is skipped, because some models.dev entries have
no price; only a catalogue that fails as a whole is rejected. An effort outside `Effort` is dropped, because Codex reports
`ultra` for three of its four models.

## Failure behaviour

| Failure                  | Behaviour                                                                   |
| ------------------------ | --------------------------------------------------------------------------- |
| models.dev down          | keep the stored copy, else the embedded snapshot, and show the age          |
| AA down or refused       | keep the last scores, rank by score only where they cover every model       |
| An account's list fails  | keep its last list; a session start still runs what it holds                |
| An account has no list yet | use the catalogue's models from its maker until a read succeeds           |
| A listed model refuses at launch | mark it unusable on that account until its list changes, raise a card, and rerun the step on the tier's next model |
| A chosen model is retired | the next step takes the tier's automatic choice and says so in its reason  |
| A catalogue entry is wrong | a tier dropdown overrides it, and the drawer shows the source             |

Every fetch goes through zod at the boundary, and a malformed catalogue is rejected whole, keeping the last good one.

## Calls made without the builder

- Patterns outrank role settings, because a pattern is the more specific statement.
- The one seeded pattern, for security, auth and migration work.
- The Models page marks a newly joined model **New**.
- Role settings go in the existing Team section (project) and Personas and flows section (global), as plain forms.
- One listing call for every Claude Code kind, replacing the Anthropic, Bedrock and gateway APIs the research listed.
- A CI-generated snapshot ships in each release, so a first launch doesn't depend on the network.
- One model has one tier across accounts.
- Persona pins stay concrete models, and the Plan picker lists everything the account offers.
- A model that refuses at launch is marked unusable on that account, and the step moves to the tier's next model.
  Fable on Bedrock is the known case: it fails unless the account's data retention mode is `aws_review`.

## Left to the builder of this

- Column names and exact table shapes, within the storage section above.
- Which step of the order below each file lands in.
- Exact copy and column widths.

## Questions still open

- **AA's consent for the list.** `docs/architecture/open-questions.md` asks whether showing AA data in a public app's
  comparison view needs AA's written consent (Data Platform Terms §2.4(c), §2.5). The Models list is such a view, and the
  research for this design could not read those terms. The builder decided on 2026-11-06 to go ahead with the AA columns
  without waiting for an answer. The question stays listed until AA answers it. The rule against AA numbers in the repo,
  fixtures or docs still holds, and the page credits AA.
- Whether Claude Code's aliases run the configuration AA benchmarks, which is also an open question. It affects the
  score shown against a Claude model.
- Whether AA covers OpenAI's models and how their slugs read. If not, ChatGPT models have no scores and tier by price.
- How `supportedModels()` behaves on Bedrock and gateway accounts.

## Order of work

One pull request, built in one fresh session outside 10db, which may use sub-agents. The builder chose this for speed.

1. Two checks that can stop this design. Recheck the tier rule against the current catalogue. Run `supportedModels()` live
   on a subscription account: its `value` can be an alias and `resolvedModel` is optional, so confirm it gives IDs that
   join, and whether a subscription launches by concrete ID or alias. If either fails, stop and bring it back to the builder.
2. Catalogue fetch, account lists, join and tier derivation, with nothing routing on them yet.
3. The Models page, which shows whether the data is right before anything depends on it.
4. Extend the AA sync past Claude, triggered by catalogue changes.
5. Role settings, patterns and task overrides, and the router's pool and stakes rules.
6. Move routing off aliases, then remove `modelMap` and `aliases` and their form.

Keep those as separate commits, so a problem can be traced to a step. Docs are part of done:
`docs/architecture/04-accounts.md`, `01-factory-loop.md`, and a decision file that supersedes hard-coded aliases.

## Research

Compared on 2026-11-06, from vendor docs and repositories.

- Amp, Cursor and Copilot hide model names behind modes or a cost dial. Aider, Roo and opencode fill roles with defaults
  that can be overridden. opencode reads models.dev and Aider reads LiteLLM's file.
- Copilot, Cursor and Zed filter by what the plan allows.
- None of them carry one role across providers or explain a routing choice well, and Cursor users complain they can't
  see which model ran.

## Decisions from review

The builder decided these on 2026-11-06. They aren't open for the build to change.

- models.dev is the one catalogue source. LiteLLM and OpenRouter's own API are cut.
- Limit-aware routing is deferred.
- `model_profiles` is the single store.
- Tiers come from output price, newest per family, cut at 30% and 10% of the top price. Scores never set a tier.
- The build is one pull request in one fresh session, and sub-agents are allowed.
- A table test pins today's routing before it moves.
- The AA columns go ahead without waiting for AA's answer.
