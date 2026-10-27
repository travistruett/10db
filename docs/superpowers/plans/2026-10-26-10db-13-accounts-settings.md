# 10db Accounts Settings Screen Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fill the planned Accounts slot in Settings. The builder sees every account with its kind, its verified identity and this month's usage against its cap. The builder can add an account, sign a subscription in and confirm the email it reports, enter a keyed account's secret, edit an account and archive one, all without the daemon's API by hand.

**Architecture:**

- **Desktop only.** Every route this screen needs is on `main` (plan 09 Task 8): `GET`/`POST /accounts`, `PATCH /accounts/:accountId`, `POST /accounts/:accountId/archive`, `PUT /accounts/:accountId/secret`, `GET /accounts/:accountId/signin`, `/identity` and `/usage`. No daemon, contracts or database change. If a task finds it needs one, it stops and asks Travis.
- **A new folder `apps/desktop/src/views/settings/accounts/`** holds the screen: the list, the account drawer, the add form, the secret form and their pure helpers. `section-body.tsx` gets one arm and `sections.ts` sets Accounts' `planned` to null, as `apps/desktop/AGENTS.md` describes.
- **Account hooks, query keys and fixtures are scoped to the entity** (decision 7): `apps/desktop/src/daemon/account-queries.ts` and `apps/desktop/src/test/account-fixtures.ts`. The existing account hook and fixtures move there from `queries.ts` and `fixtures.ts`; `events.ts` gets one line.
- **The secret never passes through TanStack Query or React state.** The secret form is an uncontrolled password field read once from `FormData` on submit, cleared at once, and sent by a plain async function in `apps/desktop/src/daemon/account-secret.ts`. Only a status (`saving`, `saved`, an error message) is kept (decision 2).

**Tech Stack:** React 19, Mantine 9, TanStack Query 5, Testing Library, MSW 3, Playwright WebKit with axe for the end-to-end check. No new dependency.

**Spec:** `docs/superpowers/specs/2026-10-17-10db-accounts-design.md` §7 "Settings (M2b)" and §12 point 4; §3, §4 and §5 for what an account is, how a subscription signs in and confirms its identity, and how a keyed account's secret is stored. Open item: "Accounts: the Accounts Settings screen" in `docs/open-items.md`.

