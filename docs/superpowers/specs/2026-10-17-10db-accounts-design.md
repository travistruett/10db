# 10db accounts: per-project billing identities

**Status:** design approved section by section on 2026-10-17. Amended on 2026-10-23 with the six amendments
the accounts plan (`docs/superpowers/plans/2026-10-22-10db-09-accounts.md`) found and Travis accepted, the
default account's "Claude plan" label, and moving a project between accounts with work in flight. Amended on 2026-10-25: the lane sandbox
(`2026-10-25-10db-lane-sandbox-design.md`) replaces the guard as what keeps a session from other accounts'
credentials (§1, §3 "Practical isolation", §8).
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
- When a subscription runs out mid-task, the work moves to another account (Bedrock, say) to finish, and
  moves back once the subscription is available again.
- Practical isolation between projects is enough.
- Per-client invoicing reports are not needed.

**Success means:**

1. A session whose verified identity doesn't match its project's account never sends a prompt. It is refused
   with a card instead.
2. Projects on different accounts run in parallel, and each account's usage limits and lane cap apply only to
   that account.
3. The builder can see each account's tokens and dollars this month, broken down by project.
4. A metered account stops starting sessions at its monthly cap.
5. One project's sessions can't read another account's credentials; the lane sandbox enforces it.
6. A project moves to another account with work in flight, and the work carries on there from its latest
   handoff. Near its account's usage limit (on a Claude subscription) or at the limit itself (on any
   account), a project with work in flight moves on its own to a fallback account the builder named.

**In scope since the first draft:** moving a project between accounts with work in flight, by hand or
automatically to a builder-named fallback account (§6).

**Out of scope:**

- per-client invoice exports;
- routing one project across several accounts at once: a project is on exactly one account at a time;
- carrying a conversation itself across accounts (a spike, §11); a moved lane continues from its handoff;
- Codex accounts (the kinds are reserved, not built);
- a separate macOS user per account. Lanes run in a kernel sandbox instead (the lane sandbox spec), which is
  what keeps a session from other accounts' credentials.

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
| Every session **checks itself**. Before the prompt, `accountInfo()` must match the account's expected identity and `apiKeySource` must match the kind; at the first `init`, which Claude Code sends only after the prompt, the model must equal the requested one. Any identity or credential mismatch refuses the session before the prompt, and nothing is billed; a model mismatch stops it at its first turn, before any tool runs, and fails the workstream, not the account. This extends the billing check of main-spec decision 47. | A silent switch of payer or model is the failure to design against. A Claude Code upgrade that renames a variable then fails loudly.                |
| Concurrency is capped **per account** (`laneCap`, default 4), not per provider. A usage-limit pause applies to the account that hit it.                                                                                                                                                                                                                                        | Usage limits belong to the account, so two subscriptions are two pools.                                                                             |
| A **metered account** (API key, Bedrock or gateway) may carry `monthlyCapUsd`. Before starting a session, the scheduler compares the account's calendar-month spend with the cap. At or over the cap, the account's lanes go to `PAUSED_LIMIT`, with one card per project that meets it. A session already running finishes, and the card shows any overshoot. Subscriptions have no dollar cap.          | Simple and enough: "stop me at $500". Stopping a session mid-run would lose work.                                                                   |
| Usage is recorded per session (`accountId`, tokens in, out and cached, and `costUsd` for metered kinds, as the SDK reports them). Account usage is a query over sessions, not a second ledger.                                                                                                                                                                                 | One source of truth.                                                                                                                                |
| The router stays **model-level**. An account may list the aliases it offers, and the router considers only those. The project budget ceiling still compares AA's cost per task, whatever the account kind.                                                                                                                                                                     | AA scores describe models. On a subscription, AA cost still tracks how fast a model burns quota. Real dollars are governed by the monthly cap.      |
| **Isolation between accounts is the lane sandbox's.** A session gets only its own account's env and config directory. Its Bash children get no account variable, and the kernel denies them the Keychain, 10db's data directory and every config directory; the file tools follow the same policy through the broker and deny rules (lane sandbox spec D1, D2, D5, D8). Until that ships, the guard's Keychain, env-dump and path rules stay as interim policy (lane sandbox spec D12). | Shell-text rules can't be a boundary: each of four fix rounds opened new bypasses (accounts plan Task 7). Every agent harness that takes a position puts the boundary in an OS sandbox (`docs/architecture/03-trust-boundaries.md`). Separate macOS users stay possible later without changing the schema. |
| **Accounts start fresh.** The schema is pre-release, with no published release and no users. On first start, the daemon seeds one `claude_subscription` account, the **default account**, labelled "Claude plan", for the builder's current login, and binds new projects to it by default. The builder can rename it. | Nothing exists to migrate (see §9). A label says what the account is; who pays is `payer`, and a company may pay for the builder's plan. |
| An account is **shown by its label and, once recorded, its identity**: "Claude plan · you@example.com" in every picker and card option. A card's title uses the label alone. | The same label can hide two logins; the identity says which one runs. |
| A project **moves to another account with work in flight**. A running session finishes on the account it started on; each lane's next session runs on the project's account at that moment. A lane whose next action would resume a conversation from another account starts a fresh session instead, briefed from the step's latest handoff; the builder's answer and a gate failure it was fixing still reach it. Committed work and the batch branch carry over; context neither committed nor handed off is lost. | Claude Code keeps a conversation in its account's config directory, so it can't be resumed on another account; the handoff is the continuity 10db already has. |
| A project may name a **fallback account**. When a session on a subscription reports its account's usage at or above the project's threshold (95% by default), once per crossing, each project on the account with work in flight acts: with a usable fallback (ready, not paused, capped when metered), its running lanes on that account are asked to hand off and the project moves there, with a card saying so; without one, a card asks where to move it. At the hard limit itself, on any kind of account, a busy project with a usable fallback moves at once. An idle project stays. A metered fallback needs a monthly cap. Claude Code reports usage short of the limit only for subscriptions, so a keyed account moves its projects only at the hard limit. | The builder's workflow: max out the subscription, finish on Bedrock, come back. A handoff at 95% keeps context a stop at 100% would lose; only the cap bounds spend nobody approves. |
| A project that leaves an account for its usage limit is **offered the way back**: once that limit resets, one card per project asks whether to move it back. Nothing moves until the builder answers. | Moving away for a limit is temporary, but whether to return mid-task is the builder's call. |

