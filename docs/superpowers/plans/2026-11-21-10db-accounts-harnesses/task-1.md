# Card 1: the harness on each account

**Spec:** "Accounts and harnesses" (the table, `accounts.settings` gains `harness`, "One source of truth"); "Jobs
and who powers them" (the errands row: area naming on the project's account).
**Track:** A, first. Worktree `../10db-worktrees/accounts-a`.

## Files

- `packages/contracts/src/accounts.ts`: `HARNESSES_OF_KIND`, the `harness` field on every kind's settings (refused
  outside the kind's list), `harnessOf`, `requireHarness`; remove `providerOf`, `runsAgents`, `agentKind`,
  `AGENT_ACCOUNT_KINDS`, `AgentAccountKind`, `OPENROUTER_CANT_RUN_AGENTS`. In this card the OpenRouter row is `[]`;
  card 3 makes it `[Provider.Codex]`.
- `packages/db/src/store/accounts.ts`, `store/projects.ts`: binding a project's account or backup refuses a kind
  with no harness (`requireHarness`'s message), replacing `refuseOpenRouterForAgents`.
- Every `providerOf(` call site (19 files; `grep -rn "providerOf(" apps packages`) takes the account and asks
  `harnessOf`/`requireHarness`. A site that holds only a kind is changed to hold the account (or the account's
  settings beside its kind).
- Every test of `AccountKind.CodexSignin` that means "runs Codex", and of the Claude kinds that means "runs Claude
  Code", asks the harness. Known: `trust/floor-notice.ts:29`, `environment/launch.ts` (`sessionConfigDir`,
  `droppedBy`, the `CODEX_HOME`/`CLAUDE_CONFIG_DIR` picks near `:344` and `:384`), `runner/runner.ts:2648`,
  `accounts/service.ts:228`, `accounts/cards.ts:58`, `accounts/mcp-sign-ins.ts:221`, `:275`,
  `sessions/capabilities.ts:82`, `conversation/picture-limits.ts:113`. Grep for the rest:
  `grep -rn "AccountKind.CodexSignin\|codex_signin" apps packages --include='*.ts' --include='*.tsx'` outside tests.
  A test that is about the credential (sign-in steps, `credentialsMatch`, `signsInWithLogin`, the Codex home's
  ChatGPT login) stays on the kind.
- `apps/daemon/src/daemon/area-namer.ts`: area naming runs on the project's account (Efficient tier), not the
  default account.
- Desktop: the account card and drawer show "Runs Claude Code" / "Runs Codex" (a label, not a picker); a kind
  with no harness shows "No harness runs OpenRouter yet". Billing's project account picker lists accounts with a
  harness and disables the rest with that line (replacing `used-by.ts:43-48`'s OpenRouter rows and
  `project-setup.tsx:172`; card 4 removes the OpenRouter-specific copy).
- `apps/daemon/src/accounts/AGENTS.md`: a note on `harnessOf` as the only Claude-or-Codex question.

## Interfaces (quoted from the index)

```ts
export const HARNESSES_OF_KIND: Readonly<Record<SupportedAccountKind, readonly Provider[]>>;
export function harnessOf(account: {
  readonly kind: SupportedAccountKind;
  readonly settings: AccountSettings;
}): Provider | null;
export function requireHarness(account: {
  readonly kind: SupportedAccountKind;
  readonly label: string;
  readonly settings: AccountSettings;
}): Provider;
const harness = { harness: z.enum(Provider).optional() };
```

## State-table rows

- project bound to an account / its kind has no harness → refused at bind and at launch.

## Tests

- One pure test of `HARNESSES_OF_KIND` through `parseAccountSettings` and `harnessOf`: the default, an allowed
  stored harness, a refused one, a kind with none (rule table, core: the launch environment follows it).
- Update existing tests that called `providerOf`/`agentKind`; add no others.

## Done when

`grep -rn "providerOf\|runsAgents\|agentKind(\|AGENT_ACCOUNT_KINDS" apps packages` finds nothing outside
`generated/`, typecheck and lint pass for contracts, db, daemon and desktop, related tests pass, `make precheck`
passes.
