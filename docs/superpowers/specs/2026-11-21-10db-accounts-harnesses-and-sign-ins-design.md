# 10db: accounts, harnesses, decisions and sign-ins in one cut

**Status:** designed on 2026-11-21; nothing is built. **Amends** the accounts spec
(`2026-10-17-10db-accounts-design.md`), the OpenRouter decisions spec (`2026-10-31-10db-openrouter-decisions-design.md`)
and the Linear integration spec (`2026-11-21-10db-linear-integration-design.md`, whose part 1 becomes part 4 here).
**Evidence:** a code inventory of every account kind and every job that uses a model, the vendor docs cited under
Provider facts, and one plan review round.

## Brief

**What changes for you.** Settings answers three questions, each once:

1. **Who pays** (Accounts). Five kinds: Claude plan, Anthropic API key, Bedrock, ChatGPT plan, OpenRouter.
2. **What runs a session** (the harness). Each account says which harness it runs: Claude Code or Codex. Today
   every kind has exactly one, so it shows as a label ("Runs Codex"), not a choice. 10db decides everything
   Claude-or-Codex by the account's harness, never by its kind, so a second harness such as Pi is a table row
   and a picker later, not another cut.
3. **What powers 10db's judgment** (Decisions). Any account with an API: an OpenRouter key (its decision models
   or any chat model), an Anthropic API key or Bedrock (their cheap, fast model). A plan login can't, because it
   has no API to call; with no such account, 10db keeps its rules, as today.

Your mixes all work: OpenRouter for everything; a Claude plan for projects and OpenRouter for judgment; Bedrock
for both.

| Account | Runs projects on | Can power Decisions |
|---|---|---|
| Claude plan | Claude Code | no |
| Anthropic API key | Claude Code | yes, its cheap model |
| Bedrock | Claude Code | yes, its cheap model |
| ChatGPT plan | Codex | no |
| OpenRouter | **Codex (new)** | yes, decision models or any chat model |

**Outside services are sign-ins and bindings,** as the Linear spec set out. All Projects lists your sign-ins:
GitHub, Slack workspaces, Artificial Analysis, and each account's Linear sign-in. Each project binds the ones it
uses (its Linear team, its Slack workspace).

**What goes away.**
- **The Gateway account kind** ("Claude Code pointed at another endpoint", a base URL and token). Its only
  named use was Claude Code on OpenRouter, which you don't want.
- **Two ways to hold one OpenRouter key.** One OpenRouter account runs projects and decisions, under one
  monthly cap.
- **OpenRouter's "can't run agents yet" refusals**, and the comment that said it never would.
- **Old Slack test data and the old OpenRouter key item**, deleted rather than migrated.

**What it buys.** One place for each question, an OpenRouter key that does everything, judgment that no longer
needs a second vendor, and Settings designed once instead of patched per integration.