## 4. Data model

`accounts`:

- `id` (`acc_…`)
- `kind`: `claude_subscription`, `anthropic_api_key`, `bedrock` or `gateway`. `openai_api_key` and
  `codex_signin` are reserved and refused until the Codex adapter exists.
- `label`
- `payer`: free text
- `expectedIdentity`: the email for a subscription. For API-key and Bedrock accounts it is the organization
  `accountInfo()` reports, or null where none is compared. A gateway reports no organization (spike 12), so its
  `expectedIdentity` is always null.
- `configDir`: Claude Code's config directory for the account's sessions. For the seeded default account, the
  login shell's `CLAUDE_CONFIG_DIR` when it sets one, else null (Claude Code's default directory, `~/.claude`).
  For every other account, keyed kinds included, an empty directory 10db creates under the data directory as
  `accounts/<acc_id>/claude`, with mode 700. A keyed session then never reads the default account's saved login or config.
- `secretRef`: keyed kinds only, the Keychain account name.
- `secretFingerprint`: keyed kinds only, `sha256:` plus the first 16 hex digits of the secret 10db last stored,
  never the secret. It is a keyed account's identity: every session start compares the Keychain secret with it.
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
  provider. It also gains:
  - `fallbackAccountId`: optional; another account than its own, not archived, capped when metered;
  - `usageHandoffAt`: the share of the account's usage limit at which the project hands off, default 0.95,
    from 0.5 to 0.99;
  - `movedFromAccountId` and `moveBackAt`: the account the project left for its usage limit, and when that
    limit resets (null when nobody reported it), so 10db can offer the way back. Both null otherwise; any
    later move clears them.
