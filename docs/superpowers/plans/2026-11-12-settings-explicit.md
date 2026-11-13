# Settings say what 10db connects to: implementation plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Settings sorted by what each credential is, with one scope at a time in the sidebar, an Overview of every
connection, OpenRouter as an account, and GitHub and Artificial Analysis set up from the app.

**Architecture:** Five vertical slices, each owning its contracts, daemon routes, UI and tests. The seams are pinned
below (§Interfaces) so slices built in parallel worktrees merge cleanly into `feat/settings-explicit`.

**Tech stack:** TypeScript, Hono (daemon API), zod (`@10db/contracts`), Drizzle/SQLite (`@10db/db`), React + Mantine 9
+ TanStack Router/Query (desktop), Vitest, Playwright.

**Spec:** `docs/superpowers/specs/2026-11-12-10db-settings-explicit-design.md` (read it whole; section numbers below
refer to it).

## Global constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/*/AGENTS.md`,
  `.claude/rules/code-style.md`, `.claude/rules/testing.md` bind every task.
- No migration (spec §12). `accounts.kind` is `text` with no CHECK. If a task finds it needs one, stop and say so.
- `TENDB_JUDGE=off`, `TENDB_BENCHMARKS=off`, `TENDB_SLACK=off` read no Keychain item of theirs.
- Keychain access only through `apps/daemon/src/environment/keychain.ts`; no secret on a command line, in the db
  or in a log.
- No AA numbers in the repo, fixtures or docs. AA's linked name (`ArtificialAnalysisCredit`) beside AA data.
- No notices: no one-time banner, toast or "what's new" line anywhere (spec §9).
- Connection status colours (Overview, Integrations cards, account status in Settings): **teal** = works,
  yellow = needs the builder, gray = off. No green, no red, for connection status (builder's preference, amends
  `DESIGN.md`; task and goal colours are unchanged). A dot always has words; the dot is `aria-hidden`.
