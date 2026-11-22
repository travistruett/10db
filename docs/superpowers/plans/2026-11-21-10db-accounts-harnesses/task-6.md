# Card 6: Decisions on any API account

**Spec:** "Decisions on any API account" (every bullet and its state table); "Jobs and who powers them" (the
Decisions and Benchmarks rows); "Provider parity follow-up".
**Track:** B, after card 5, same worktree.

## Files

- `packages/contracts/src/accounts.ts`: `DECISION_ACCOUNT_KINDS`, `powersDecisions`, `PLAN_LOGIN_CANT_DECIDE`
  (below). `contracts/judge.ts:59-72`: `JudgeDecisionConfig.model` stops saying "an OpenRouter model id".
- `packages/db/src/store/judge-config.ts:33-39`: the account must be a live account whose kind powers decisions;
  the refusal names the account and, for a plan login, says `PLAN_LOGIN_CANT_DECIDE`.
- `apps/daemon/src/daemon/judge-services.ts`:
  - **Switching the account is one change** (`patchJudge`): a patch that changes `accountId` sets every decision's
    model to the new account's default (OpenRouter `typesafe/jev-1.13`; Anthropic API key and Bedrock: the
    account's Efficient tier model, resolved as the catalogue resolves tiers), tests that model with one test
    decision first, and is refused with the test's error if it fails. A patch that also names models is refused
    unless they belong to the new account's offer.
  - **A decision's model must be one the account offers:** OpenRouter: the decision-model list plus its chat
    models (the models API, not the tool-filtered project list); the others: the account's own list. `:172`'s
    "No OpenRouter key is set" and `:185`'s OpenRouter-only `testAccount` become any decision account.
  - The model-list route the picker uses serves the Decisions account's offer.
- Archiving the Decisions account is refused ("switch Decisions first"), like a project's account
  (`accounts/service.ts` or the store's archive check).
- The rest of "Every place that assumes Decisions means OpenRouter": `trust/floor-notice.ts:42` ("10db's judge
  needs an account that can power Decisions..."), desktop `paid-by.tsx:76`, `:123` (lists decision kinds; disables
  plan logins with `PLAN_LOGIN_CANT_DECIDE`), `accounts-section.tsx:52`, `:106-115` (each account card says whether
  it can power Decisions), `usage-by-project.tsx:13`, `account-kind-label.ts:10`, `team/routing-inputs.ts:30`,
  `accounts/list-refresh.ts:101`.
- Benchmarks key (`daemon/start.ts:2499-2504`): the Decisions account's key when it is OpenRouter, else any live
  OpenRouter account's, else off.
- Settings › Decisions, when every call is falling back because the account's secret is missing or fails, says so
  with the reason (the status DTO already carries `secretState`; show it).
- Part 3's decision record, `docs/architecture/decisions/2026-11-21-decisions-run-on-any-api-account.md`, amending
  `decisions/2026-10-31-openrouter-makes-routine-decisions.md`. Update `apps/daemon/src/judge/AGENTS.md` if it
  exists, else the nearest.
- When done, file the provider-parity follow-up with the `10db-task` skill's CLI on the 10db project: "Decisions
  run on a plan login alone", why and criteria from the spec's "Provider parity follow-up". Put its id in your
  report.

## Interfaces (quoted from the index)

```ts
export const DECISION_ACCOUNT_KINDS: readonly [
  typeof AccountKind.OpenRouter,
  typeof AccountKind.AnthropicApiKey,
  typeof AccountKind.Bedrock,
];
export function powersDecisions(kind: SupportedAccountKind): boolean;
export const PLAN_LOGIN_CANT_DECIDE = 'a plan login has no API for quick decisions';
```

## State-table rows

- a decision call in flight / the account is switched → finishes on the old account (the credential is read per
  call; confirm nothing caches it).
- the Decisions account's secret is cleared or fails → rules, reason logged, Settings › Decisions says so.
- archive the Decisions account → refused.
- switch Decisions to an account → refused unless the new default answers the test; on success every decision's
  model is that default.

## Tests

- One test through `createJudgeServices` on a real SQLite file with the judge's `test` faked at the network
  boundary: a switch whose default model fails the test is refused and leaves the config unchanged; one that passes
  sets the account and every decision's model (core: who answers `crosses_limit`). Update existing tests that
  assumed OpenRouter; add no others.

## Done when

Checks as card 5, plus desktop typecheck, lint and related tests. A click-through of Settings › Decisions against
the real daemon (switch to the Bedrock or Anthropic account if one is set, else check the disabled plan rows) is
described in the report.