**Built on:** `main` at `8d49fbd` (PR #69). Plan 09 reserved the name `10db-12-accounts-settings`; 12 went to the lane sandbox plan, so this is plan 13.

## Travis's decisions

Travis decided each row on 2026-10-27. Every row took the recommended default except row 7, which he widened: code is scoped per backend entity.

| # | Question | Decided | Alternative not taken | Tasks affected |
|---|---|---|---|---|
| 1 | How is the screen laid out? | **A table of accounts and a drawer per account.** The table shows label and identity, kind, status ("Ready", "Needs sign-in", "Needs a secret") and this month's usage against the cap. Clicking a row opens a drawer with the account's sign-in or secret, its usage by project, its fields to edit and Archive. "Add account" opens a modal. Archived accounts sit in a collapsed "Archived" list below, read-only. | One card per account, stacked, with everything inline. | 3, 4, 6, 7 |
| 2 | How is the secret entered and confirmed? | **One write-only password field with no reveal toggle, typed once.** On submit the field is read once and cleared at once, so a failed save needs the secret pasted again; the copy says so. The secret is sent outside TanStack Query (whose mutation cache keeps `variables` for five minutes after a request), and no React state holds it. "Confirmation" is the daemon's answer: the status changes to "Secret set" from `secretSet`, and a **Check** button runs the identity probe so the builder sees the key works. The probe runs only on that click, never automatically. | Type the secret twice; or run the identity probe right after saving. | 5 |
| 3 | Where does the builder confirm a subscription's identity? | **In the drawer as well as in the inbox.** "Check sign-in" calls `GET /accounts/:id/identity` (it starts Claude Code with no prompt, so it runs only on a click). The drawer shows the email seen and, when the account has none recorded or a different one, "Confirm ‹email›", which `PATCH`es `expectedIdentity` to that email. A different email replacing a recorded one says that sessions will then run as that login. For API-key and Bedrock accounts that report an organization, the same button offers "Require ‹organization›". A gateway never takes one. | Confirm only through the inbox card the daemon already raises. | 4 |
| 4 | How much of an account can be edited here? | **Everything `PATCH /accounts/:id` takes:** label, payer, lane cap, monthly cap (metered kinds; clearing it sends null), Bedrock region and profile-or-bearer-token, gateway base URL, the model map (alias → the channel's model ID, as rows) and the offered aliases. A gateway usually needs a model map (spec §5), so leaving it out would leave most gateways API-only. The add form takes the same fields. | Leave the model map and aliases to the API for now; edit only label, payer and the caps. | 6, 7 |
| 5 | Does the screen show an account's pause, and each project's fallback and move-back? | **No.** `AccountDto` carries no pause state, so showing it needs a daemon change, which is out of scope for this plan. The fallback and move-back display is its own open item ("the Accounts screen shows each project's fallback…"), left open. The inbox already says why an account paused. | Ask for a daemon change adding the pause reason to `AccountDto` and show it in the status column. | none |
| 6 | Which month does usage show? | **The daemon's current month** (`GET /usage` with no `month`), labelled from the response's `month` ("October 2026"). The table shows the total; the drawer shows the per-project breakdown. A subscription shows tokens and no dollars; a metered account shows dollars against its cap with a bar that turns orange at the cap (`DESIGN.md`: orange is paused for limits). No month picker. | A month picker in the drawer. | 2, 4 |
| 7 | Where do account hooks, query keys and fixtures live? | **Scoped to the entity, as Orgtools does.** `daemon/account-queries.ts` holds `accountKeys` and every account hook, including the existing `useAccounts`, which moves out of `queries.ts` along with `queryKeys.accounts`. `test/account-fixtures.ts` holds every account fixture, including the existing `accountDto` and `DEFAULT_ACCOUNT`, which move out of `fixtures.ts`. Their importers are re-pointed (`project-billing.tsx` and `new-project-form.tsx` change only their import line). `events.ts` imports `accountKeys`. `apps/desktop/AGENTS.md` states the convention: hooks, keys and fixtures per backend entity. Splitting the rest of `queries.ts` and `fixtures.ts` (projects, tasks, batches, board columns, workstreams, inbox…) is a new open item, deferred until no big branches are in flight. The shared files only lose lines here, so whichever branch merges second has a small rebase. | Only new account code in new files; or split every entity now. | 1, 9 |
| 8 | What does the end-to-end test cover, given the e2e daemon writes to the real login Keychain? | **Add a subscription, check its sign-in on the fake adapter, confirm the email, add an API-key account and see "Needs a secret", and run axe on the screen and the drawer in dark and light.** No secret is saved end to end: `main.ts` gives the e2e daemon `systemKeychain`, and `main.ts` is off-limits. The secret form is covered by component tests against MSW. | Ask for a daemon change that gives the fake-scripts daemon an in-memory Keychain, and save a secret end to end. | 8 |
| 9 | Does the Billing section change? | **No.** The project's account and fallback pickers stay as they are. | Link each picker to its account's drawer. | none |

## New decisions

One row goes into `docs/architecture/decisions.md` in Task 9, numbered after the highest row on `origin/main` at commit time, and renumbered on any later rebase: `tests/repo` requires the rows numbered from 1 with no gaps or repeats, and other branches in flight add rows too. Only N1 records a non-obvious choice; the identity Confirm (decision 3) and the per-entity convention (decision 7, in `apps/desktop/AGENTS.md`) need no row.

| # | Decision | Why |
|---|---|---|
| N1 | The desktop never keeps an account secret beyond the request that sends it. The field is uncontrolled, has no reveal toggle, is read once from `FormData` and cleared on submit; the request goes through a plain function, not a TanStack mutation; no state, cache, log or error message holds the value. | TanStack keeps a mutation's `variables` in its cache after the request ends, and React state lives as long as the component. A secret held there could reach DevTools, a crash report or a screenshot. |

## Global Constraints

- Read `AGENTS.md`, `apps/desktop/AGENTS.md`, `DESIGN.md`, `.claude/rules/code-style.md` and `.claude/rules/testing.md` before the first task.
- **Off-limits** (another session is changing them): `apps/daemon/src/sandbox/`, `src/git/`, `src/runner/`, `src/daemon/start.ts`, `src/main.ts`; `apps/desktop/src/views/settings/project-general-form.tsx` and anything about permission mode; `apps/desktop/src/shell/app-layout.tsx`, `shell/daemon-status.tsx`, `src-tauri/src/tray.rs`, `src-tauri/tauri.conf.json`; `docs/architecture/03-trust-boundaries.md`. `project-billing.tsx` stays as it is.
- **No daemon, contracts or database change.** A task that seems to need one stops and asks Travis.
- **Shared files** (the approval-sheet session also edits them): `apps/desktop/src/daemon/queries.ts`, `daemon/events.ts`, `test/fixtures.ts`, `apps/desktop/AGENTS.md`, `docs/open-items.md`. Changes there stay small: `queries.ts` and `fixtures.ts` only lose their account code (decision 7), `events.ts` gets one line, `AGENTS.md` one bullet, and `open-items.md` the Accounts item plus two new items.
- New decision rows take the next numbers after the highest row on `origin/main`, with no gaps or repeats, and are renumbered on rebase (Task 9).
- Daemon calls go through the typed Hono client and `readJson` with the `@10db/contracts` schema. Never a hand-written `fetch`.
- Mantine components and theme tokens only; Tabler icons at stroke 1.5, 16 in the table and 20 elsewhere; `size="sm"` in the table, `md` in the drawer and modal; sentence case; every view works in light mode.
- The React Compiler is on: no hand-written `useMemo` or `useCallback`.
- Form values become an `AccountInput` or `AccountPatch` through those zod schemas before they're sent; the daemon's own refusal message is shown as is.
- **The secret**: the form uses `onSubmit` and `FormData`, never a React 19 form `action`, `useActionState` or `useFormStatus` (they hold the pending `FormData` in React while the request runs). Never in React state, a TanStack query or mutation, the DOM after submit, `console`, an error message the UI keeps, a URL, or a test snapshot. Tests use a recognisable fake (`pasted-value-never-echoed`) and assert its absence.
- Tests: Testing Library and MSW against the daemon URL; table-driven tests for the pure helpers; each test red first, for the expected reason; no sleeps; never pipe test output through `tail`.
- Commands: `pnpm --filter @10db/desktop exec vitest run <path>` for one file, `pnpm --filter @10db/desktop typecheck`, `pnpm --filter @10db/desktop e2e` for the end-to-end run, `make gate` at the end.
- Commits: Conventional Commits, scope `desktop` (code) or `docs` (docs), subject lowercase, every path named in `git add`, single-quoted `-m`, the attribution footer the implementer's harness supplies.

## Review Focus

1. **The secret.** It must never be echoed (no reveal toggle, no value shown after submit), logged, or kept in UI state past the request that sends it: not in React state, not in TanStack's query or mutation cache, not in an error message, not in the DOM once submitted, whether the request succeeds, fails or the drawer closes mid-request. Task 5 has a row for each of success, a daemon refusal, a network failure and unmounting mid-request, each asserting that no input displays the fake secret (`screen.queryByDisplayValue`: a password field's live value never shows in `innerHTML`, so this is the DOM proof) and that it is absent from `document.body.innerHTML`, `JSON.stringify` of both caches and every `console` call.
2. **Confirming the right identity.** Confirm must send exactly the email the probe saw *for this account*. Switching the drawer to another account must not carry a previous check's result over. Task 4 has a row that checks account A, opens account B and expects no Confirm button until B is checked.
3. **A patch sends only what changed.** Clearing the monthly cap sends `null`, not `0`; a subscription never sends `monthlyCapUsd`; settings go whole, as `PATCH` requires. Task 7's table covers each.
4. **Usage numbers.** A subscription's null `costUsd` never renders as "$0.00"; a metered account at exactly its cap shows the cap as reached. Task 2's table covers both.
5. **Archiving.** The default account offers no Archive (the daemon refuses it); a refused archive shows the daemon's reason, which names the projects to move first. Task 7 has both rows.

## File Structure

```
apps/desktop/src/
  daemon/account-queries.ts (+ test)   accountKeys, useAccounts (moved), useAccountUsage, useAccountSignIn, useCreateAccount,
                                        usePatchAccount, useArchiveAccount, useCheckAccountIdentity  (Task 1)
  daemon/account-secret.ts (+ test)    sendAccountSecret: PUT /accounts/:id/secret, outside TanStack  (Task 5)
  daemon/queries.ts                    − queryKeys.accounts, useAccounts, AccountList (moved)         (Task 1)
  daemon/events.ts (+ events.test.tsx) session events also refresh ['accounts', 'usage']              (Task 1)
  test/account-fixtures.ts             accountDto, DEFAULT_ACCOUNT (moved), accountUsageDto,
                                       accountIdentityDto, accountSignInDto                           (Task 1)
  test/fixtures.ts  test/daemon.tsx    − account fixtures; import them from account-fixtures.ts      (Task 1)
  views/settings/project-billing.tsx  views/board/new-project-form.tsx
  views/board/board-view.test.tsx  views/settings/settings-view.test.tsx   import lines only     (Task 1)
  views/settings/
    sections.ts  section-body.tsx  settings-view.test.tsx                                          (Task 3)
    accounts/
      account-status.ts (+ test)       Ready / Needs sign-in / Needs a secret, from the DTO          (Task 2)
      usage-text.ts (+ test)           token and dollar text, the cap share, the month label         (Task 2)
      accounts-section.tsx (+ test)    the table, the archived list, Add account                     (Task 3)
      account-drawer.tsx (+ test)      one account: identity, sign-in, secret, usage, edit, archive  (Tasks 4–7)
      usage-by-project.tsx             the month's per-project table                                 (Task 4)
      sign-in-steps.tsx                the command with a copy button, and Check sign-in             (Task 4)
      identity-check.tsx               the probe's result and Confirm                               (Task 4)
      secret-form.tsx (+ test)         the write-only secret field                                   (Task 5)
      account-form-values.ts (+ test)  form values → AccountInput / AccountPatch                     (Task 6, 7)
      account-fields.tsx               the shared fields per kind, model map rows, aliases           (Task 6)
      add-account-modal.tsx (+ test)                                                                  (Task 6)
      edit-account-form.tsx  archive-account.tsx (+ tests in account-drawer.test.tsx)               (Task 7)
apps/desktop/e2e/loop.spec.ts          the Accounts steps replace "Not built yet"                    (Task 8)
README.md  docs/architecture/04-accounts.md  docs/architecture/decisions.md  docs/open-items.md
apps/desktop/AGENTS.md                                                                               (Task 9)
```

`account-kind-label.ts` stays where it is: Billing uses it, and the accounts folder imports it.

---

### Task 1: Account hooks and usage refresh

**Files:**

- Create: `apps/desktop/src/daemon/account-queries.ts`, `apps/desktop/src/daemon/account-queries.test.tsx`, `apps/desktop/src/test/account-fixtures.ts`
- Modify: `apps/desktop/src/daemon/queries.ts` and `apps/desktop/src/test/fixtures.ts` (account code moves out), `apps/desktop/src/daemon/events.ts` (one line), `apps/desktop/src/daemon/events.test.tsx`, and the import line only of `test/daemon.tsx`, `views/settings/project-billing.tsx`, `views/board/new-project-form.tsx`, `views/board/board-view.test.tsx`, `views/settings/settings-view.test.tsx`

**Interfaces:**

- `accountKeys = { all: ['accounts'], usage: ['accounts', 'usage'], usageOf: (id: AccountId) => ['accounts', 'usage', id] as const }`, replacing `queryKeys.accounts`. Usage sits under the `['accounts']` prefix, so an `account` event refreshes it too (a cap change changes `monthlyCapUsd`).
- `useAccounts()` moves here unchanged in behaviour; `accountDto` and `DEFAULT_ACCOUNT` move to `test/account-fixtures.ts` unchanged.
- `INVALIDATIONS.account` uses `accountKeys.all`; `INVALIDATIONS.session` becomes `[...WORK, accountKeys.usage]`: a session's usage is recorded when it ends.
- `useAccountUsage(id)` → `AccountUsageDto` (no `month`: the daemon's current month).
- `useAccountSignIn(id, enabled)` → `AccountSignInDto`; enabled only for a subscription.
- `useCreateAccount()` → `AccountCreatedDto`; invalidates `['accounts']`.
- `usePatchAccount(id)` → `AccountDto`; invalidates `['accounts']` and `queryKeys.projects` (pickers show labels).
- `useArchiveAccount()` → `AccountDto`; invalidates `['accounts']`.
- `useCheckAccountIdentity()`: a mutation whose variable is the `AccountId` (never a secret), answering `AccountIdentityDto`. A mutation, because the probe starts Claude Code and runs only on a click (decision 3).
- `test/account-fixtures.ts`: `accountUsageDto`, `accountIdentityDto`, `accountSignInDto`, each `parse`d through its contract like the moved `accountDto`.

- [ ] **Step 1: Write the failing tests.** `account-queries.test.tsx`, through `renderWithDaemon` and a tiny probe component per hook: create posts the body and refetches `/accounts`; patch sends only the patch and refetches `/accounts` and `/projects`; archive posts to `/archive`; usage requests `/accounts/:id/usage` with no `month` query; sign-in is not requested when disabled; identity is requested only when the mutation runs. In `events.test.tsx`, one row: a `session` event refetches an open usage query; an `account` event refetches it too.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/daemon/account-queries.test.tsx src/daemon/events.test.tsx`. Expected: FAIL (module not found; the session row sees no refetch).
- [ ] **Step 3: Implement.** First move `useAccounts`, its key and the account fixtures and re-point their importers; run `pnpm --filter @10db/desktop exec vitest run src` and `pnpm --filter @10db/desktop typecheck` to show the move changed nothing (a pure move has no red step). Then the new hooks after the patterns in `queries.ts`, and the `events.ts` line with a comment ("a session's tokens and dollars are recorded when it ends").
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** in two: `refactor(desktop): scope the account hook and fixtures to their own modules` with the moved and re-pointed files, then `feat(desktop): add the account hooks and refresh usage on session events` with the rest.

### Task 2: Account status and usage text

**Files:**

- Create: `apps/desktop/src/views/settings/accounts/account-status.ts`, `account-status.test.ts`, `usage-text.ts`, `usage-text.test.ts`

**Interfaces:**

- `AccountStatus = { Ready: 'ready', NeedsSignIn: 'needs_sign_in', NeedsSecret: 'needs_secret', Archived: 'archived' } as const`, its type, `accountStatus(account: AccountDto): AccountStatus` and `ACCOUNT_STATUS_LABEL`. It mirrors the daemon's `unready()` from what the DTO carries: a subscription with no `expectedIdentity` needs sign-in; `needsSecret(kind, settings) && !secretSet` needs a secret. A comment points at `apps/daemon/src/accounts/readiness.ts` as the rule it mirrors.
- `formatTokens(n)` (compact: "1.2M"), `formatUsd(n)` ("$123.45"), `monthLabel('2026-10')` ("October 2026", in UTC so no time zone shifts the month), and `capShare(usage): { pct: number; reached: boolean } | null` (null without a cap or for a subscription).

- [ ] **Step 1: Write the failing tests**, one table each, named rows: subscription unconfirmed / confirmed; default account confirmed; API key with and without a secret; Bedrock on a profile (no secret needed) and on a bearer token without one; gateway with one; archived wins over every other status. Usage: subscription total with `costUsd: null` renders no dollar text; metered under, at and over cap (`reached` at exactly the cap); no cap → null; zero tokens → "0".
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/views/settings/accounts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** both, exhaustive switches over `AccountKind` through `needsSecret`.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): derive an account's status and usage text`.

### Task 3: The accounts list replaces the planned slot

**Files:**

- Create: `apps/desktop/src/views/settings/accounts/accounts-section.tsx`, `accounts-section.test.tsx`
- Modify: `apps/desktop/src/views/settings/sections.ts`, `section-body.tsx`, `settings-view.test.tsx`

**Interfaces:** `AccountsSection()` renders a `Table` labelled "Accounts" (`aria-label`), one row per account not archived: the label, the identity below it in monospace (or "No identity yet"), the kind (`ACCOUNT_KIND_LABEL`), a status `Badge` (teal Ready, yellow Needs sign-in / Needs a secret: waiting on a human; teal, the primary colour, because green means done in `DESIGN.md`), and this month's usage (Task 2's text, a `Progress` for a capped account). Each row is a button-like row reachable by keyboard (a `UnstyledButton` in the label cell named "Open ‹label›") that opens the drawer (Task 4; until then the click does nothing). "Default" shows beside the default account. Archived accounts go in a collapsed `Accordion` item "Archived (n)", label and kind only. Above the table, an "Add account" button (Task 6 wires it).

- [ ] **Step 1: Write the failing tests.** `accounts-section.test.tsx` via `renderApp('/settings/accounts')`: lists the default account with its identity and "Ready"; an unconfirmed subscription shows "Needs sign-in"; an API key without a secret shows "Needs a secret"; a metered account shows "$120.00 of $500.00" and its progress bar's value; an archived account appears only under "Archived (1)". In `settings-view.test.tsx`, the planned-section test moves from Accounts to Team ("team editor plan").
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/views/settings`. Expected: FAIL (Accounts still shows "Not built yet"; the new file's assertions fail).
- [ ] **Step 3: Implement.** `sections.ts`: Accounts' `planned` becomes null. `section-body.tsx`: an Accounts arm rendering the heading and `<AccountsSection />`, removed from the planned group. Each row's usage comes from its own `useAccountUsage` in a small row component.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): list accounts with their identity, status and usage in settings`.

### Task 4: The account drawer: usage by project, sign-in and identity

**Files:**

- Create: `apps/desktop/src/views/settings/accounts/account-drawer.tsx`, `account-drawer.test.tsx`, `usage-by-project.tsx`, `sign-in-steps.tsx`, `identity-check.tsx`
- Modify: `accounts-section.tsx`

**Interfaces:**

- `AccountDrawer({ accountId, onClose })`: a Mantine `Drawer` (position right, `size="md"`) titled with `accountDisplayName`. It reads the account from `useAccounts()` so an edit or event refreshes it, and is rendered with `key={accountId}` so nothing from another account carries over. Sections, in order: Identity (subscriptions: `SignInSteps` then `IdentityCheck`; keyed: `SecretForm` in Task 5, then `IdentityCheck`; a gateway gets Check too, never Require, because the daemon refuses an expected identity for it), Usage this month (`UsageByProject`), Settings (Task 7), Archive (Task 7).
- `SignInSteps({ account })`: from `useAccountSignIn`: "1. In Terminal, run" the command in a `Code` block with a `CopyButton` (Tabler copy/check icons, "Copy command" / "Copied"); "2. Sign in as the email this account should use"; "3. Check sign-in". The default account's copy says it is the login 10db already uses and the command switches it.
- `IdentityCheck({ account })`: a "Check sign-in" (subscription) or "Check" (keyed) button running `useCheckAccountIdentity`. While pending it says "Starting Claude Code to read the account…". The result shows the email or organization seen, and the refusal's `message` when there is one (red `Alert` for a mismatch or wrong credentials, yellow for unconfirmed). It offers:
  - subscription, email seen, and it differs from `expectedIdentity` (including null): **Confirm ‹email›**, which `PATCH`es `{ expectedIdentity: email }`. When a different one was recorded, the button's description says "Sessions on this account will run as ‹email› from now on."
  - API key or Bedrock, organization seen, `expectedIdentity` null: **Require ‹organization›**, the same patch.
  - after a confirm, the result clears and the row shows the new identity.
- `UsageByProject({ accountId })`: the month label, the total and a `Table` of projects (name, tokens in, out, cached, dollars for metered kinds), "No sessions this month" when empty.

- [ ] **Step 1: Write the failing tests** in `account-drawer.test.tsx` (`renderApp('/settings/accounts')`, open a row):
  - a new subscription shows its sign-in command and copies it (stub `navigator.clipboard.writeText` and assert the command);
  - Check sign-in, seen `client@example.com`, refusal `unconfirmed` → Confirm sends exactly `{ expectedIdentity: 'client@example.com' }` to `PATCH /accounts/:id`;
  - a recorded identity that differs → the refusal message and the "will run as" description, then Confirm;
  - a recorded identity that matches → "Signed in as …", no Confirm;
  - an API key reporting `organization: 'Acme'` with none recorded → Require Acme; a gateway reporting an organization shows Check and its result but no Require button;
  - check account A, close, open account B → no result and no Confirm until B is checked (Review Focus 2);
  - the identity request is not made when the drawer opens, only on the click;
  - a `409` from the probe shows the daemon's message;
  - usage by project lists each project with its tokens; a subscription's table has no dollar column.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/views/settings/accounts/account-drawer.test.tsx`. Expected: FAIL (no drawer opens).
- [ ] **Step 3: Implement** the four components and open the drawer from the row (selected account id in `AccountsSection` state; ids are not secrets).
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): show an account's usage by project, sign-in steps and identity check`.

