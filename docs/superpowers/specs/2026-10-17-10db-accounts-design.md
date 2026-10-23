# 10db accounts: per-project billing identities

**Status:** design approved section by section on 2026-10-17; this document awaits review.
**Extends:** `2026-10-13-10db-factory-loop-design.md`. It replaces that spec's per-project **billing mode**
(§6 "Environment", §4 `projects`) and its **per-provider concurrency cap** (§5.2 point 7) with accounts.
**Builds on:** M2a (plan 06), which is still in review: model profiles, AA scores and the router.

## 1. Intent

The builder runs projects for several clients in parallel, and some clients pay for their own projects. Each
project must run on a known billing identity, called an **account**, and 10db must never run a session on the
wrong one. Examples:

- a Claude subscription the builder owns per client (`travis+companya@…`, `travis+companyb@…`), paid for by
  consulting fees;
- a client's own Anthropic API key, AWS Bedrock access or gateway key (OpenRouter or another
  Anthropic-compatible endpoint);
- later, OpenAI and Codex accounts, when the Codex adapter arrives.

**What the builder said:**

- Accounts are first-class.
- Usage must be visible per project and per account.
- Metered accounts can carry a hard dollar cap ("stop me at $500").
- Practical isolation between projects is enough.
- Per-client invoicing reports are not needed.

**Success means:**

1. A session whose verified identity doesn't match its project's account never sends a prompt. It is refused
   with a card instead.
2. Projects on different accounts run in parallel, and each account's usage limits and lane cap apply only to
   that account.
3. The builder can see each account's tokens and dollars this month, broken down by project.
4. A metered account stops starting sessions at its monthly cap.
5. One project's sessions can't casually read another account's credentials.

**Out of scope:**

- per-client invoice exports;
- routing one project across several accounts;
- automatic failover to another payer;
- Codex accounts (the kinds are reserved, not built);
- OS-level isolation between accounts (separate macOS users or sandboxes).

## 2. Prior art

The prior art was surveyed on 2026-10-17 across OpenCode, Pi, Crush and Conductor:

- All of them keep provider settings in layered config, refer to secrets indirectly (`{env:X}`, `{file:…}`,
  or a keychain command), and name models `provider/model`, with per-provider overrides for Bedrock and
  gateways.
- None of them pins a project to an account, runs several accounts in parallel, or checks identity before a
  run.
- OpenCode stopped bundling Claude Pro/Max login plugins after Anthropic prohibited third-party ones.

10db drives the official `claude` binary with one config directory per subscription account. 10db never sees
that login, which keeps it within the Claude Code terms the main spec cites (§15).

## 3. Decisions

These get numbers when they are recorded in `docs/architecture/decisions.md`.