- Copy: Title Case buttons, sentence case lines, no "…" on buttons, no em dashes in new copy.
- Every surface fits 1280×720 with the Settings sidebar unscrolled; nothing breaks at 1024×700.
- Generated files (`packages/contracts/generated/`) are regenerated, never hand-edited (`pnpm --filter
  @10db/contracts generate` or the package's script; check `packages/contracts/AGENTS.md`).
- Commits: Conventional Commits with scope, single-quoted `-m`, paths named, value card per newly tested behavior.

## Review focus

1. **The key move runs twice or half-way.** A start that crashes after the account is created but before the old
   item is removed must not create a second OpenRouter account on the next start (Task 2, test "migration is
   idempotent after a partial run").
2. **An OpenRouter account bound to a project.** A project PATCH, a project create or the default-account choice
   naming an OpenRouter account is refused with "OpenRouter can't run agents yet" (Task 2).
3. **gh output arrives split or in another order.** The code and URL may come in separate chunks, on stdout or
   stderr; the parser buffers lines (Task 4, table rows).
4. **A Sign In while another is running, or after Cancel.** One at a time; a second POST is a 409; Cancel kills
   gh and the card returns to its state (Task 4).
5. **A link with an unknown `?focus=`** opens the section's top and throws nothing (Task 1).

## Interfaces (the seams between slices)

Contracts (`packages/contracts/src/…`, exported from the package entry):

- `accounts.ts`: `AccountKind.OpenRouter = 'openrouter'`, added to `SUPPORTED_ACCOUNT_KINDS`.
  `AGENT_ACCOUNT_KINDS` = the five existing kinds; `type AgentAccountKind`.
  `runsAgents(kind: SupportedAccountKind): kind is AgentAccountKind`. `providerOf(kind: AgentAccountKind)`.
  `OpenRouterSettings = z.strictObject({})`. `AccountInput` gains `{ kind: 'openrouter', label, payer }`.
  `needsSecret('openrouter', …) === true`. `isMetered('openrouter') === false`.
  Constant `OPENROUTER_CANT_RUN_AGENTS = "OpenRouter can't run agents yet"`.
- `judge.ts`: `JudgeConfig.accountId: AccountId.nullable()` (default `null`), in `JudgeConfigPatch` too.
  `JudgeStatusDto` drops `keySet`, gains `account: { id: AccountId; label: string; secretSet: boolean } | null`.
- `github.ts` (new): `GithubState = { Off, NotInstalled, SignedOut, SignedIn, Unreachable }` (`'off' |
  'not_installed' | 'signed_out' | 'signed_in' | 'unreachable'`). `GithubStatusDto = { state, login: string | null,
  checkedAt: Timestamp }`. `GithubSigninDto = { code: string; url: string }`. Event
  `EventType.GithubLoginEnded = 'github.login_ended'` with `GithubLoginEndedData = { ok: boolean; login: string |
  null; message: string | null; cancelled: boolean }`.
- `sign-in-url.ts`: `isSignInUrl` also accepts `https://github.com/login/device`.
- `benchmarks.ts`: `BenchmarkKeyInput = { key: string }` (same character rules as `JudgeKeyInput`).
  `BenchmarkStatusDto.keyConfigured` becomes a live read (route reads the Keychain), meaning unchanged.

Routes (`apps/daemon/src/api/app.ts`):

- Task 2: unchanged account routes now accept `openrouter`. `PUT/DELETE /judge/key` are removed.
  `POST /accounts/:accountId/test` → `JudgeTestResultDto` (moved from `POST /judge/test`, which is removed).
- Task 3: `PUT /benchmarks/key` body `BenchmarkKeyInput` → `BenchmarkStatusDto` (writes, starts a sync);
  `DELETE /benchmarks/key` → `BenchmarkStatusDto`.
- Task 4: `GET /github[?recheck=1]` → `GithubStatusDto`; `POST /github/signin` → `GithubSigninDto` (409 if one
  runs, 409 when `off`/`not_installed`); `DELETE /github/signin` → 204.

Desktop:

- Task 1 produces `SettingsScope = { Project: 'project', App: 'app' }` and the `SettingsSection.subhead` field in
  `views/settings/sections.ts`; `useFocusTarget(name: string): { ref, focused }` in
  `views/settings/focus-target.ts`, honouring `?focus=<name>` (scroll into view + focus first focusable).
  Later tasks put `useFocusTarget('github')` etc. on their cards.
- Task 1 produces `ConnectionStatus` in `views/settings/connection-status.tsx`:
  `<ConnectionStatus tone="works" | "needs-you" | "off" label="…" />` (teal/yellow/gray dot + words). Tasks 2–5 use
  it for every connection state.
- Task 2 produces `accountUsedBy(account, projects, judge): readonly string[]` in
  `views/settings/accounts/used-by.ts` (pure).
- Tasks 3/4 produce `IntegrationCard` in `views/settings/integrations/integration-card.tsx`:
  props `{ mark: ReactNode; name: string; status: ReactNode; purpose: string; withoutIt: string; focusName: string;
  children /* actions */ }`, laying out spec §7's four parts. Task 3 creates it (it lands first in the Integrations
  section); Task 4 consumes it. If Task 4 starts first, it creates the same props and Task 3 merges onto it.

---

### Task 1: Settings layout — one scope at a time, subheads, Planning, renames (desktop only)

Spec §4, §9 (links mechanism), §9b access. Rung: rendered components (`renderWithDaemon`/`renderApp`) plus pure
tests on `sections.ts`.

**Files:** modify `views/settings/sections.ts`, `sections.test.ts`, `settings-nav.tsx`, `section-body.tsx`,
`settings-view.tsx`, `planned-section.tsx`, `project-trust-section.tsx`, `trust-section.tsx`, `role-settings.tsx`
(scope line only); create `focus-target.ts` (+ test), `connection-status.tsx`, `planning-section.tsx`;
`router.tsx` (validate `focus` search param with zod); `shell/app-layout.tsx` only if Settings' entry needs the
Overview key.

- [ ] Table test in `sections.test.ts`: every section's `scope` and `subhead` and order exactly as spec §4.2
  (rows: Overview first in app scope with no subhead; General, Board columns under Project; Planning, Areas and
  hazards, Who Answers under Planning; Billing, Models by role, Trust, Network hosts under Agents; Accounts,
  Models and benchmarks, Decisions, Models by role under Models; Lane permissions, Trust under Agents;
  Integrations, People under Connections; Updates, Keep-awake under This Mac). `firstAppSection()` is Overview.
  `SettingsSectionKey.Overview = 'overview'`, `SettingsSectionKey.Planning = 'planning'`. Keys `team` and
  `personas-and-flows` keep their values (links stay valid); labels become "Models by role". Run, see red.
- [ ] Implement `sections.ts`: replace `group` with `scope: SettingsScope` and `subhead: string | null`; rename
  `firstGlobalSection` to `firstAppSection`.
- [ ] Render test `settings-nav.test.tsx`: the `SegmentedControl` ("This project" / "All projects") selects the
  scope of the current section; choosing the other navigates to General / Overview; only that scope's links render,
  each subhead labels a `role="group"`; at app scope there is no project switcher. Red, then implement.
- [ ] `planned` texts (spec §4.3): Team → "Not built yet: which persona runs each role, and the project's human
  members."; Personas and flows → "Not built yet: personas, their instructions and pins, and the flows of steps."
  `PlannedRemainder` prints the text as is (no "Still to come:" prefix). Extend the existing planned test.
- [ ] Planning section: `planning-section.tsx` renders the description "How Plan treats this project's work before
  a lane starts it." then `ShapeJevSetting`, `OneWayPathsSetting`, `SmallProposalLimitSetting`; General renders
  only `ProjectGeneralForm`. Move the existing tests' render target; keep their assertions. The Jev opt-in copy
  and its disabled state come in Task 2 (it needs Runs on).
- [ ] Scope lines (spec §4.2): Project Trust "For Renewals only. Anything set to As app follows All projects ›
  Trust." (project name interpolated); app Trust "For every project. A project can override this in its own
  Trust."; project Models by role "For Renewals only. Use global follows All projects › Models by role."; app
  Models by role "For every project. A project can override this in its own Models by role." One render test row
  each.
- [ ] Project Trust: "Comes along" and "Left out" start collapsed: a line "<n> items" (or "1 item") and a
  Show/Hide button (`aria-expanded`). Test: collapsed by default, Show reveals the list.
- [ ] `focus-target.ts`: `useFocusTarget(name)`; pure test of the param parse (unknown → no-op) and a render test
  that `?focus=x` focuses the element. Overview page is a placeholder `OverviewSection` showing only its title in
  this task (Task 5 fills it).
- [ ] `connection-status.tsx` with one render test per tone (teal/yellow/gray via theme tokens, words present, dot
  `aria-hidden`).
- [ ] Check at 1280×720 in the QA app (`.dev/run-qa.sh`, ports 4427/1530 only) that both scopes' nav fits.
- [ ] Commit per behavior: `feat(desktop): …`.

### Task 2: OpenRouter is an account; decisions run on one

Spec §6, §8.1, §4.4 (Jev copy). Risk: storage and secrets — small red-first steps, one commit per behavior, full
review.

**Files:** contracts `accounts.ts`, `judge.ts` (+ tests, regenerate generated schemas); db `store/accounts.ts`,
`store/judge-config.ts` (+ tests); daemon `accounts/service.ts`, every exhaustive switch the type change breaks
(researcher list: `shape/agent-models.ts`, `screens/picture-limits.ts`, `sessions/account-check.ts`,
`sessions/fake-adapter.ts`, `sessions/native-judge.ts`, `catalogue/account-offer.ts`, `environment/launch.ts`),
`daemon/judge-services.ts`, `daemon/start.ts` (judge `readKey`, key move), new `accounts/openrouter-key-move.ts`,
`api/app.ts`; desktop `accounts/*` (kind label, add modal, fields, secret form, drawer Test, used-by), `account-
select.tsx`, `project-billing.tsx`, `decisions-section.tsx`, `shape-jev-setting.tsx`, `daemon/judge-*.ts` hooks.

- [ ] Contracts table tests: `runsAgents` per kind; `needsSecret('openrouter')`; `AccountInput` parses
  `{kind:'openrouter',label,payer}` and rejects extra fields; `JudgeConfig` default has `accountId: null`;
  `JudgeConfigPatch` accepts `accountId`. Red, implement, regenerate schemas.
- [ ] db (real SQLite): creating an OpenRouter account stores `secretRef = account:<id>`; projects refuse it:
  `patchProject`/create with an OpenRouter `accountId` or `fallbackAccountId` throws `InvalidError`
  (`OPENROUTER_CANT_RUN_AGENTS`); it can't become the default. Put the refusal in the store (the one writer) so
  every route inherits it.
- [ ] Daemon judge: `readKey` reads the secret of `judge.accountId` through the same fingerprint check as
  `launch.ts`'s `secretOf` (extract a shared `readAccountSecret(account, keychain)` in `environment/` if launch's is
  private); null account, archived, wrong kind, missing or changed secret → null (`no_key`). Tests with
  `keychainWith(exec)`. `JudgeStatusDto.account` filled; `PUT/DELETE /judge/key` and `POST /judge/test` removed;
  `POST /accounts/:id/test` added (404 unknown, 400 not OpenRouter, 409 when judge off).