### Task 5: The secret form

**Files:**

- Create: `apps/desktop/src/daemon/account-secret.ts`, `account-secret.test.ts`, `apps/desktop/src/views/settings/accounts/secret-form.tsx`, `secret-form.test.tsx`
- Modify: `account-drawer.tsx`

**Interfaces:**

- `sendAccountSecret(client: DaemonClient, id: AccountId, input: AccountSecretInput): Promise<AccountDto>`: `client.accounts[':accountId'].secret.$put(...)` through `readJson(…, AccountDto)`. It is not a hook and touches no cache; the caller refreshes `['accounts']` afterwards with `invalidateQueries` (which carries no secret).
- `SecretForm({ account })`: shown for an account where `needsSecret(kind, settings)`. Its only state is

  ```ts
  type SecretFormState =
    | { readonly kind: 'idle' }
    | { readonly kind: 'saving' }
    | { readonly kind: 'saved' }
    | { readonly kind: 'failed'; readonly message: string };
  ```

  The field is a Mantine `TextInput` with `type="password"`, `name="secret"`, no `value` or `defaultValue` prop, `autoComplete="new-password"` (WebKit and Chrome ignore `off` on password fields and would offer saved passwords), `spellCheck={false}`, `autoCapitalize="off"`, and no reveal toggle (`PasswordInput`'s toggle would echo it). Its label says what the account takes ("API key", "Gateway token", "Bedrock bearer token"); its description: "Stored in your login Keychain, never in 10db's database. It can't be shown again; paste it again to replace it."
  On submit: `event.preventDefault()`; read `new FormData(form).get('secret')` once; `form.reset()` at once, before any `await`; `AccountSecretInput.safeParse`; on failure show the first issue's message (zod's message, which never contains the input). Then set `saving`, `await sendAccountSecret`, invalidate `['accounts']`, set `saved`; on a throw set `failed` with `error.message` for a `DaemonRequestError` and a fixed "Couldn't reach the daemon; paste the secret again to retry" otherwise. Nothing catches and logs. The local holding the secret goes out of scope when the handler returns.
  Above the field: "Secret set" (teal) when `account.secretSet`, otherwise "No secret yet" (yellow). The button says "Save secret" or "Replace secret".

