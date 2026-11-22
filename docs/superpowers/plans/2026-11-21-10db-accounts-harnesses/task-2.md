# Card 2: Gateway removed

**Spec:** "Accounts and harnesses", the "Gateway is removed" bullet (every site it names); "Data".
**Track:** A, after card 1, same worktree.

## Files

- `packages/contracts/src/accounts.ts`: `AccountKind.Gateway`, `GatewaySettings`, `BaseUrl`, the Gateway input
  branch, its `needsSecret` and `METERED` entries, the error text naming `gateway`. `SUPPORTED_ACCOUNT_KINDS` loses
  it, so `accounts.kind` (`packages/db/src/schema.ts:208`) does too.
- Daemon: `environment/launch.ts` (`mcpSignInWhere`'s `NotYet` branch if Gateway was its only user, the launch and
  takeover branches), `sessions/account-check.ts` (`credentialsMatch` and identity rules), `catalogue/account-offer.ts:30`,
  `catalogue/model-facts.ts:26`, `shape/agent-models.ts:16`, `trust/auto-mode-models.ts:62`,
  `sessions/fake-adapter.ts:76`, `conversation/picture-limits.ts`, `packages/db/src/store/accounts.ts:168-170`.
- Desktop: `model-format.ts:34`, `account-fields.tsx:139`, `account-form-values.ts:69`, `:88`, `secret-form.tsx:38`,
  `tier-overrides.tsx:78-82` (the free-text tier fields), `account-kind-label.ts`, the add-account choices.
- Startup: before anything parses accounts, a stored `gateway` row stops the daemon with
  `Account "<label>" (<id>) is a Gateway account, which 10db no longer supports. Remove it from the database
  and start again.` Read the row's kind with a raw query so the narrowed type never parses it. Put it beside the
  daemon's other startup checks in `apps/daemon/src/daemon/start.ts` or a small module of its own.
- `packages/agent-skill/src/commands.ts:49`: drop the stale `modelMap` key.
- Part 1's decision record, `2026-11-21-accounts-store-their-harness.md` in `docs/architecture/decisions/`: the harness
  is stored on the account and is the only Claude-or-Codex question; Gateway is removed and a stored one refuses
  startup. Cite the spec. Update docs that describe Gateway (`grep -rln -i gateway docs/architecture apps/*/AGENTS.md
  apps/daemon/src/**/AGENTS.md`), past specs and plans excepted.

## State-table rows

- daemon starting / a stored `gateway` account → refuse to start, naming it.

## Tests

- One test on a real SQLite file: a database holding a `gateway` row refuses startup with that message (core:
  startup and data). Delete or rewrite every existing Gateway test; add no others.

## Done when

Before you report, click through Settings › Accounts (add-account choices, an account card's "Runs ..." label) and
a project's Billing picker against the real daemon (the `10db-dev-window` skill, or `make dev` and the dev UI), and
save screenshots to your scratch folder; name them in the report. 
`grep -rn "Gateway\|gateway" apps packages --include='*.ts' --include='*.tsx'` finds only the startup refusal,
its test and unrelated words (an "AI gateway" in copy is unrelated only if it isn't the account kind); checks as
card 1.