- [ ] Key move `moveOpenRouterKey({ db, keychain, now })` in `accounts/openrouter-key-move.ts`, called once in
  `start.ts` only when judge is on. Rows (real SQLite + `keychainWith` fake exec): old item and no OpenRouter
  account → account "OpenRouter" created, secret written and read back, fingerprint recorded, `judge.accountId`
  set, old item removed; old item absent → nothing; an OpenRouter account exists → old item left alone, nothing
  created; write fails → no account left behind (one transaction for the row, Keychain write before commit, row
  rolled back on failure), old item kept; crash after the account and before removal (simulate: account exists
  with the same fingerprint as the old item) → old item removed, no second account; judge off → no Keychain
  read at all (assert the fake saw no call).
- [ ] Desktop: Add Account offers "OpenRouter key" (label + key, "Run decisions on this account" checkbox,
  default on only when `judge.config.accountId` is null; on submit, PATCH `/judge` with the new id). Account drawer
  shows Test with spec §9a's states. Kind label "OpenRouter key". `accountUsedBy` pure table test (projects'
  account and backup, "decisions", "Used by nothing"); row and drawer show it, and "Can't run agents yet" for
  OpenRouter. `AccountSelect` lists OpenRouter accounts disabled with that reason (Billing). Decisions: key row and
  Test gone; "Runs on" select (OpenRouter accounts enabled; others disabled "Decisions run on OpenRouter for now")
  with `ConnectionStatus`, empty state "No account can run decisions yet." + Add OpenRouter Account (opens Add
  Account with the kind chosen), `useFocusTarget('runs-on')`. Jev opt-in copy per spec §4.4 and disabled with
  "Pick an account for decisions first" + link when `accountId` is null. Render tests per state.