**What could go wrong, and how we'd know.**
- **Codex misbehaves on OpenRouter.** OpenRouter documents Codex, but its Responses API is stateless and 10db has
  never run Codex there. Part 2 opens with a spike: one real lane task, build and review, on an OpenRouter
  account. If it fails, OpenRouter keeps no harness: Billing shows it disabled ("no harness runs OpenRouter
  yet"), it still powers Decisions, and the rest of this design stands.
- **The OpenRouter key leaks to commands.** The key is in Codex's own environment and excluded from every shell
  Codex runs, in lanes and in a terminal takeover, the way the Bedrock token is today.
- **Something still treats "ChatGPT plan" as "Codex".** Eleven known places test the kind; part 1 moves each to
  the harness before OpenRouter can run anything, so a missed one can't run an OpenRouter session as Claude Code.
- **Switching the Decisions account breaks judgment.** The switch moves every decision to the new account's
  model in the same change and is refused unless that model answers a test decision first.
- **Judgment on a chat model is slower or dearer than a decision model.** The 4 s timeout still applies and
  falls back to rules. Settings › Decisions already shows each model's cost and time per decision.

**Calls you might disagree with.**
1. **The Anthropic API key stays** (**decided** by the builder); an OpenAI API key stays reserved.
2. **Bedrock runs Claude Code only.** Claude Code supports Bedrock natively; Codex reaching Claude on Bedrock
   isn't verified.
3. **OpenRouter runs Codex only.** Claude Code on OpenRouter is left out by your call.
4. **One cap covers an account's projects and its decisions,** and a cap pause stops sessions but not judgment.
   Decisions cost cents, and stopping them would drop Codex lanes to the rules floor; the cap can overshoot by
   that much.
5. **10db's own errands run on the project's account.** Area naming runs on the default account today; it and
   the Linear reporter move to the account of the project they serve, so they reach that project's sign-ins.

**What is needed from you.** Nothing to approve this brief. Part 2's spike needs an OpenRouter account with a few
dollars of credit; the one Decisions uses now will do.

---

## Terms

- **Account:** a billing line and its credential (`packages/db/src/schema.ts:204`).
- **Harness:** the program that runs a session: `claude_code` or `codex`. Today `providerOf(kind)`
  (`packages/contracts/src/accounts.ts:60-71`) derives it from the kind; this design stores it on the account.
- **Job:** anything that asks a model: project work, 10db's errands, Decisions.
- **Sign-in and binding:** as in the Linear spec's "Sign-ins and bindings".

## Accounts and harnesses

| Kind | Harnesses allowed | Credential | Metered |
|---|---|---|---|
| `claude_subscription` | `claude_code` | login in its config dir | no |
| `anthropic_api_key` | `claude_code` | Keychain key | yes |
| `bedrock` | `claude_code` | AWS profile or Keychain bearer token | yes |
| `codex_signin` | `codex` | login in its `CODEX_HOME` | no |
| `openrouter` | `codex` (none until the spike passes) | Keychain key | yes |

- `accounts.settings` gains `harness`, defaulted to the kind's first allowed harness and refused outside the
  list. A kind with no allowed harness can't be a project's account or backup.
- **One source of truth.** `providerOf(kind)` is replaced by `harnessOf(account)`. Its 28 call sites take the
  account; a site that holds only a kind is changed to hold the account. Every test of `kind === CodexSignin`
  that means "runs Codex" asks the harness instead. Known sites: `trust/floor-notice.ts:29` (the rules floor),
  `environment/launch.ts:262`, `:268-274` (`droppedBy`), `:344`, `:384`, `runner/runner.ts:2648`,
  `accounts/service.ts:228`, `cards.ts:58`, `mcp-sign-ins.ts:221`, `:275`, `sessions/capabilities.ts:82`. The
  plan greps for the rest; this is part 1's whole job and it ships before OpenRouter runs anything.
- **Gateway is removed:** `AccountKind.Gateway`, `GatewaySettings`, its launch branch (`launch.ts:366-370`, `:424`,
  `:224`), identity rule (`sessions/account-check.ts:57`, `:66`, `:100-105`), the free-text tier fields
  (`tier-overrides.tsx:78-82`), and its other exceptions: `catalogue/account-offer.ts:30`, `model-facts.ts:26`,
  `shape/agent-models.ts:16`, `trust/auto-mode-models.ts:62`, `sessions/fake-adapter.ts:76`,
  `packages/db/src/store/accounts.ts:168-170`, and desktop `model-format.ts:34`, `account-fields.tsx:139`,
  `account-form-values.ts:69`, `:88`, `secret-form.tsx:38`. The builder's database holds no Gateway account (read on 2026-11-21), so nothing is converted: a database that still holds one refuses to start the daemon with a message naming the account, rather than failing to parse it later (`accounts.kind` is typed `SupportedAccountKind`, `packages/db/src/schema.ts:208`).

## OpenRouter runs projects on Codex

- **Home:** the account gets a config dir and a `CODEX_HOME` like a ChatGPT plan's, without
  `forced_login_method: 'chatgpt'` (`sessions/codex-home.ts:84`), and with `model_provider = "openrouter"` and a
  `[model_providers.openrouter]` entry for `https://openrouter.ai/api/v1` in its `config.toml`.
- **Key:** read from the Keychain at launch into Codex's environment as `OPENROUTER_API_KEY`, as keyed kinds are
  today. Every shell Codex runs is kept from it: lanes inherit nothing
  (`sessions/codex-lane-config.ts:65`); a takeover adds it to `shell_environment_policy.exclude`
  (`sessions/codex-takeover.ts:149`) which is what protects it there (`scrub` is a Claude Code switch,
  `sessions/claude-takeover.ts:34`). The builder's own OpenAI and Codex login variables are dropped for every Codex-harness
  account (`droppedBy`).
- **Identity:** the key's fingerprint, as for other keyed kinds, plus what Codex reports on a custom provider.
  The spike records exactly what that is (`account/read`'s provider fields), and `credentialsMatch`
  (`account-check.ts:106-107`) gains that rule; until it's known, OpenRouter has no harness.
- **Models:** from OpenRouter's models API with the key, keeping models that list tool support, each with
  OpenRouter's own listed price. Tiers resolve as for any account with a list, with tier overrides.
- **Spend and cap:** the kind becomes metered (`contracts/accounts.ts:81-85`), takes a lane cap and a monthly cap
  like other keyed kinds (`store/accounts.ts:122-136`, `:165`; `AccountInput` at `contracts/accounts.ts:279-283`).
  Spend is session cost (tokens times the listed price) plus `judge_calls` cost (`store/usage.ts:43-74`), so one
  cap covers both. A cap pause stops new sessions and moves projects to their backup; Decisions keep running.
  OpenRouter's own per-key limit is a second stop.
- **Removed:** `runsAgents`, `agentKind`'s refusal, `OPENROUTER_CANT_RUN_AGENTS`, `refuseOpenRouterForAgents`, the
  launch refusal (`launch.ts:313-321`), `list-refresh.ts:63`'s skip, and Billing's disabled rows
  (`views/settings/accounts/used-by.ts:43-48`, `project-setup.tsx:172`).
- **Judge:** Codex sessions are judged by 10db's judge (`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`),
  so an OpenRouter project with no Decisions account runs on the rules floor and says so, as a ChatGPT plan does.

### Per job on an OpenRouter account

| Job | Behaviour |
|---|---|
| Lane steps, chats, Plan | Codex with the tiers' models |
| Terminal takeover | Codex's own terminal; the key excluded from its shells |
| 10db's errands | Codex on the Efficient tier model |
| Web | Codex's web search as today (`cached`); whether it works through OpenRouter is a spike output, and the Web switch says so if not |
| Pictures | sent when the model's listing takes images, else the session says pictures aren't read on this model |
| Linear and other MCP servers | a server configured in the account's `CODEX_HOME`; no claude.ai connectors |

## Jobs and who powers them

| Job | Account | Model |
|---|---|---|
| Lane steps, chats, Plan, pass review | the project's account, or its backup after a move (unchanged) | Models by role |
| 10db's errands for a project: area naming, the Linear reporter and binding check | the project's account (area naming moves off the default account, `daemon/area-namer.ts:29`) | the Efficient tier |
| Decisions: sizing, `crosses_limit`, `test_value`, shape, stakeholder triage | the Decisions account, app-wide | each decision's model, from that account |
| Benchmarks: Artificial Analysis, OpenRouter speeds | AA's sign-in; the Decisions account's key when it is OpenRouter, else any OpenRouter account's (`daemon/start.ts:2499-2504`), else off | none |

## Decisions on any API account

- `JudgeConfig.accountId` may name an `openrouter`, `anthropic_api_key` or `bedrock` account
  (`packages/db/src/store/judge-config.ts:33-39`). Paid by lists those and disables plan logins with "a plan
  login has no API for quick decisions".
- **Switching the account is one change:** it sets the account and every decision's model to the new account's
  default (OpenRouter: `typesafe/jev-1.13`; others: their Efficient tier model), and is refused unless that model
  answers the test decision first (`judge-services.ts:164-178` today tests only changed models). A decision's
  model must be one the account offers for decisions: for OpenRouter, the decision-model list
  (`judge-services.ts:98-99`) plus its chat models, not the tool-filtered list projects use; for the others, the
  account's own list; `JudgeDecisionConfig.model` (`contracts/judge.ts:59-72`) stops saying
  "an OpenRouter model id".
- `judge.choose` gains two request shapes beside OpenRouter's three (`judge/openrouter.ts`):
  - **Anthropic API key:** Messages with `output_config.format` as a JSON schema.
  - **Bedrock:** the same body through Bedrock's runtime, with the model id from the account's list (already
    Bedrock ids), signed with the account's profile or bearer token.
  Confidence is the answer's own `confidence`, as for OpenRouter chat models today. A first call with a new schema
  is slower while it compiles and may fall back once.
- Every place that assumes Decisions means OpenRouter is changed: `judge-services.ts:88`, `:172`, `:185`,
  `floor-notice.ts:42`, desktop `paid-by.tsx:76`, `:123`, `accounts-section.tsx:52`, `:106-115`,
  `usage-by-project.tsx:13`, `account-kind-label.ts:10`, `team/routing-inputs.ts:30`, `list-refresh.ts:101`.
- Unchanged: the floor, switches, `judge_calls`, the 30-day stats, the fallback to rules.

| State | Event | Result |
|---|---|---|
| a call in flight | the Decisions account is switched | the call finishes on the old account; the next uses the new |
| a call in flight | a cap pause | the call finishes; Decisions keep running |
| any | the account's secret is cleared or fails | every call falls back to rules with the reason logged; Settings › Decisions says so |
| any | archive the Decisions account | refused, like a project's account; switch Decisions first |

## Sign-ins and bindings

As in the Linear spec's "Sign-ins and bindings", with these changes:
- **Artificial Analysis** is a sign-in with no binding.
- **Linear's sign-in** is listed per account that can reach it: a Claude plan's claude.ai connector, or a
  configured `mcp.linear.app` server on any account (Codex accounts through their `CODEX_HOME`).
- **Slack:** test data is deleted, not migrated, and the token lives under its workspace's team id from the start.
  - Amended by `docs/architecture/decisions/2026-11-23-a-projects-slack-workspace-is-its-own.md`: several workspaces
    can be signed in, each with its own token, and each project picks one or Off.
- **Settings layout:**
  - All Projects: Accounts (each with its harness and whether it can power Decisions), Decisions, Models,
    Sign-ins (renamed from Integrations), People, and the rest unchanged.
  - Project: Billing (any account with a harness), Integrations (bindings), and the rest unchanged.

## Provider facts

- OpenRouter documents Codex through `model_providers` and its Responses API, which is stateless: `store: true`
  or a `previous_response_id` is refused (`openrouter.ai/docs/guides/coding-agents/codex-cli.md`,
  `openrouter.ai/docs/api/reference/responses/overview.md`). Codex reads `model_providers` from
  `CODEX_HOME/config.toml` only, not a project's `.codex/config.toml`.
- OpenRouter supports Claude Code only when routed to Anthropic, and Anthropic doesn't support Claude Code on
  non-Claude models through any gateway (`openrouter.ai/docs/guides/coding-agents/claude-code-integration.md`,
  `code.claude.com/docs/en/llm-gateway`). This is why Claude Code on OpenRouter is not offered.
- claude.ai connectors need a claude.ai login; servers the builder configures work on any credential
  (`code.claude.com/docs/en/mcp.md`).
- Claude's API and Bedrock answer JSON-schema questions
  (`platform.claude.com/docs/en/build-with-claude/structured-outputs`). Neither Anthropic nor OpenAI offers a
  dedicated judge endpoint.
- OpenRouter reports spend per key (`/api/v1/key`) and supports per-key limits; tagging spend per session is not
  documented.

## Data

- `accounts.settings.harness`; no new table, so parts 1-4 add no migration; the removals below
  run as startup code. The Linear spec's part 5 adds the
  only one, under the one-open-migration rule (`AGENTS.md`).
- Removed: the `openrouter-api-key` item and its move (`accounts/openrouter-key-move.ts`), the `slack-bot` item,
  test Slack contacts, and the stale `modelMap` key (`packages/agent-skill/src/commands.ts:49`).

## Parts and sizes

1. **The harness on each account; Gateway removed.** Core: it moves the rules floor and the launch environment
   from kind to harness.
2. **OpenRouter runs projects on Codex.** Core: a key reaches a launched session, and a new kind runs under the
   sandbox and judge. It opens with the spike, recorded in `docs/architecture/research/`: a lane task built and
   reviewed on OpenRouter, what Codex reports as its provider, and whether web search works.
3. **Decisions on any API account.** Core: it changes who answers `crosses_limit`, and the daemon signs AWS
   requests. It adds the Bedrock runtime client, pinned.
4. **Sign-ins and bindings, Slack by workspace.** Feature; the Linear spec's part 1. It can run beside 1-3.
5. **Linear link and import, then the reporter:** the Linear spec's parts 2 and 3, unchanged.

Each part ships on its own and writes its decision record: the harness is stored and Gateway is gone (part 1);
OpenRouter runs agents on Codex (part 2, superseding the refusal in
`2026-10-31-openrouter-makes-routine-decisions.md`); Decisions run on any API account (part 3).

**Provider parity follow-up**, filed when part 3 lands: Decisions on a plan login alone, through a short session
for the decisions that aren't on a session's path (sizing, `test_value`, triage). Until then a plan-only setup
runs on rules, and Settings › Decisions says so.

## Not in this version

- A second harness for any kind (Pi, OpenCode), and Codex on Bedrock.
- Claude Code on OpenRouter.
- OpenAI API keys.
- Per-session spend read back from OpenRouter.