| Decision                                                                                                                                                                                                                                                                                                                                                                       | Why                                                                                                                                                 |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| An **account** is a database row: kind, label, payer, expected identity, a secret reference or config directory, an optional model map and alias list, a lane cap, an optional monthly dollar cap, and `archived`. A project binds one account per provider. Several projects may share one account.                                                                           | Caps and usage belong to whoever pays, and one payer often funds several projects.                                                                  |
| A **subscription account** is a Claude Code config directory that the builder signs into with the unmodified `claude` binary (`CLAUDE_CONFIG_DIR=<dir> claude /login`). 10db points sessions at the directory and reads `accountInfo()`. It never reads, stores or passes on the login.                                                                                        | Main spec §6 and §15: no collecting or intermediating claude.ai credentials.                                                                        |
| A **keyed account** (API key, Bedrock, gateway) keeps its secret in the login Keychain, as item `10db` / `account:<acc_id>`. The secret is read when a session starts, never cached, and never returned by the API. An empty or missing secret refuses the session.                                                                                                            | Secrets stay out of the database and out of files. A missing secret must fail loudly; OpenCode's empty-string fallback is the pitfall to avoid.     |
| One module turns an account into a session's **launch spec** (model, env, config directory). The env starts from the captured login environment, strips every billing-switch variable and family as today, and adds only that account's variables. No env name appears outside that module.                                                                                    | Env is how Claude Code takes credentials. Having one owner, plus table tests per kind, keeps env from being brittle.                                |
| Models reach Claude Code through the SDK's `model` option. An account with a **model map** sends the channel's model ID (for example a Bedrock model ID) instead of the alias. `ANTHROPIC_DEFAULT_*_MODEL` stays stripped.                                                                                                                                                     | Nothing depends on Claude Code mapping aliases behind 10db's back.                                                                                  |
| Every session **checks itself before the prompt**. `accountInfo()` must match the account's expected identity, `apiKeySource` must match the kind, and the model reported in `init` must equal the requested one. Any mismatch refuses the session with a card, and nothing is billed. This extends the billing check of main-spec decision 47.                                | A silent switch of payer or model is the failure to design against. A Claude Code upgrade that renames a variable then fails loudly.                |
| Concurrency is capped **per account** (`laneCap`, default 4), not per provider. A usage-limit pause applies to the account that hit it.                                                                                                                                                                                                                                        | Usage limits belong to the account, so two subscriptions are two pools.                                                                             |
| A **metered account** (API key, Bedrock or gateway) may carry `monthlyCapUsd`. Before starting a session, the scheduler compares the account's calendar-month spend with the cap. At or over the cap, the account's lanes go to `PAUSED_LIMIT` with one card. A session already running finishes, and the card shows any overshoot. Subscriptions have no dollar cap.          | Simple and enough: "stop me at $500". Stopping a session mid-run would lose work.                                                                   |
| Usage is recorded per session (`accountId`, tokens in, out and cached, and `costUsd` for metered kinds, as the SDK reports them). Account usage is a query over sessions, not a second ledger.                                                                                                                                                                                 | One source of truth.                                                                                                                                |
| The router stays **model-level**. An account may list the aliases it offers, and the router considers only those. The project budget ceiling still compares AA's cost per task, whatever the account kind.                                                                                                                                                                     | AA scores describe models. On a subscription, AA cost still tracks how fast a model burns quota. Real dollars are governed by the monthly cap.      |
| **Practical isolation.** A session gets only its own account's env and config directory. In every step kind, the guard refuses Keychain commands (`security`, plus `osascript` keychain access), any tool or shell path under 10db's data directory (including `accounts/`), and commands that print secret-bearing env (`env`, `printenv`, `set`, `export -p`, `declare -x`). | This stops agent mistakes and casual misuse, not deliberately malicious code. Separate macOS users stay possible later without changing the schema. |
| **Accounts start fresh.** The schema is pre-release, with no published release and no users. On first start, the daemon seeds one `claude_subscription` account, labelled "Personal", for the builder's current login, and binds new projects to it by default.                                                                                                                | Nothing exists to migrate (see §9).                                                                                                                 |

## 4. Data model

`accounts`:

- `id` (`acc_…`)
- `kind`: `claude_subscription`, `anthropic_api_key`, `bedrock` or `gateway`. `openai_api_key` and
  `codex_signin` are reserved and refused until the Codex adapter exists.
- `label`
- `payer`: free text
- `expectedIdentity`: the email for a subscription. For keyed kinds it is the organization `accountInfo()`
  reports, or null where the kind reports none.
- `configDir`: Claude Code's config directory for the account's sessions. For the seeded Personal account, the
  login shell's `CLAUDE_CONFIG_DIR` when it sets one, else null (Claude Code's default directory, `~/.claude`).
  For every other account, keyed kinds included, an empty directory 10db creates under the data directory as
  `accounts/<acc_id>/claude`, with mode 700. A keyed session then never reads Personal's saved login or config.