- [ ] Accounts "This month" for OpenRouter: dollars summed from `judge_calls` this month for that account if the
  call log records cost per call (it does: `costUsd`); otherwise "—". One db test.

### Task 3: Integrations › Artificial Analysis, and the card layout

Spec §7 (header, four parts, brand marks), §7.2, §7.3. Rung: real HTTP via `app.request()` with `keychainWith`,
render tests.

**Files:** contracts `benchmarks.ts`; daemon `benchmarks/` (sync's key read stays; add `setKey/removeKey` service in
`daemon/benchmark-services.ts`), `main.ts`/`start.ts` wiring of `keychain` and the off switch, `api/app.ts`;
desktop `integrations/integration-card.tsx`, `integrations/aa-card.tsx`, `integrations/slack-card.tsx` (re-laid on
`IntegrationCard`), `integrations-section.tsx`, `daemon/benchmark-queries.ts` (or the existing hooks file).

- [ ] Routes: `PUT /benchmarks/key` writes `artificial-analysis-api-key`, starts a sync, returns status with
  `keyConfigured: true`; `DELETE` removes it, returns `keyConfigured: false`; with `TENDB_BENCHMARKS=off` both 409
  "Started with TENDB_BENCHMARKS=off" and no Keychain call; a Keychain refusal → 409. `GET /benchmarks/status`
  reads `keyConfigured` live (Keychain `readAsync`; false when off). Red first, each row.