- [ ] **Step 1: Write the failing tests.** In `secret-form.test.tsx`, with `const PASTED = 'pasted-value-never-echoed'` (low entropy and no key-like name, so gitleaks doesn't flag the test) and `vi.spyOn` on `console.log`, `info`, `warn`, `error` and `debug`; each row ends by asserting `assertNoSecret(queryClient)`: `screen.queryByDisplayValue(PASTED)` is null (the check that catches a field never cleared; `innerHTML` can't see an input's value), and the secret is absent from `document.body.innerHTML`, `JSON.stringify(queryClient.getQueryCache().getAll().map(q => q.state))`, `JSON.stringify(queryClient.getMutationCache().getAll().map(m => m.state))`, and every console spy's arguments; and the field's `value` is `''`.
  - success: the `PUT` body is exactly `{ secret: PASTED }`, sent once; the badge turns to "Secret set" from the refetched list; the field is empty;
  - the field is empty while the request is in flight (hold the MSW handler on a promise the test resolves);
  - a `409` refusal (`{ error: 'conflict', message: 'No Keychain is available to this daemon, so account:acc_… was not written' }`) shows that message, and the secret is absent;
  - a network error (`HttpResponse.error()`) shows the fixed message, and the secret is absent;
  - a too-short value (`short`) is refused before any request with zod's message, and nothing is sent;
  - closing the drawer mid-request unmounts the form; after the request resolves, `/accounts` is refetched and the secret is absent;
  - there is no button named "Show" or "Toggle" in the form.
  In `account-secret.test.ts`: the request goes to `PUT /accounts/:id/secret` with the bearer token, and the answer is parsed as `AccountDto`.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/daemon/account-secret.test.ts src/views/settings/accounts/secret-form.test.tsx`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** both and place `SecretForm` in the drawer for keyed accounts.
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): enter an account's secret without keeping it in the ui`.

### Task 6: Adding an account

**Files:**

- Create: `apps/desktop/src/views/settings/accounts/account-form-values.ts`, `account-form-values.test.ts`, `account-fields.tsx`, `add-account-modal.tsx`, `add-account-modal.test.tsx`
- Modify: `accounts-section.tsx`

**Interfaces:**

- `AccountFormValues`: plain strings and booleans the fields edit: `kind`, `label`, `payer`, `laneCap`, `monthlyCapUsd` (`''` = none), `organization`, `region`, `bedrockAuth` (`'profile' | 'bearer'`), `awsProfile`, `baseUrl`, `modelMap: { alias: string; modelId: string }[]`, `aliases: string[]`. `emptyAccountForm(kind)`.
- `toAccountInput(values): { ok: true; input: AccountConfig } | { ok: false; errors: Record<string, string> }`: builds the kind's object, runs `AccountInput.safeParse` and returns `parsed.data` (the output, defaults filled), so the posted body is fixed; mapping each issue's path onto its field (`settings.region` → `region`, `settings.modelMap.<alias>` → `modelMap`). Empty optional fields are omitted, not sent as `''`.
- `AccountFields({ values, onChange, errors, mode })`: the kind's fields. Subscription: label, payer, lane cap, model map, aliases. API key: plus monthly cap and organization. Bedrock: plus region, "Sign in with" (`SegmentedControl` AWS profile / Bearer token), profile name when on a profile. Gateway: plus base URL, no organization. The model map is rows of alias `TextInput` and model ID `TextInput` with Add and Remove; aliases a `TagsInput`.
- `AddAccountModal({ opened, onClose, onCreated })`: kind first (`Select` of `SUPPORTED_ACCOUNT_KINDS` with `ACCOUNT_KIND_LABEL`), then the fields. On create, the modal closes and `onCreated(account.id)` opens that account's drawer, where a subscription shows its sign-in steps (the `signIn` in the answer is the same as `GET /signin`) and a keyed account shows its secret form.

- [ ] **Step 1: Write the failing tests.** `account-form-values.test.ts`, a table: a minimal subscription; an API key with a $500 cap and an organization; an API key with an empty cap omits it; Bedrock on a profile; Bedrock on a bearer token sends `awsProfile: null`; a gateway with a base URL and a model map; a gateway URL with credentials is refused onto `baseUrl`; a bad region onto `region`; a model map alias in capitals onto `modelMap`; an empty label onto `label`; a subscription never carries `monthlyCapUsd` or `expectedIdentity`. `add-account-modal.test.tsx`: Add account → Claude subscription → label "Company A" → Create posts exactly `{ kind: 'claude_subscription', label: 'Company A', payer: '', laneCap: 4, settings: {} }`, closes, and the drawer opens on the sign-in steps; Amazon Bedrock on AWS profile `client-b` in `us-west-2` posts `settings: { region: 'us-west-2', awsProfile: 'client-b' }` and opens the drawer without a secret form; a gateway with base URL `https://gw.example.com/v1`, a model map row `sonnet` → `anthropic/claude-sonnet` and alias `sonnet` posts that `settings` whole and opens the drawer on its secret form; a daemon `409` (label taken) shows its message in the modal and keeps it open; an invalid field shows its error and sends nothing.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/views/settings/accounts`. Expected: FAIL (modules not found).
- [ ] **Step 3: Implement** the values, the fields and the modal; wire "Add account".
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): add accounts of every kind from settings`.

### Task 7: Editing and archiving an account

**Files:**

- Create: `apps/desktop/src/views/settings/accounts/edit-account-form.tsx`, `archive-account.tsx`
- Modify: `account-form-values.ts`, `account-form-values.test.ts`, `account-drawer.tsx`, `account-drawer.test.tsx`

**Interfaces:**

- `formValuesOf(account: AccountDto): AccountFormValues` and `toAccountPatch(account, values): { ok: true; patch: AccountPatch } | { ok: false; errors } | { ok: true; patch: null }` (null when nothing changed). It sends only changed top-level fields; `settings` goes whole when any setting changed, checked with the kind's settings schema (`parseAccountSettings`); a cleared monthly cap sends `null`; the organization is edited by the identity check, not here.
- `EditAccountForm({ account })`: `AccountFields` in edit mode (kind fixed, shown as text), Save disabled while nothing changed, the daemon's message on a refusal. On a Bedrock account, the "Sign in with" control says in edit mode that switching to an AWS profile forgets the stored bearer token, and switching back needs it pasted again (the daemon clears the secret, `packages/db/src/store/accounts.ts` `patchAccount`). Clearing a recorded identity to null is out of scope (the API allows it; Confirm replaces one).
- `ArchiveAccount({ account })`: hidden for the default account, with a line saying the default account can't be archived. Otherwise a red outline "Archive account" opening a confirm modal: "‹label› stops taking projects. Archived accounts can't be restored." Confirm posts `/archive`; a `409` shows the daemon's message (it names the projects to move first). On success the drawer closes.

- [ ] **Step 1: Write the failing tests.** `account-form-values.test.ts` adds a `toAccountPatch` table: nothing changed → null; label only; cap cleared → `{ monthlyCapUsd: null }`; cap set on an API key; a subscription never sends `monthlyCapUsd`; Bedrock profile → bearer sends the whole settings with `awsProfile: null`; Bedrock bearer → profile (forgets the token) sends the whole settings with the profile; a model map row added sends the whole settings; payer to `''`. `account-drawer.test.tsx` adds: Save sends exactly the patch and the row shows the new label; a refused patch shows the message; Archive confirm posts and closes; a `409` with "Move "Demo" to another account before archiving" shows that message; the default account shows no Archive button.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop exec vitest run src/views/settings/accounts`. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** the same command. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): edit and archive accounts from settings`.

### Task 8: End to end and accessibility

**Files:**

- Modify: `apps/desktop/e2e/loop.spec.ts`

- [ ] **Step 1: Write the failing steps.** Replace "a planned section says it is not built yet" with: open Accounts; the default account "Claude plan" shows Ready (only because the loop already ran a task: the first session's probe records its email, `apps/daemon/src/accounts/cards.ts`; a comment in `loop.spec.ts` says so); `expectAccessible(page, 'settings, accounts, dark')`; Add account → Claude subscription "Company A" → the drawer shows its sign-in command naming its config directory; Check sign-in (the fake adapter reports `builder@example.com`) → Confirm builder@example.com → the row shows "Company A · builder@example.com" and Ready; `expectAccessible(page, 'settings, accounts drawer, dark')`; close; Add account → Anthropic API key "Client B" with a $500 cap → the drawer shows "No secret yet" and the row "Needs a secret". No secret is saved (decision 8). In the light-mode block, open Accounts and run `expectAccessible(page, 'settings, accounts, light')`. Keep the "Planned" coverage on another planned section (Team) so the planned panel is still exercised.
- [ ] **Step 2: Run** `pnpm --filter @10db/desktop e2e`. Expected: before Tasks 3–7 it fails at `getByRole('table', { name: 'Accounts' })`; run now, after them, it must PASS. If axe reports a violation, fix the component, not the test.
- [ ] **Step 3: Commit** `test(desktop): drive the accounts screen end to end with axe`.

### Task 9: Docs

**Files:**

- Modify: `README.md` (## Accounts: replace "Until the Accounts screen ships…" and the curl block with Settings › Accounts steps: add, sign in and confirm, paste a secret; keep one sentence that the same routes exist on the API), `docs/architecture/04-accounts.md` (the `apps/desktop` row: the Accounts screen is built, plan 13), `docs/open-items.md` (tick the Accounts screen item and correct "plan 12" to plan 13; leave the fallback-display item open, and add two: an in-memory Keychain for the fake-scripts daemon so the secret path gets an end-to-end run; split the rest of `queries.ts` and `fixtures.ts` per entity, deferred until no big branches are in flight), `apps/desktop/AGENTS.md` (one bullet: hooks, query keys and fixtures are scoped per backend entity, `daemon/<entity>-queries.ts` and `test/<entity>-fixtures.ts`, with accounts the first; the secret is sent by `daemon/account-secret.ts` and never through TanStack), `docs/architecture/decisions.md` (row N1 only, numbered after `origin/main`'s highest row at commit time).
- [ ] **Step 1: Find the next number.** `git fetch origin main && git show origin/main:docs/architecture/decisions.md | grep -oE '^\| [0-9]+ ' | tr -d '| ' | sort -n | tail -1`. N1 takes the next number after it. If the branch is later rebased onto a `main` with more rows, renumber them in the rebase (rebases ask Travis first).
- [ ] **Step 2: Edit** the docs; mark the screen **built**.
- [ ] **Step 3: Run** `pnpm exec vitest run --project repo`. Expected: PASS (decision numbering, doc structure).
- [ ] **Step 4: Commit** `docs(docs): record the accounts screen in the readme, architecture and decisions`.

### Task 10: The gate and review

- [ ] **Step 1: Run** `make gate`, first checking (`pgrep -fl 'make gate'`) that no other session's gate is running, since parallel gates cause test timeouts; wait for it if so. Expected: `GATE PASS`. A failure is fixed in the task that owns it, and the gate runs again.
- [ ] **Merge order:** this branch merges before the lane sandbox stack, which then absorbs the moved account lines.
- [ ] **Step 2:** Dispatch the `code-reviewer` subagent with this plan, Tasks 1–9 and the base commit, pointing it at Review Focus 1 first. Fix what it confirms, run `make gate` again, and show Travis the result before any push.
