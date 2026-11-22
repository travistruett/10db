# Plan: accounts carry a harness, OpenRouter runs Codex, Decisions on any API account

**Size:** Core (10db's Careful): it moves the rules floor and the launch environment from kind to harness, puts a
key into a launched session, and changes who answers `crosses_limit`. Six cards; each Light/Standard sub-step
inside a card gets no process of its own.
**Spec:** `docs/superpowers/specs/2026-11-21-10db-accounts-harnesses-and-sign-ins-design.md`, parts 1-3. Part 4
(sign-ins and bindings) is its own Feature plan, `2026-11-21-10db-sign-ins-and-bindings.md`.
**Spike:** `docs/architecture/research/spike-18-codex-on-openrouter.md` (passed: part 2 stays in).

## Brief

**What changes for you.** Each account says which harness runs it ("Runs Claude Code", "Runs Codex"), and 10db
decides Claude-or-Codex by that, never by the kind. The Gateway kind is gone. An OpenRouter account can be a
project's account or backup and runs Codex, under one lane cap and one monthly cap that covers its sessions and its
decisions. Decisions can run on an OpenRouter, Anthropic API key or Bedrock account; a plan login can't, and says
why.

**What it buys.** One OpenRouter key does everything; judgment no longer needs a second vendor; a second harness
later is a table row.

**What could go wrong, and how we'd know.**
- *A site still reads the kind as "runs Codex"* and launches an OpenRouter session as Claude Code. Card 1 replaces
  every site before card 3 lets OpenRouter run; card 1's review greps for `CodexSignin` outside the kind tables.
- *An Anthropic key sent to openrouter.ai* by the benchmarks sync once Decisions can sit on an Anthropic account.
  Card 5 narrows that reader to OpenRouter credentials.
- *The key reaches a shell Codex runs.* The spike showed it does by default. Card 3 adds one test that a lane's
  and a takeover's Codex config keep `OPENROUTER_API_KEY` from shells.
- *Switching the Decisions account breaks judgment.* The switch is refused unless the new default model answers
  a test decision; one test.
- *Codex's "model metadata not found" warning,* an `error` item on every OpenRouter turn, read as a failed turn.
  Card 4 makes the adapter treat it as a warning.

**Calls you might disagree with.**
1. The stored harness uses the adapter ids already persisted on sessions (`claude`, `codex`), not the spec's
   `claude_code`; the label reads "Claude Code". Renaming is a startup rewrite later.
2. The spike ran on a free model because the Decisions key has no credit. A paid OpenRouter model is unverified
   until you add credit; the first real lane on it is QA item 1.
3. On OpenRouter, the Web switch's "on" means live web (OpenRouter ignores Codex's cached-only mode), and no
   search shows in the transcript. The Web switch says so on an OpenRouter project.

**What is needed from you.** Nothing to start. To QA OpenRouter lanes, a few dollars of credit on the OpenRouter
account.

## Global Constraints

- Read `AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`, and the `AGENTS.md` of every
  directory you touch, once; keep notes in your scratch folder.
- **No migration.** 10db is alpha with no users: data that no longer fits is deleted at startup, not converted.
  The only startup refusal is a stored Gateway account (card 2).
- `providerOf`, `runsAgents`, `agentKind`, `AGENT_ACCOUNT_KINDS`, `OPENROUTER_CANT_RUN_AGENTS` and
  `refuseOpenRouterForAgents` are gone when the milestone ends; nothing reintroduces a kind test that means
  "runs Codex" or "runs Claude Code".
- The rules floor and the judge for a Codex-harness account are 10db's judge
  (`decisions/2026-11-12-codex-is-judged-by-10dbs-judge.md`), whatever the kind.
- A secret is read from the Keychain at launch or call time, never cached, never logged, never in a
  `config.toml`.
- Tests: only those named on the card. Each carries a value card in its commit (`.claude/rules/testing.md`).
- While working run `pnpm vitest related <files> --maxWorkers=2`, typecheck and lint of the packages changed.
  Before handing back run `make precheck`. Never the full suite, never `make check-changed` (an integration
  branch).
- Commit after every green step, naming paths. Scopes: `daemon`, `desktop`, `contracts`, `db`, `docs`, `deps`.
- Each part's decision record goes in `docs/architecture/decisions/` (format in its README) on the card named.

## Provider parity

| Account | Harness | Projects | Decisions | Notes |
|---|---|---|---|---|
| Claude plan | Claude Code | yes | no: "a plan login has no API for quick decisions" | rules floor unless another account powers Decisions |
| Anthropic API key | Claude Code | yes | yes, its Efficient tier model | new |
| Bedrock | Claude Code | yes | yes, its Efficient tier model, signed by profile or bearer token | new |
| ChatGPT plan | Codex | yes | no | judged by 10db's judge, as today |
| OpenRouter | Codex | **yes (new)** | yes, decision models or any chat model | no web_search items; cached web is live; pictures by the model's listing |

The follow-up the spec names (Decisions on a plan login through a short session) is filed as a 10db task when
card 6 lands.

## Interfaces