- [ ] Verify what routing does with no scores (read `apps/daemon/src/routing/`), write the true "Without it" line
  into the card and into spec §7.3 (replace "The plan checks…").
- [ ] `IntegrationCard` (interfaces above) and the section description "Outside services 10db uses that aren't
  models. Model access is in Accounts." Cards in order GitHub (placeholder slot until Task 4 merges), Slack, AA.
- [ ] Slack card on `IntegrationCard`: state line from today's connected text, `ConnectionStatus` tones (connected
  → works, refused/unreachable/none → needs you, off → off "Off: 10db was started with TENDB_SLACK=off"); For and
  Without lines per spec §7.2 (check the "Without it" line against the stakeholder code, fix the spec line). Keep
  every existing Slack test green.
- [ ] AA card: states per spec §9a; mark `IconGauge`; `ArtificialAnalysisCredit` in the card; `useFocusTarget
  ('artificial-analysis')`. Render tests per state through the real route.
- [ ] README: AA key instructions point at Settings › Integrations.

### Task 4: Integrations › GitHub, with Sign In

Spec §7.1, §9a. Risk: a child process and a one-at-a-time slot — red-first per behavior; state × event table
below is the test table.

**Files:** contracts `github.ts`, `sign-in-url.ts`, `events` (new event type); daemon `github/login.ts` (spawn +
parse), `daemon/github-services.ts`, `start.ts` wiring (reuse `resolveGh`, `delivery.gh.authLogin`, the system
check's `signedIn`), `api/app.ts`; desktop `integrations/github-card.tsx`, `daemon/github-queries.ts`,
`daemon/events.ts` (cache write on `github.login_ended`), `first-run/tool-rows.ts` + its row component.

Sign-in states × events (each cell a test row in `github/login.test.ts` with a fake child):

| State \ Event | POST signin | gh prints code+URL | gh exits 0 | gh exits ≠0 | DELETE signin | 10 min | daemon stop |
|---|---|---|---|---|---|---|---|
| idle | spawn; wait ≤ 5 s for code → 200 `{code,url}`; no code in 5 s → kill, 502 "gh didn't print a code" | — | — | — | 204 no-op | — | — |
| waiting | 409 | (already returned) | emit ended ok, login from `authLogin`; idle | emit ended !ok, gh's last stderr line; idle | kill; emit cancelled; idle | kill; emit !ok "Sign-in timed out"; idle | kill |

- [ ] `parseDeviceLogin(lines: readonly string[]): { code, url } | null` pure table: code line and URL line in
  either order, split across chunks, on stdout or stderr, `\r\n`, ANSI colour codes, and gh's exact 2.83.2 text
  ("! First copy your one-time code: ABCD-1234" / "Open this URL to continue in your web browser:
  https://github.com/login/device"). URL must pass `isSignInUrl`.
- [ ] `startGithubLogin` spawns `gh auth login --web --hostname github.com --git-protocol https --skip-ssh-key`
  with stdin closed and `BROWSER` unset-or-ignored (the app opens the page), env from the daemon's login env.
  The fake child is a boundary mock (a child process 10db doesn't own). One test with a real `gh` is not
  required (it would sign in for real).
- [ ] Routes and `GithubStatusDto` (state from `resolveGh` + `authLogin`; offline → `unreachable`, never
  `signed_out`; probed on request and `?recheck=1`, cached between). `TENDB_*`: there is no GitHub switch;
  `off` is unused unless `start.ts` has a delivery-off option — check, and drop the state from the union if not.
- [ ] GitHub card on `IntegrationCard` with spec §7.1 copy and §9a states; Copy button for the code (monospace,
  `xl`); `aria-live="polite"` around the code and waiting line; opens the URL with the same opener Connect uses;
  Switch Account (runs the same Sign In), Check Again; `useFocusTarget('github')`. Render tests per state.
- [ ] First run's gh row: "Not signed in" and a Sign In that runs the same flow inline; no command text.

### Task 5: Overview, and links instead of terminal instructions

Spec §5, §9, §10. Depends on Tasks 1–4 merged. Rung: render tests through `renderApp`; daemon card copy as table
rows in the existing `delivery/cards.test.ts` and self-update tests.

- [ ] `OverviewSection`: the summary line (spec §5), three groups as bordered `SettingRow`-style lists, rows from
  the existing queries, each row a link with `?focus=`; skeleton and "Couldn't read this · Retry" per row; needs-you
  first within each group; off rows not counted. Data rows: models.dev (`/models/status`), Claude Code and Codex
  (`/system` agents), self-update (`/settings/self-update`). Render test per tone and the summary's count.
- [ ] Daemon copy (table rows): every "Run gh auth login in a terminal" in `delivery/cards.ts`, `self-update.ts`
  and `github/gh.ts` error text becomes "Sign in to GitHub in Settings › Integrations." Inbox `benchmark-key` body
  "Replace the key in Settings › Integrations." with an Open Integrations button (`?focus=artificial-analysis`);
  `slack-refused` gets the button (`?focus=slack`); lane cards whose text names Integrations link there. The
  first-run row's terminal text is gone (Task 4).
- [ ] #587 follow-ups: People's daily limit integer-only (contract `z.int()` + `NumberInput allowDecimal={false}`);
  removing a person asks "Remove <name>? Their open questions go to the Inbox." (check the true consequence in the
  stakeholder code and word it so); Who Answers' judge-off line per stakeholder spec §10.4.

### Task 6: Models status line, docs, e2e

- [ ] After #588 merges (merge `origin/main` into the branch first: `GIT_EDITOR=true git merge --continue` on
  conflicts): Models page line "Scores from Artificial Analysis · synced 2 h ago · Manage" / "No Artificial Analysis
  key: models are compared without scores · Add Key", linking `?focus=artificial-analysis`. If #588 hasn't merged
  when everything else is done, build it on main's Models page and resolve against #588 later.
- [ ] Docs (spec §11): decision file `docs/architecture/decisions/2026-11-12-settings-sort-by-what-the-credential-is.md`
  (amends `2026-10-31-openrouter-makes-routine-decisions.md` and decision 65; records the one-scope sidebar, teal
  for connection status, no notices); accounts spec, stakeholder spec §10.1, `DESIGN.md` (sidebar line; teal for
  connection status beside the green rule), `apps/desktop/AGENTS.md` / `apps/daemon/AGENTS.md` where they name the
  routes or sections moved.
- [ ] e2e (`apps/desktop/e2e/settings.spec.ts`, against the real daemon): the scope switch and subheads; Overview
  shows a row per account and service; Integrations shows three cards; Decisions shows Runs on's empty state; an
  axe check on Overview and Integrations (`expect-accessible.ts`).

---

## Amendments after plan review (round 1). These override the tasks above where they differ.

### Per provider (root AGENTS.md, provider parity)

Settings layout, Integrations and Overview behave the same on every account kind. Decisions run on the judge's
own account (OpenRouter) whatever kind a project's agents use (spec §6.3). Two gaps are stated in the UI and filed
as follow-up tasks in Task 6: "OpenRouter can't run agents yet", and "Decisions run on OpenRouter for now" (no
decisions on a Claude plan, an API key, Bedrock or a ChatGPT plan).

### Task 2 (pinned)

- **judge config merge.** `store/judge-config.ts` merges `accountId: patch.accountId === undefined ?
  current.accountId : patch.accountId`; real-SQLite rows "a patch without accountId keeps it", "null clears it";
  the store refuses (InvalidError, 400) an id that is unknown, archived or not `openrouter`. `GET /judge` with an id
  that no longer resolves gives `account: null`.
- **`moveOpenRouterKey(deps: { state: StateStore; keychain: Keychain })` never throws.** It catches everything,
  logs by error name only, and start continues. Order, pinned:
  1. read the old item (throws → log, stop; nothing created, old item kept);
  2. absent → stop;
  3. if any OpenRouter account (archived or not) has a fingerprint equal to the old item's → remove the old item
     (remove throws → log; next start retries), stop;
  4. else if any unarchived OpenRouter account exists → leave everything, stop;
  5. else create the account with the first free label of "OpenRouter", "OpenRouter key", "OpenRouter 2", "OpenRouter
     3"…, write `account:<id>`, read back, record the fingerprint, set `judge.accountId` if it is null — the row
     and the judge setting in one `state.write`, rolled back if the Keychain write or read-back fails; then remove
     the old item (throws → log; step 3 finishes it next start).
  Rows for each step, plus "label taken". The judge-off row goes **through `startDaemon`** with a recording
  keychain (pattern: `apps/daemon/test/judge-api.test.ts:111`) and also exercises a list refresh and the identity
  route on an OpenRouter account, asserting zero Keychain calls.
- **Every kind check, with what `openrouter` does** (replaces the "researcher list"; the implementer greps for
  `SUPPORTED_ACCOUNT_KINDS`, `providerOf`, `AccountKind.` comparisons and fixes each):
  - `environment/launch.ts` `build`: throws a typed `AccountLaunchError` for openrouter **before any Keychain read**;
    its Claude/Codex ternaries (l.141, 169, 209) narrow with `runsAgents` first.
  - `accounts/list-refresh.ts:98`, `catalogue/profiles.ts:62`, `team/routing-inputs.ts:17`, `accounts/moves.ts:89`
    (`moveTargets`), `sessions/routed-adapter.ts`, `daemon/area-namer.ts`, `accounts/cards.ts:52`,
    `AccountExpectation.kind`: filter or narrow with `runsAgents`; openrouter is never a move target, a probe, a
    profile or a routing input.
  - `GET /accounts/:id/identity` for openrouter: 400 "OpenRouter accounts have no identity to check", no probe.
  - `insertAccount`: openrouter gets `configDir: null`, `laneCap: 0` (column is NOT NULL), `monthlyCapUsd: null`;
    `AccountService.create` makes no config directory for it.
  - `parseAccountSettings`/`AccountSettings` include `OpenRouterSettings`; `AccountInput`'s error text lists it.
- **Test reads that account's key.** `JudgeService.test(account)` reads the given account's own secret through the
  shared check; a two-account HTTP row fails if the wrong `authorization` header is sent.
- **Shared secret read.** Extract the fingerprint check from `launch.ts`'s `secretOf` into one function used by
  launch (sync `read`) and the judge (async `readAsync`). `JudgeStatusDto.account` gains `secretState: 'set' |
  'missing' | 'changed'` (from `readAsync` + fingerprint when the judge is on; from the fingerprint only when off).
- **Desktop.** `AccountSelect` takes `isDisabled(account): string | null` (the reason); Billing and project setup
  (`views/project-setup/project-setup.tsx:229`, and its `accounts[0]` fallback skips OpenRouter) pass the
  can't-run-agents rule, Runs on passes the opposite. The drawer hides `IdentityCheck`, `UsageByProject`, lane cap
  and `TierOverrides` for openrouter; `account-form-values.ts` sends only `{kind,label,payer}` for it. Add Account's
  order: `POST /accounts`, then `PUT /accounts/:id/secret` through `daemon/account-secret.ts` (field cleared before
  the await, as `decisions-section.tsx:245`), then `PATCH /judge` if the checkbox is on; a failed secret step shows
  its error beside the submit and leaves the account (drawer opens on it to retry). Accounts reads `?focus=<account
  id>` and opens that drawer (render row through the real route). `who-answers-section.tsx:24` uses
  `account?.secretState === 'set'` for "judge on". Account rows show brand marks: `IconBrandOpenai` (Codex plan),
  `IconBrandAws` (Bedrock), `IconKey` (API key, gateway, OpenRouter), the existing icon for a Claude plan.
- **This month** for OpenRouter (no migration): the account decisions run on shows this month's decision dollars from
  `judge_calls` (30-day retention noted in a comment); other OpenRouter accounts show "—".

### Task 3 (pinned)

- `BenchmarkStatusDto` gains `off: boolean`. Off: the card says "Off: 10db was started with TENDB_BENCHMARKS=off",
  gray, no actions; Overview's row is gray. Render row for it.
- Task 3 lands `integration-card.tsx` in its own first commit; Tasks 4 and 5 cherry-pick that commit if they need it
  before the merge (identical changes merge cleanly).

### Task 4 (pinned)

- `GithubState` has no `Off` (no switch exists): `'not_installed' | 'signed_out' | 'signed_in' | 'unreachable'`.
- `GithubStatusDto` gains `signingIn: { code: string; url: string; startedAt: Timestamp } | null`; the card and the
  first-run row restore the waiting state from it (render row "mounted while a sign-in runs shows the code and
  Cancel").
- Add a `starting` state (spawned, no code yet; the slot is taken at spawn):
  | starting | POST → 409 | → waiting; POST answers 200 | re-read `authLogin`; POST answers 409 "Already signed in" | POST answers 502 with gh's message, mapped and bounded | kill; POST answers 409 "Cancelled" | (5 s) kill; 502 "gh didn't print a code" | kill |
- On gh's exit the daemon re-reads `authLogin` and updates its cached status **before** emitting
  `github.login_ended`. `GET /github` without `recheck` returns the cached status, probing if it is older than 60 s.
- `?recheck=1` and `POST /github/signin` call `resolveGh()` again; the gh exec reads the current path through a
  getter (row: not installed → installed → recheck reads signed_out/signed_in).
- gh's messages reaching an event or a response are mapped to known ones where gh's text is known, otherwise the
  last stderr line stripped of ANSI codes and cut to 200 characters (`GithubLoginEndedData.message` never holds
  more).
- The 5 s and 10 min timers use the injected `Clock`; no sleeps in tests.
- `isSignInUrl` accepts github.com only with path `/login/device`.

### Task 5 (added)

- The summary line's names link to and focus their rows; a "Couldn't read this" row counts as needing the builder.

### Task 6 (added)

- `docs/architecture/03-trust-boundaries.md`: replace `openrouter-api-key` / `PUT /judge/key` (l.62, 797) with the
  account secret; add the AA key route and the gh login spawn.
- File the two provider-parity follow-up tasks in 10db (skill `10db-task`) and name them in the PR.
- `/design-review` on the running app checks dark and light.

### Review focus #2, reworded

A project PATCH or project create naming an OpenRouter account (as account or backup) is refused with "OpenRouter
can't run agents yet" (no route sets the default account; `seedDefaultAccount` makes a Claude plan).