- `sessions` gains `accountId`, `tokensIn`, `tokensOut`, `tokensCached` and `costUsd` (null for subscriptions).

Every change writes its row and its event (`AccountSaved`, `AccountCapReached`) in one transaction. The
desktop's `INVALIDATIONS` maps `account`.

## 5. Launching a session

The launch spec per kind:

| Kind                  | Env added (after stripping)                                                                                                                    | Other                      |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------- |
| `claude_subscription` | `CLAUDE_CONFIG_DIR=<configDir>` (none for the default account on Claude Code's default directory)                                             | no key variables           |
| `anthropic_api_key`   | `CLAUDE_CONFIG_DIR=<configDir>`, `ANTHROPIC_API_KEY` from the Keychain                                                                         |                            |
| `bedrock`             | `CLAUDE_CONFIG_DIR=<configDir>`, `CLAUDE_CODE_USE_BEDROCK=1`, `AWS_REGION`, plus `AWS_PROFILE` or `AWS_BEARER_TOKEN_BEDROCK` from the Keychain |                            |
| `gateway`             | `CLAUDE_CONFIG_DIR=<configDir>`, `ANTHROPIC_BASE_URL`, `ANTHROPIC_AUTH_TOKEN` from the Keychain                                                | model map usually required |

Then the session checks itself, in order. An identity or credential failure refuses the session with an inbox
card that names the account and what was seen, and pauses the account:

1. `accountInfo()` must match `expectedIdentity`, before the prompt.
2. `apiKeySource` must match the kind, before the prompt and again at the first `init`.
3. The model in `init` must match the requested one. Claude Code sends `init` only after the prompt, so a
   mismatch stops the session at its first turn, before any tool runs; that turn's first request may already
   be billed. It fails the workstream, not the account: the credentials were right.

**Expired credentials** get a card with the account's exact fix:

- for a subscription, `CLAUDE_CONFIG_DIR=<dir> claude /login`;
- for Bedrock with a profile, `aws sso login --profile <p>`.

**Signing in.** Creating a subscription account returns its sign-in command. Once the builder has run it,
`GET /accounts/:id/identity` reports the email found, and the builder confirms it as `expectedIdentity`.

The default account is the exception. It is the builder's current login (§3), so its identity is recorded from
its first probe without a confirmation, and a card that holds no work names it ("Claude plan runs as
<email>"), with the sign-in command for switching logins. This is safe because no other account shares its
config directory (§4). A login switched afterwards meets an identity refusal whose card offers Confirm. Every
other subscription account needs the builder's confirmation.

## 6. Scheduling, caps and usage

- **Per-account limits.** The scheduler's global cap and the per-project lane caps stay. Per-account
  `laneCap` replaces `caps.perProvider`. A usage-limit or overage pause marks only that account's lanes.
- **Monthly cap.** The scheduler checks the cap before each start against the calendar month, computed in
  local time on an injected clock, with one card per project that meets it. Raising the cap, or the month
  rolling over, resumes the paused lanes.
- **Usage.** `GET /accounts/:id/usage?month=YYYY-MM` returns tokens and dollars in total and per project. A
  session's usage belongs to the account it ran on, even after its project moves.
- **Moving a project.** `PATCH /projects/:id` with a new `accountId` moves the project whatever work it has in
  flight; only an archived account is refused. An unready or paused target holds the work `QUEUED` there.
  Each lane's next session runs on the new account, fresh from its latest handoff when the conversation it
  would resume ran elsewhere (§3).
- **The usage-limit card** goes to every project on the account that has work in flight, not only the one
  whose session met the limit. It offers "Continue on <account>" for each account the project could move to
  now (not archived, not its own, not paused), plus Later. An account that isn't ready yet is offered with what
  it still needs ("needs sign-in", "needs a secret"). A project with no work in flight when the limit hits
  gets its card the first time its later work waits on the pause, once per pause: answering Later keeps it
  quiet until the next pause.
- **The fallback.** When a session's rate-limit report shows its account's usage at or above a project's
  `usageHandoffAt`, once per crossing per project and limit, each project on that account with work in flight
  moves to its fallback after its running lanes on the account are told to hand off (the next session starts
  from the handoff, not the conversation), or the builder is asked where to move it. Claude Code sends that
  report only for subscription accounts, so on a keyed account only the hard limit acts. At the hard limit a
  busy project with a usable fallback moves at once; the account still pauses as above. A project with no
  work in flight never moves on its own. A fallback that is paused, not yet ready, or metered without a cap is
  not used without asking.
- **The way back.** A project that left an account for its usage limit (from a card, by its fallback, or by a
  `PATCH` while that account was paused for its usage limit) gets one card once the limit resets: move back,
  or stay. When no reset time was reported, 10db asks after its default pause and says it doesn't know whether
  the limit has reset; it holds the card while that account still reports usage past the project's
  threshold.

## 7. API and Settings

**Routes:**

- `GET /accounts`, `POST /accounts`, `PATCH /accounts/:id` and `POST /accounts/:id/archive`. `POST /accounts`
  answers `{ account, signIn }`: the sign-in command names `CLAUDE_CONFIG_DIR`, which only the launch module
  may name (§3), so it isn't a field of the account; it is null for keyed kinds.
- `PUT /accounts/:id/secret`. This route is write-only: responses carry `secretSet: boolean`, never the secret.
- `GET /accounts/:id/signin`, `GET /accounts/:id/identity` and `GET /accounts/:id/usage`.
- `GET /accounts/pauses` lists the accounts paused now (`reason`, `since`, `until`); `POST /accounts/:id/resume`
  lifts a refused or monthly-cap pause, as saving the account unchanged does, and answers the pauses still in
  force. A usage-limit pause ends by itself, so resuming it is a 409. Settings › Accounts and the account
  drawer show each pause and offer Resume, so a card answered Later is never the only way back.
- `PATCH /projects/:id` accepts `accountId` (a move, with work in flight too), `fallbackAccountId` and
  `usageHandoffAt`.

Every body is parsed by zod.

**Settings (M2b).** An Accounts screen lists each account with its kind, its verified identity, and this
month's usage against its cap. It shows the sign-in steps for subscriptions. Project settings get an account
picker, a fallback picker and a "Hand off at" field (the project's usage threshold, 50–99%, which applies
only on a Claude subscription account). Every picker shows an account's identity beside its label.

## 8. Testing

- Table tests: each account kind's launch spec, including a missing secret refusing the session and the
  model map.
- Identity, key-source and model mismatches refuse the session, using the fake adapter.
- Guard tables: the structured path checks on the file tools, and the permission matcher failing closed on an
  uncertain parse. The kernel boundary is tested by the lane sandbox plan.
- Scheduler: the per-account lane cap, a pause scoped to one account, and the monthly cap across a month
  rollover on an injected clock.
- API: a secret never appears in any response.
- Moving: a lane whose conversation ran on another account starts fresh from its handoff, with the builder's
  answer and a pending gate failure; the fallback at a threshold and at the hard limit, and the move back, using
  the fake adapter.
- Manual live check: two real subscriptions running in parallel on two projects, each verified; a project moved
  mid-step to a metered account and back; what a Max plan's rate-limit events report.

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
| What Claude Code's rate-limit event reports on a Max plan: how often it arrives, whether it carries `utilization` and on what scale, when `allowed_warning` first appears | the live check | moving a project to its fallback before the hard limit; the move at the hard limit doesn't depend on it |
| Whether a conversation can follow its project to another account: whether the SDK's `forkSession` and `getSessionMessages` honour a per-account config directory, whether a subscription's transcript resumes on Bedrock (replayed history, thinking blocks), and its token cost | a spike, after the accounts plan | resuming the cut-off conversation after a move; if it passes, a small follow-up plan does that instead of a fresh session from the handoff |

## 12. Order

1. The pre-release reset PR (§9), after M2a merges.
2. The spike (§10).
3. Accounts in the daemon and API, as an early chunk of the M2b plan.
4. The Accounts Settings screen, in M2b with the rest of Settings.