```ts
// packages/contracts/src/accounts.ts (card 1; card 3 changes the OpenRouter row to [Provider.Codex])
/** The harnesses each kind may run, first is the default; a kind with none can't be a project's account. */
export const HARNESSES_OF_KIND: Readonly<Record<SupportedAccountKind, readonly Provider[]>>;
/** The harness the account runs: its stored `settings.harness`, else the kind's first; null when the kind has none. */
export function harnessOf(account: {
  readonly kind: SupportedAccountKind;
  readonly settings: AccountSettings;
}): Provider | null;
/** The harness, or InvalidError `no harness runs ${label} yet` (the store's and the launcher's refusal). */
export function requireHarness(account: {
  readonly kind: SupportedAccountKind;
  readonly label: string;
  readonly settings: AccountSettings;
}): Provider;
/** Every kind's settings gain this; parse refuses a harness outside HARNESSES_OF_KIND[kind]. */
const harness = { harness: z.enum(Provider).optional() };

// packages/contracts/src/accounts.ts (card 6)
/** The kinds whose API answers 10db's decisions. */
export const DECISION_ACCOUNT_KINDS: readonly [
  typeof AccountKind.OpenRouter,
  typeof AccountKind.AnthropicApiKey,
  typeof AccountKind.Bedrock,
];
export function powersDecisions(kind: SupportedAccountKind): boolean;
export const PLAN_LOGIN_CANT_DECIDE = 'a plan login has no API for quick decisions';

// apps/daemon/src/judge/credential.ts (card 5)
export type JudgeCredential =
  | { readonly kind: typeof AccountKind.OpenRouter; readonly key: string }
  | { readonly kind: typeof AccountKind.AnthropicApiKey; readonly key: string }
  | {
      readonly kind: typeof AccountKind.Bedrock;
      readonly region: string;
      /** Null: sign with `bearerToken`. */
      readonly awsProfile: string | null;
      readonly bearerToken: string | null;
    };
// JudgeDeps.readKey becomes:
readonly readCredential: (accountId: AccountId | null) => Promise<JudgeCredential | null>;
// ModelQuestion.key becomes `credential: JudgeCredential`; `api` is read only for OpenRouter.
// apps/daemon/src/judge/ask.ts: one call on the credential's API. Throws a typed JudgeCallError, or what fetch throws.
export function askModel(q: ModelQuestion): Promise<ModelAnswer>;

// apps/daemon/src/sessions/codex-home.ts (card 3); both writers pass it: codex-adapter.ts:93, start.ts:1831
export type CodexHomeProvider = 'chatgpt' | 'openrouter';
export function codexHomes(): (path: string, provider: CodexHomeProvider) => CodexHome;

// apps/daemon/src/sessions/account-check.ts (card 3): credentialsMatch's OpenRouter case
case AccountKind.OpenRouter:
  return seen.apiProvider === undefined && seen.requiresOpenaiAuth === false;
```

## State table (design, not a test list)

| State | Event | Result |
|---|---|---|
| daemon starting | a stored `gateway` account | refuse to start; the message names the account's label and id and says to remove it (card 2) |
| daemon starting | a stored OpenRouter row with no `configDir` | given its own dir and the default lane cap (card 3) |
| OpenRouter session launching | no `configDir` | refused; never the builder's `~/.codex` (card 3) |
| daemon starting | the `openrouter-api-key` Keychain item exists | item removed; no account is created (card 4) |
| project bound to an account | its kind has no harness | refused at bind and at launch: `no harness runs <label> yet` (card 1) |
| OpenRouter session launching | key missing or changed outside 10db | refused as for other keyed kinds (`SecretMissing`, `SecretChanged`) (card 3) |
| OpenRouter session running | Codex emits "Model metadata ... not found" | a warning; the turn goes on (card 4) |
| OpenRouter session running | a 402 from OpenRouter | the turn fails with the error text; the account pauses as for other spend refusals (card 4) |
| account over its monthly cap | a decision is asked on it | the decision runs; new sessions stop and move to the backup (card 4) |
| a decision call in flight | the Decisions account is switched | the call finishes on the old account; the next uses the new (card 6) |
| any | the Decisions account's secret is cleared or fails | every call falls back to rules with the reason logged; Settings › Decisions says so (card 6) |
| any | switch Decisions to an account whose model list hasn't loaded | refused: check the account first (card 6) |
| any | archive the Decisions account | refused: switch Decisions first (card 6) |
| any | switch Decisions to an account | refused unless the new account's default decision model answers the test decision; on success every decision's model is that default (card 6) |

## Tracks

Two tracks on integration branch `feat/accounts-harnesses`; each implementer works in its own worktree under
`../10db-worktrees/` branched from it. The coordinator merges each card in, then a code review per group.

- **Track A** (parts 1-2, sequential, worktree `accounts-a`):
  - [Card 1](2026-11-21-10db-accounts-harnesses/task-1.md): the harness on each account; every kind test that
    means "runs Codex" moves to it; area naming moves to the project's account.
  - [Card 2](2026-11-21-10db-accounts-harnesses/task-2.md): Gateway removed; a stored one refuses startup;
    part 1's decision record. *Review group 1: cards 1-2.*
  - [Card 3](2026-11-21-10db-accounts-harnesses/task-3.md): OpenRouter's Codex home, key and identity; the
    OpenRouter row gets `codex`.
  - [Card 4](2026-11-21-10db-accounts-harnesses/task-4.md): OpenRouter as a project's account: models, caps,
    spend, the refusals removed, Web and pictures, the old key item deleted; part 2's decision record. *Review
    group 2: cards 3-4.*
- **Track B** (part 3, sequential, worktree `accounts-b`, beside track A):
  - [Card 5](2026-11-21-10db-accounts-harnesses/task-5.md): the judge asks Anthropic's API and Bedrock.
  - [Card 6](2026-11-21-10db-accounts-harnesses/task-6.md): Decisions on any API account: the switch, the
    model lists, the refusals, Settings › Decisions; part 3's decision record. *Review group 3: cards 5-6.*

Shared files between the tracks (`contracts/accounts.ts`, `accounts/list-refresh.ts`, `trust/floor-notice.ts`,
desktop `accounts-section.tsx`, `account-kind-label.ts`) are merged by the coordinator.