- `secretRef`: keyed kinds only, the Keychain account name.
- `settings` (JSON, parsed by zod at the boundary):
  - Bedrock: `region`, `awsProfile` or bearer-token use;
  - gateway: `baseUrl`;
  - optional `modelMap` (alias to the channel's model ID);
  - optional `aliases` (the aliases the account offers).
- `laneCap`: default 4
- `monthlyCapUsd`: metered kinds only, nullable
- `archived`
- timestamps

Other tables:

- `projects` gains `accountId`, which replaces `billingMode`. A project's provider is its account kind's
  provider.
- `sessions` gains `accountId`, `tokensIn`, `tokensOut`, `tokensCached` and `costUsd` (null for subscriptions).

Every change writes its row and its event (`AccountSaved`, `AccountCapReached`) in one transaction. The
desktop's `INVALIDATIONS` maps `account`.

## 5. Launching a session

The launch spec per kind:

| Kind                  | Env added (after stripping)                                                                                                                    | Other                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `claude_subscription` | `CLAUDE_CONFIG_DIR=<configDir>` (none for Personal on the default directory)                                                                   | no key variables           |
| `anthropic_api_key`   | `CLAUDE_CONFIG_DIR=<configDir>`, `ANTHROPIC_API_KEY` from the Keychain                                                                         |                            |
| `bedrock`             | `CLAUDE_CONFIG_DIR=<configDir>`, `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, plus `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK` from the Keychain |                            |
| `gateway`             | `CLAUDE_CONFIG_DIR=<configDir>`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` from the Keychain                                                | model map usually required |

Then the session checks itself, in order. Any failure refuses the session with an inbox card that names the
account and what was seen:

1. `accountInfo()` must match `expectedIdentity`.
2. `apiKeySource` must match the kind.
3. The model in `init` must match the requested one.

**Expired credentials** get a card with the account's exact fix:

- for a subscription, `CLAUDE_CONFIG_DIR=<dir> claude /login`;
- for Bedrock with a profile, `aws sso login --profile <p>`.

**Signing in.** Creating a subscription account returns its sign-in command. Once the builder has run it,
`GET /accounts/:id/identity` reports the email found, and the builder confirms it as `expectedIdentity`.

## 6. Scheduling, caps and usage

- **Per-account limits.** The scheduler's global cap and the per-project lane caps stay. Per-account
  `laneCap` replaces `caps.perProvider`. A usage-limit or overage pause marks only that account's lanes.
- **Monthly cap.** The scheduler checks the cap before each start against the calendar month, computed in
  local time on an injected clock. Raising the cap, or the month rolling over, resumes the paused lanes.
- **Usage.** `GET /accounts/:id/usage?month=YYYY-MM` returns tokens and dollars in total and per project.

## 7. API and Settings

**Routes:**

- `GET`, `POST`, `PATCH /accounts`, and `POST /accounts/:id/archive`.
- `PUT /accounts/:id/secret`. This route is write-only: responses carry `secretSet: boolean`, never the secret.
- `GET /accounts/:id/signin`, `GET /accounts/:id/identity` and `GET /accounts/:id/usage`.
- `PATCH /projects/:id` accepts `accountId`.

Every body is parsed by zod.

**Settings (M2b).** An Accounts screen lists each account with its kind, its verified identity, and this
month's usage against its cap. It shows the sign-in steps for subscriptions. Project settings get an account
picker.

## 8. Testing

- Table tests: each account kind's launch spec, including a missing secret refusing the session and the
  model map.
- Identity, key-source and model mismatches refuse the session, using the fake adapter.
- Guard refusal tables: Keychain commands, data-directory paths and env dumps, in every step kind.
- Scheduler: the per-account lane cap, a pause scoped to one account, and the monthly cap across a month
  rollover on an injected clock.
- API: a secret never appears in any response.
- Manual live check: two real subscriptions running in parallel on two projects, each verified.

## 9. Pre-release schema policy and IDs

These come in a separate small PR, before accounts.

**Schema baseline.** Until the first published release, a schema change regenerates the baseline instead of
appending a migration. The baseline is `0000_init` (generated) plus the hand-written FTS5 migration (`0001`).
Local data directories are wiped. From the first published release on, migrations are forward-only again.
`packages/db/AGENTS.md` states both rules, and names the release that ends the pre-release phase.

**IDs.** IDs become `prefix_<uuidv7>`, minted by the `uuid` package's v7 with monotonic ordering, and `ulid`
is dropped. The prefix stays because branded, self-describing IDs help in logs, errors and types. The format
matches the UUIDv7 IDs the builder's other projects (Postgres) use. Because data is wiped, old ULIDs are not
accepted.

## 10. Spike, before the plan

This is throwaway work, with findings recorded in the plan.

1. Two config directories signed into different subscriptions stay separate, including in the Keychain, and
   `accountInfo()` reports each email.
2. Four concurrent sessions on one config directory survive an OAuth token refresh. There are unverified
   reports of a refresh race, Claude Code issues 54443 and 61923. If they fail, start a subscription's
   sessions one at a time, or lower its lane cap.
3. The Bedrock and gateway variables above, and the `model` option with a channel model ID.
4. Record the Claude Code version these names were verified on. A newer major version shows a system-check
   warning until the live check is rerun on it.

**If check 1 fails**, the fallback is one macOS user per subscription account, which is the deferred strong
isolation applied to subscriptions only.

## 11. Open questions

| Question                                                                                                                                                                                                                   | Who can answer it                      | Blocks                                                                                          |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Whether one person may hold several personal Claude subscriptions (for example plus-addressed emails), one per client                                                                                                      | Anthropic's consumer terms, or support | relying on per-client personal subscriptions; Team seats or client API keys are the alternative |
| Whether `accountInfo()` reports an organization for API-key and Bedrock sessions. A gateway session reports none and looks first-party, so it uses the key fingerprint (`docs/architecture/research/spike-12-accounts.md`) | the spike                              | identity checks for API-key and Bedrock accounts (a key fingerprint is the fallback)            |

## 12. Order

1. The pre-release reset PR (§9), after M2a merges.
2. The spike (§10).
3. Accounts in the daemon and API, as an early chunk of the M2b plan.
4. The Accounts Settings screen, in M2b with the rest of Settings.
