# A Project Can Run on a ChatGPT Plan: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** A `codex_signin` account is one more 10db account: a project on it runs its lanes through `codex app-server`
on the ChatGPT plan, and moves, fallback, handoffs, cards, pauses and model configuration work as they do today.

**Architecture:** A second `SessionAdapter` (`createCodexAdapter`) runs one `codex app-server` per session over stdio
JSON-RPC, in a Codex home 10db writes for each account. A routing adapter picks it by account kind, so the runner keeps
calling one adapter. Routing stays on Claude aliases; the account's Model map turns them into Codex model IDs. The
guard runs from a Codex `PreToolUse` hook that asks the adapter over a Unix socket.

**Tech Stack:** TypeScript, zod, smol-toml (already a daemon dependency), `node:child_process`, `node:http` over a Unix
socket, Vitest, React and Mantine for the desktop, Codex 0.154.0.

**Spec:** `docs/superpowers/specs/2026-11-05-10db-chatgpt-plan-design.md` (read it in full).

## Global Constraints

- Root `AGENTS.md`, the `AGENTS.md` of each package touched, `.claude/rules/code-style.md`, `.claude/rules/testing.md`.
- Add no product rule the spec doesn't state. Moves, the fallback, limit cards, pauses, routing, role defaults and
  persona pins don't change. When a task seems to need a new rule, stop and ask.
- Work on `feat/chatgpt-plan`, tasks in order. Name every path in each commit. Commit messages are Conventional
  Commits ending with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- Verified Codex version: `0.154.0`.
- zod validates everything from the app-server, the hook and `config.toml`.
- Never print, log, store or return `auth.json` contents, an account's email in a log line, or the MCP token.
- Per-lane values travel in `thread/start`'s `config` over stdin, never on a command line.
- A sandbox test on the real binary uses a checkout outside `/tmp`. Under `/tmp` Codex gave false results in the spike.
- `FakeAdapter` stays Claude-shaped.

## Review Focus

1. **A ChatGPT account whose Model map is empty or lacks an alias.** The lane fails with a message naming the Model map,
   not a raw Codex error, and the account isn't paused. Test in Task 6.
2. **The default data directory has a space** (`~/Library/Application Support/10db`). The hook command, the sign-in
   command and every home path must survive it. Tests in Tasks 3 and 11.
3. **A login that expires mid-lane.** `unauthorized` pauses the account with a card naming `codex login`, not
   `claude /login`, and Resume retries. Tests in Tasks 4 and 7.
4. **A fallback that fires during a Codex turn, in either direction.** The handoff nudge lands as `turn/steer`, and the
   next session runs on the other account with the briefing for that account's kind and the step's alias mapped. Tests
   in Tasks 7, 10 and 11.
5. **A daemon that died with a session open.** A stale socket file at the session's path doesn't stop the next bind,
   and resume finds the thread. Tests in Tasks 6 and 8.

---

### Task 1: Prove it on the real account

Travis signs in, so this task runs in the main session, not a subagent. One turn at low effort is the only spend.

**Files:**

- Create: `scratch/spike-2026-11-05-codex-app-server/fake-model/real-proof.mjs` (gitignored, in the main checkout)
- Create: `docs/architecture/research/spike-16-codex-app-server.md`
- Modify: `docs/architecture/research/spikes-summary.md`
- Modify: `tests/repo/src/architecture-docs.test.ts` (`PUBLIC_RESEARCH`, the allowlist of research notes)

**Interfaces:** Produces the real window sizes and `credits` shape that Task 7 maps.

- [ ] **Step 1: Write `real-proof.mjs`** from the spike's `strict.mjs`, with no fake provider. Home `~/.10db/codex-proof`,
      `HOME` set to an empty folder in it, a `PreToolUse` hook that logs `tool_name` and denies a call naming `DENYME`,
      trusted through `hooks/list`'s `currentHash`.
      It prints `account/read`'s `type` and `planType` (never `email`), `model/list`'s IDs, and from
      `account/rateLimits/read` each window's `usedPercent`, `windowDurationMins` and `resetsAt`, plus whether `credits`
      is set and non-zero. Then one turn: model `gpt-5.6-sol`, effort `low`, prompt "Run `echo one`, then run
      `echo DENYME`, then reply done."

- [ ] **Step 2: Travis signs in.** Ask him to run `! CODEX_HOME=~/.10db/codex-proof codex login` and wait.

- [ ] **Step 3: Run it.**

Run: `node scratch/spike-2026-11-05-codex-app-server/fake-model/real-proof.mjs` from the main checkout.
Expected: `chatgpt`, a `pro` plan, hook logged for both commands, `echo DENYME` refused, turn `completed`.

- [ ] **Step 4: Stop if it failed, or if `credits` shows a balance.** Tell Travis what happened. Change nothing else.

- [ ] **Step 5: Write `spike-16-codex-app-server.md`** from `FINDINGS.md` and these results (no email, no AA data), add
      a row to `spikes-summary.md`, and add the note to `PUBLIC_RESEARCH`.

- [ ] **Step 6: Run the docs tests.**

Run: `pnpm --filter ./tests/repo exec vitest run src/architecture-docs.test.ts src/agent-docs.test.ts`
Expected: PASS

- [ ] **Step 7: Commit** `docs: record the Codex app-server spike`, naming all three files.

---

### Task 2: A `codex_signin` account exists

**Files:**

- Modify: `packages/contracts/src/states.ts:45`, `packages/contracts/src/accounts.ts`, `packages/contracts/generated/*`
  (generated)
- Modify: `apps/daemon/src/environment/launch.ts`, `apps/daemon/src/environment/index.ts`
- Modify: `apps/daemon/src/sessions/account-check.ts`, `apps/daemon/src/sessions/fake-adapter.ts:51`
- Modify: `apps/daemon/src/accounts/readiness.ts:6`
- Modify: `apps/daemon/src/routing/role-defaults.ts:25`, `apps/daemon/src/routing/plan-steps.ts:76` (drop the
  `no-unnecessary-condition` disables, now unneeded)
- Modify: `apps/desktop/src/views/settings/account-kind-label.ts`,
  `apps/desktop/src/views/settings/accounts/account-form-values.ts`,
  `apps/desktop/src/views/settings/accounts/secret-form.tsx`
- Test: `packages/contracts/src/accounts.test.ts`, `apps/daemon/src/environment/launch.test.ts`,
  `apps/daemon/src/sessions/account-check.test.ts`

**Interfaces:**

- Produces in `@10db/contracts`: `Provider.Codex = 'codex'`; `providerOf(kind: SupportedAccountKind): Provider`;
  `signsInWithLogin(kind: SupportedAccountKind): boolean` (Claude subscription, Codex sign-in).
- Produces in `environment`: `codexSignInCommand(home: string): string`;
  `signInCommandFor(account: { kind: SupportedAccountKind; configDir: string | null }): string`;
  `sessionConfigDir(kind: SupportedAccountKind, env: Readonly<Record<string, string>>, home: string): string`.
- Produces in `sessions`: a `SeenAccount` with `apiProvider: 'chatgpt'` means a ChatGPT sign-in, and its `organization`
  holds the workspace ID. A ChatGPT account's identity is `codexIdentity(email: string, workspace: string): string`,
  which is `${email} · ${workspace}`.

- [ ] **Step 1: Write the failing tests.**

```ts
// accounts.test.ts
it.each([
  ['claude_subscription', 'claude'],
  ['bedrock', 'claude'],
  ['codex_signin', 'codex'],
])('%s runs on %s', (kind, provider) => expect(providerOf(kind)).toBe(provider));
it('takes a codex_signin account and still refuses openai_api_key', ...);

// launch.test.ts, on an account with configDir '/d/acc/codex' and modelMap { sonnet: 'gpt-5.6-sol' }
const { env, model } = launcher.session(codexAccount, 'sonnet');
expect(model).toBe('gpt-5.6-sol');
expect(env['CODEX_HOME']).toBe('/d/acc/codex');
expect(env).not.toHaveProperty('CLAUDE_CONFIG_DIR');
for (const name of ['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN'])
  expect(env).not.toHaveProperty(name);
expect(launcher.projectEnv()).toHaveProperty('OPENAI_API_KEY'); // the shared env keeps it
expect(codexSignInCommand('/a b/codex')).toBe("CODEX_HOME='/a b/codex' codex login");

// account-check.test.ts, table on checkAccount with kind codex_signin and identity 'a@b.c · w1'
// chatgpt, plan, a@b.c, workspace w1 -> null
// chatgpt, plan, a@b.c, workspace w2 -> IdentityMismatch, seenIdentity 'a@b.c · w2' (same email, another workspace)
// chatgpt, plan, other email, w1 -> IdentityMismatch with seenIdentity
// chatgpt, plan, a@b.c, no workspace reported -> IdentityMismatch, seenIdentity 'a@b.c'
// apiKey -> WrongCredentials; nothing reported -> SignedOut
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/contracts exec vitest run src/accounts.test.ts && pnpm --filter @10db/daemon exec vitest run src/environment/launch.test.ts src/sessions/account-check.test.ts`
Expected: FAIL, `providerOf` undefined.

- [ ] **Step 3: Implement.**
  - Contracts: add `CodexSignin` to `SUPPORTED_ACCOUNT_KINDS`, `SETTINGS_BY_KIND` (`SubscriptionSettings`), `AccountInput`
    (`...common`, `settings: SubscriptionSettings.default({})`) and `needsSecret` (false). Update the kind comment and
    the union's error text, which keeps refusing `openai_api_key`.
  - `launch.ts`: for this kind, filter `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN` and
    `CODEX_HOME` from the login env, set `CODEX_HOME` from `configDir`, and leave `CLAUDE_CONFIG_DIR` unset. Add the
    `AccountKind.CodexSignin` case to `build()`. `sessionConfigDir` reads `CODEX_HOME` only for a Codex kind; a Claude kind
    reads `CLAUDE_CONFIG_DIR`, else `<home>/.claude`, whatever the login shell exports.
  - `account-check.ts`: `NEEDS` entry "a ChatGPT sign-in"; `credentialsMatch` is
    `seen.apiProvider === 'chatgpt' && Boolean(seen.subscriptionType)`; lines 89, 108 and 129 use `signsInWithLogin`.
    Every message in this file names the tool by kind ("Codex", `codex login status`), so a ChatGPT card never says
    "Claude Code" or `claude auth status`. `modelMatches` is unchanged. In `checkAccount`, a `codex_signin` account's
    `reported` is `codexIdentity(seen.email, seen.organization)`, or the email alone when no workspace was reported, so
    the existing Confirm and mismatch cards carry the workspace with no new field.
  - `readiness.ts:6` uses `signsInWithLogin`. `store/accounts.ts:158` stays Claude-only, since this identity isn't a bare
    email.
  - `fake-adapter.ts:51`, in `expectedSeen`: `{ ...NOTHING_SEEN, email: expect.identity ?? FAKE_ACCOUNT_EMAIL,
    subscriptionType: 'pro', apiProvider: 'chatgpt' }`.
  - Desktop: the label "ChatGPT plan", `settingsOf` returns `choice`, `secretLabel` returns `Secret`.

- [ ] **Step 4: Run them to see them pass, regenerate, and check the rest.**

Run: `pnpm --filter @10db/contracts generate && pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/db exec vitest run src/store && pnpm --filter @10db/daemon exec vitest run src/environment src/sessions src/accounts && pnpm --filter @10db/db typecheck && pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(contracts): add the codex_signin account kind`, naming every path above.

---

### Task 3: The RPC client and the Codex home

**Files:**

- Create: `apps/daemon/src/sessions/codex-protocol.ts`, `codex-rpc.ts`, `codex-home.ts`, `codex-test-support.ts`
- Test: `apps/daemon/src/sessions/codex-rpc.test.ts`, `codex-home.test.ts`

**Interfaces:**

- Produces in `codex-protocol.ts`: zod schemas for what 10db reads, loose beyond the fields named:
  `InitializeResponse`, `AccountReadResponse`, `ModelListResponse`, `ConfigReadResponse`, `HooksListResponse`,
  `ThreadResponse` (`thread.id`, `model`, `activePermissionProfile`), `TurnStartResponse`, `TokenUsageUpdated`,
  `RateLimitsUpdated`, `TurnCompleted`, `ItemCompleted`, `RateLimitsReadResponse`.
- Produces in `codex-rpc.ts`:

```ts
export interface CodexChild {
  readonly pid: number | undefined;
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  kill(): boolean;
  once(event: 'exit', listener: (code: number | null) => void): unknown;
}
export type CodexSpawn = (codexPath: string, env: Readonly<Record<string, string>>) => CodexChild;
export class CodexRpcError extends Error { /* name, code */ }
export interface CodexRpc {
  call<T>(method: string, params: unknown, schema: z.ZodType<T>): Promise<T>;
  notify(method: string, params?: unknown): void;
  onNotification(handler: (n: { method: string; params: unknown }) => void): void;
  readonly exited: Promise<{ readonly code: number | null; readonly stderr: string }>;
  close(): void;
}
export function createCodexRpc(child: CodexChild, log: Pick<Logger, 'warn'>): CodexRpc;
export const spawnAppServer: CodexSpawn; // ['app-server', '--stdio', '--strict-config']
```

- Produces in `codex-home.ts`:

```ts
/** Above the longest wait for a card: `humanWaitMinutes` is at most 240, plus the 5 of the tool timeout. */
export const CODEX_HOOK_TIMEOUT_SECONDS = 15_000;
export const GUARD_HOOK_EVENT = 'preToolUse';
export interface CodexHome {
  readonly path: string;
  /** The empty folder the child runs with as HOME. */
  readonly emptyHome: string;
  /** Writes config.toml and guard-hook.sh when they differ, and pins the checkout untrusted. */
  prepare(checkout: string): Promise<void>;
  /** Records the hash Codex reports for 10db's hook. */
  trustGuardHook(key: string, hash: string): Promise<void>;
}
export function codexHomes(): (path: string) => CodexHome; // one write queue per home
```

- Produces in `codex-test-support.ts`: `fakeAppServer(script): { child: CodexChild; spawn: CodexSpawn; sent(): Rpc[];
  notify(method, params): void; exit(code): void }`, answering requests from a method-to-result script.

- [ ] **Step 1: Write the failing tests.**

```ts
// codex-rpc.test.ts
it('matches answers to calls whatever order they arrive in', ...);
it('rejects with CodexRpcError on an error response', ...);
it('rejects a response its schema refuses', ...);
it('logs a line that is not JSON and keeps reading', ...);
it('refuses a server request with -32601 and carries on', ...);
it('rejects every open call when the child exits, with the end of its stderr', ...);

// codex-home.test.ts: real files, in a temp dir whose path has a space
const config = parse(readFileSync(join(home, 'config.toml'), 'utf8'));
expect(config).toMatchObject({
  forced_login_method: 'chatgpt',
  default_permissions: 'lane',
  allow_login_shell: false,
  web_search: 'disabled',
  features: { network_proxy: true, goals: false, memories: false, apps: false, plugins: false },
  agents: { enabled: false },
  skills: { include_instructions: false },
  shell_environment_policy: { inherit: 'none' },
});
expect(config.permissions.lane.filesystem).toEqual({ ':minimal': 'read' });
expect(config.hooks.PreToolUse[0].hooks[0]).toMatchObject({
  type: 'command', timeout: 15000, command: `/bin/sh '${home}/guard-hook.sh'`,
});
it('replaces a trusted entry Codex wrote with untrusted', ...);
it('keeps the projects entries of other checkouts', ...);
it('pins two checkouts prepared at once', ...);
it('keeps the trust hash when it rewrites the file', ...);
it('does not rewrite a file that already matches', ...); // the same inode, since a write renames over it
it('makes guard-hook.sh executable and the home mode 700', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-rpc.test.ts src/sessions/codex-home.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement.** One `readline` over stdout. `prepare` resolves the real path of the checkout, parses the
      existing file with smol-toml, overlays the template, keeps `projects` and `hooks.state`, and renames a temp file
      over `config.toml`. Writes for one home run in one promise chain. `guard-hook.sh` is exactly:

```sh
#!/bin/sh
# Codex runs the tool on every exit but 2, so each failure here refuses the call.
answer=$(/usr/bin/curl --silent --fail --max-time "$TENDB_GUARD_MAX_SECONDS" \
  --unix-socket "$TENDB_GUARD_SOCKET" --data-binary @- http://10db/pre-tool-use) || {
  echo '10db could not check this call, so it was refused.' >&2
  exit 2
}
printf '%s' "$answer"
```

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/daemon typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): add the Codex RPC client and the account's Codex home`.

---

### Task 4: Probing, routing and the account services

**Files:**

- Create: `apps/daemon/src/sessions/codex-adapter.ts`, `routed-adapter.ts`, `codex-sign-in-check.ts`
- Modify: `apps/daemon/src/sessions/types.ts`, `sessions/index.ts`, `sessions/account-check.ts`,
  `sessions/claude-adapter.ts`, `sessions/fake-adapter.ts`, `sessions/unavailable-adapter.ts`
- Modify: `apps/daemon/src/shape/service.ts:821`, `apps/daemon/src/main.ts`
- Modify: `apps/daemon/src/accounts/service.ts:108,165,237`, `accounts/preparer.ts:93,182,204`,
  `accounts/cards.ts:49,67,81,92,321`
- Modify: `apps/daemon/src/environment/system-check.ts`, `packages/contracts/src/system.ts`,
  `packages/contracts/src/accounts.ts` (`AccountIdentityDto.models`), `packages/contracts/generated/*`
- Test: `sessions/codex-adapter.test.ts`, `sessions/routed-adapter.test.ts`, `accounts/cards.test.ts`,
  `accounts/preparer.test.ts`, `accounts/service.test.ts`, `environment/system-check.test.ts`

**Interfaces:**

- Consumes: Task 2's `signsInWithLogin`, `signInCommandFor`, `providerOf`; Task 3's RPC and home.
- Produces in `types.ts`: `AccountProbeSpec` gains `readonly kind: SupportedAccountKind`. `SessionAdapter` loses
  `provider`; nothing reads it once `shape/service.ts:821` uses `providerOf(launch.account.kind)`.
- Produces in `account-check.ts`: `SeenAccount` gains `readonly models?: readonly string[]`.
- Produces:

```ts
export interface CodexAdapterOptions {
  readonly codexPath: string;
  readonly logger: Logger;
  readonly spawn?: CodexSpawn;
  readonly clock?: Clock;
  readonly stopGraceMs?: number;
  /** Where session sockets live; defaults to `~/.10db/run`, short enough for a socket path. */
  readonly socketDir?: string;
  readonly signInCheck?: SignInCheck;
}
export function createCodexAdapter(opts: CodexAdapterOptions): SessionAdapter;
export function createRoutedAdapter(adapters: {
  readonly claude: SessionAdapter;
  readonly codex: SessionAdapter;
}): SessionAdapter;
export function codexLoginStatus(codexPath: string, env: Readonly<Record<string, string | undefined>>):
  Promise<SignInState>;
```

- Produces in `environment`: `findCodex(): string | null`, which is `firstExecutable(installCandidates('codex'))`;
  `CODEX_VERIFIED_ON = '0.154.0'`;
  `codexWarning(version: string | null): string | null`. `ToolName.Codex`, `required: false`. `SystemCheckDto` gains
  `codex: { verifiedOn: string; warning: string | null }`.

- [ ] **Step 1: Write the failing tests.**

```ts
// codex-adapter.test.ts, on fakeAppServer
it('reads who the account is from account/read', ...);
// { type: 'chatgpt', email, planType: 'pro' } -> seen.apiProvider 'chatgpt', email, subscriptionType 'pro'
// account/rateLimits/read's accountId -> seen.organization
// models from model/list, leaving hidden models out
it('reports nothing for a signed-out home', ...); // account: null -> checkAccount says SignedOut
it('rejects with AccountProbeError when the app-server does not answer', ...);
it('rejects complete with a CompletionError', ...);

// routed-adapter.test.ts: table on account kind for start, startShape, complete and probeAccount
it.each(['claude_subscription', 'bedrock', 'gateway', 'anthropic_api_key'])('sends %s to Claude', ...);
it('sends codex_signin to Codex', ...);

// cards.test.ts
expect(fixFor(codexAccount, AccountProblem.SignedOut)).toContain(`codex login`);
expect(fixFor(codexAccount, AccountProblem.SignedOut)).not.toContain('claude');
expect(signInCard(codexAccount).body).toContain('codex login');

// system-check.test.ts
expect(codexWarning('codex-cli 0.154.0')).toBeNull();
expect(codexWarning('codex-cli 0.155.0')).toContain('0.154.0');
expect(codexWarning(null)).toBeNull();

// service.test.ts
it('gives a codex_signin account a home named codex, mode 700, and its sign-in steps', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-adapter.test.ts src/sessions/routed-adapter.test.ts src/accounts/cards.test.ts src/environment/system-check.test.ts`
Expected: FAIL, modules missing.

- [ ] **Step 3: Implement.**
  - `probeAccount` spawns with the probe's env, runs `initialize`, `initialized`, `account/read`,
    `account/rateLimits/read`, `model/list`, closes. A failed usage read leaves `organization` unset. A deadline of 30 s,
    as `AccountProbeError`. Log nothing from `account`.
  - `codexLoginStatus` mirrors `claudeAuthStatus`: `codex login status`, exit 0 `signed_in`, exit 1 with "Not logged in"
    `signed_out`, anything else `unknown`.
  - `start` and `startShape` return a handle that ends with `SessionEndReason.Error` for now; Task 6 replaces `start`.
    `startShape` keeps this, saying brainstorm chat isn't available on a ChatGPT account.
  - `main.ts`: `createRoutedAdapter({ claude, codex })`, with `createUnavailableAdapter` for whichever binary is missing,
    its message naming the tool. `TENDB_FAKE_SCRIPTS` still returns the fake alone.
  - `accounts/service.ts`: `configDirFor` picks `codex` from `input.kind`, which `create` has in scope, so the db
    signature doesn't change; `signInOf` uses `signsInWithLogin` and
    `signInCommandFor`; `identity` returns `models`. Callers pass `kind` to `probeAccount`.
  - `cards.ts`, `preparer.ts`: `signsInWithLogin`, `signInCommandFor`, and "Codex" for "Claude Code" in `fixFor`'s
    `WrongCredentials` and `StartTimeout` text for this kind.
  - The Claude start gate (`runner.ts:1507`, `service.ts:221`) stays Claude-only.

- [ ] **Step 4: Run them to see them pass, regenerate, and check the rest.**

Run: `pnpm --filter @10db/contracts generate && pnpm --filter @10db/daemon exec vitest run src/sessions src/accounts src/environment src/shape && pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/desktop typecheck`
Expected: PASS. `SystemCheckDto.codex` is required, so the desktop's system fixtures gain it in this task.

- [ ] **Step 5: Commit** `feat(daemon): probe a ChatGPT account and route sessions by account kind`.

---

### Task 5: Settings for a ChatGPT account

**Files:**

- Modify: `apps/desktop/src/views/settings/accounts/sign-in-steps.tsx`, `identity-check.tsx:24,73`,
  `account-drawer.tsx:41`, `account-status.ts:25`, `apps/desktop/src/shell/system-alert.tsx`
- Modify: `apps/desktop/src/test/account-fixtures.ts`
- Test: `apps/desktop/src/views/settings/accounts/accounts-section.test.tsx`,
  `apps/desktop/src/shell/system-alert.test.tsx`

**Interfaces:** Consumes `signsInWithLogin`, `AccountIdentityDto.models`, `SystemCheckDto.codex`.

- [ ] **Step 1: Write the failing tests** with MSW.

```tsx
it('adds a ChatGPT plan account and shows its sign-in command', ...); // the command from AccountCreatedDto
it('offers Confirm for the email the probe saw', ...);
it('lists the models the account offers beside the Model map', ...); // from identity.models
it('shows no dollars for a ChatGPT plan account', ...);
it('shows the Codex version warning', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/desktop exec vitest run src/views/settings/accounts src/shell/system-alert.test.tsx`
Expected: FAIL

- [ ] **Step 3: Implement.** Replace `AccountKind.ClaudeSubscription` with `signsInWithLogin(kind)` in those three
      account files, at all four places. `SignInSteps` shows the DTO's command, uses "Codex" for this kind, and adds:
      "Sign-in asks which workspace to use. Pick the one whose plan should pay for this account's work." `IdentityCheck` lists
      `models` when there are any. The Model map field is unchanged.

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/desktop typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(desktop): add and confirm a ChatGPT plan account`.

---

### Task 6: Starting a session

**Files:**

- Create: `apps/daemon/src/sessions/codex-session.ts`, `codex-lane-config.ts`
- Modify: `apps/daemon/src/sessions/codex-adapter.ts`
- Test: `apps/daemon/src/sessions/codex-session.test.ts`

**Interfaces:**

- Consumes: Task 3's `CodexRpc`, `CodexHome`; Task 4's options; `SessionSpec`, `SessionEndReason`.
- Produces in `codex-session.ts`:
  `startCodexSession(spec: SessionSpec, deps: CodexSessionDeps): SessionHandle`, where `CodexSessionDeps` is the adapter's
  options plus `homes`.
- Produces in `codex-lane-config.ts`: `codexThreadConfig(spec: SessionSpec): Record<string, unknown>`. This task fills
  `mcp_servers`; Task 9 adds `permissions` and `shell_environment_policy`.
  `10db` is `{ url: spec.mcp.url, bearer_token_env_var: 'TENDB_MCP_TOKEN', required: true,
  default_tools_approval_mode: 'approve', tool_timeout_sec: spec.mcp.toolTimeoutMs / 1000 }`; each of
  `spec.projectMcpServers` maps to Codex's `command`, `args` and `env`, or `url` and `http_headers`, with the same
  approval mode, since the guard judges those calls.

- [ ] **Step 1: Write the failing tests.** One table, one row per start check, on `fakeAppServer`.

```ts
it.each([
  ['the expected account is not reported', { 'account/read': otherEmail }, 'account_refused'],
  ['the same email is in another workspace', { 'account/rateLimits/read': otherWorkspace }, 'account_refused'],
  ['the account is signed out', { 'account/read': { account: null } }, 'account_refused'],
  ['the project layer is enabled', { 'config/read': projectLayerOn }, 'sandbox_refused'],
  ['the hook is missing', { 'hooks/list': noHooks }, 'sandbox_refused'],
  ['the hook is disabled', { 'hooks/list': disabledHook }, 'sandbox_refused'],
  ['the thread runs another profile', { 'thread/start': wideOpen }, 'sandbox_refused'],
])('refuses when %s, with no prompt sent', async (_name, overrides, reason) => {
  const events = await collect(startWith(overrides));
  expect(events.at(-1)).toMatchObject({ type: 'ended', reason });
  expect(server.sent().map((r) => r.method)).not.toContain('turn/start');
});
it('prepares the home before the process starts', ...);
it('trusts an untrusted hook once, and refuses if it stays untrusted', ...);
it('sends approvalPolicy never, the model, and effort on turn/start', ...);
it('refuses a session with no sandbox', ...);
it('emits started with the thread id and the pid, then turn/start', ...);
it('resumes with thread/resume and the same config', ...);
it('ends with error when resume fails, naming the thread', ...);
it('names the Model map for an alias with no map entry, spawning nothing', ...); // spec.model 'sonnet', reason 'error'
it('names the Model map when Codex refuses the model, and pauses nothing', ...); // reason 'error', no refusal
it('fails the session when the thread reports another model', ...);
it('runs with CODEX_HOME, an empty HOME, TENDB_MCP_TOKEN and the guard variables', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-session.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement** the spec's eight steps in that order (`home.prepare` first, `thread/start` or `thread/resume`
      with `approvalPolicy: 'never'` and `codexThreadConfig(spec)`). `guardSocketPath(socketDir, sessionId)` joins
      `socketDir` and the session ID's last 12 characters plus `.sock`, and becomes `TENDB_GUARD_SOCKET`; Task 8 opens
      it, and until then every hook call is refused, which is safe because nothing starts a real session before Task 9.
      `home.trustGuardHook` takes effect in the running app-server (measured in the spike), so `hooks/list` is simply
      read again; no restart. A different version in `InitializeResponse.userAgent` logs a warning. `spec.allowedTools`,
      `lanePermissionMode` and the sandbox's `askRules`, `disallowedTools` and `autoMode` don't apply here.

`MODEL_ALIAS_PATTERN.test(spec.model)` means an alias reached Codex unmapped: end with the text below, before anything
spawns. Codex model IDs hold digits, so they never match. Both this and a model Codex refuses use one text:
`Codex refused the model "<id>". Set this account's Model map in Settings.`

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/daemon typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): start a Codex session behind its safety checks`.

---

### Task 7: Events, limits, send and stop

**Files:**

- Create: `apps/daemon/src/sessions/codex-mapping.ts`
- Modify: `apps/daemon/src/sessions/codex-session.ts`
- Test: `apps/daemon/src/sessions/codex-mapping.test.ts`, `codex-session.test.ts`

**Interfaces:**

- Consumes: `contextEvent` from `claude-mapping.ts` (move it to `sessions/context-event.ts` so both adapters import it).
- Produces: `mapCodexNotification(n: { method: string; params: unknown }, state: CodexTurnState): readonly SessionEvent[]`
  and `rateLimitEvents(snapshot: RateLimitSnapshot): readonly RateLimitEvent[]`, with `limitTypeOf(minutes: number |
  null): string | null`: 300 is `five_hour`, 10080 is `seven_day`, null is null, otherwise `${minutes}_minutes`. Use the
  windows Task 1 recorded. `CodexTurnState` holds the turn's last message text and this session's token totals.
  `RateLimitSnapshot` comes from `codex-protocol.ts`; `RateLimitEvent` is
  `Extract<SessionEvent, { type: 'rate_limit' }>`.

- [ ] **Step 1: Write the failing tests.**

```ts
// codex-mapping.test.ts: one table, one row per notification
['a command', itemCompleted({ type: 'commandExecution', command: 'ls' }), [{ type: 'activity', kind: 'tool' }]],
['a message', itemCompleted({ type: 'agentMessage', text: 'hi' }), [{ type: 'activity', kind: 'text' }]],
['token use', tokenUsage({ last: 136000, window: 272000 }),
  [{ type: 'context', percentage: 50, totalTokens: 136000, maxTokens: 272000 }]],
['compaction', { method: 'thread/compacted', params: {} }, [{ type: 'compacted', trigger: 'auto' }]],
['a method 10db does not read', { method: 'turn/diff/updated', params: {} }, []],
['a known method with a bad shape', { method: 'turn/completed', params: {} }, []], // logged by the caller

// rate limits
expect(rateLimitEvents({ primary: { usedPercent: 96.5, windowDurationMins: 10080, resetsAt: 1800000000 }, secondary: null }))
  .toEqual([{ type: 'rate_limit', status: 'allowed', utilization: 0.965,
    resetsAt: new Date(1800000000000), limitType: 'seven_day' }]);

// turn_complete: this session's tokens, with cached ones split out as Claude's event carries them. Each
// thread/tokenUsage/updated during a turn adds its `last`, because a resumed thread's `total` includes earlier sessions
// and `updateSessionUsage` sets the row. Two updates of last { inputTokens: 300, cachedInputTokens: 30, outputTokens: 60 },
// last message 'done'
// -> { type: 'turn_complete', inputTokens: 540, cachedTokens: 60, outputTokens: 120, costUsd: 0, text: 'done' }
// a token update outside a turn adds nothing

// codex-session.test.ts
it('sends text as turn/steer during a turn and turn/start between turns', ...);
it('turns usageLimitExceeded into rejected, then ended rate_limited', ...); // resetsAt from the last window
it('reads account/rateLimits/read when no window has been seen', ...);
it('ends account_refused, signed out, on unauthorized', ...);
it('ends turn_complete with result error on another failed turn', ...);
it('ends with error when the process exits unasked, with the end of its stderr', ...);
it('stop interrupts, ends the process and emits one ended', ...);
it('emits exactly one ended when the process exits during stop', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-mapping.test.ts src/sessions/codex-session.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement.** `status` is `allowed` unless the turn failed with `usageLimitExceeded`. An active turn's ID
      comes from `turn/started`. The text on `turn_complete` is capped as the Claude adapter caps it. `stop` waits
      `stopGraceMs` for `turn/interrupt` before ending the process.

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, plus `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-mapping.test.ts`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): map Codex events and limits onto session events`.

---

### Task 8: The guard

**Files:**

- Create: `apps/daemon/src/sessions/codex-guard.ts`
- Modify: `apps/daemon/src/sessions/codex-session.ts`
- Test: `apps/daemon/src/sessions/codex-guard.test.ts`

**Interfaces:**

- Consumes: `spec.preToolUse`, `spec.canUseTool`, `guard-hook.sh` from Task 3.
- Produces:

```ts
export const HookInput = z.looseObject({
  tool_name: z.string(), tool_input: z.unknown(), tool_use_id: z.string().optional(), cwd: z.string().optional(),
});
export interface GuardCall { readonly toolName: string; readonly input: Record<string, unknown> }
/** The calls the guard judges for one hook call; null is a tool 10db doesn't know, which is refused. */
export function guardCalls(hook: HookInput): readonly GuardCall[] | null;
/** Every path a patch adds, updates, deletes or moves, in order. */
export function patchPaths(patch: string): readonly string[];
export type GuardAnswer = { readonly allow: true } | { readonly allow: false; readonly reason: string; readonly interrupt: boolean };
export function judgeHookCall(
  spec: Pick<SessionSpec, 'preToolUse' | 'canUseTool'>, hook: HookInput, signal: AbortSignal,
): Promise<GuardAnswer>;
export interface GuardSocket { readonly path: string; close(): Promise<void> }
export function openGuardSocket(
  path: string, judge: (hook: HookInput, signal: AbortSignal) => Promise<GuardAnswer>,
): Promise<GuardSocket>;
```

- [ ] **Step 1: Write the failing tests.**

```ts
it.each([
  ['Bash', { command: 'ls' }, [{ toolName: 'Bash', input: { command: 'ls' } }]],
  ['mcp__10db__commit', { message: 'x' }, [{ toolName: 'mcp__10db__commit', input: { message: 'x' } }]],
  ['view_image', { path: 'a.png' }, null],
  ['write_stdin', {}, null],
  ['anything_new', {}, null],
])('%s', (tool_name, tool_input, expected) => expect(guardCalls({ tool_name, tool_input })).toEqual(expected));
it('turns a patch into one Edit per path, a move into both', ...); // file_path resolved against the hook's cwd
it.each([
  ['add', '*** Add File: a.ts', ['a.ts']],
  ['update and move', '*** Update File: a.ts\n*** Move to: b.ts', ['a.ts', 'b.ts']],
  ['delete', '*** Delete File: a.ts', ['a.ts']],
  ['two files', '*** Add File: a.ts\n+x\n*** Update File: b.ts', ['a.ts', 'b.ts']],
])('patchPaths: %s', ...);
it('refuses the whole patch when one path is refused', ...);
it('allows on allow, refuses on deny, and on ask waits for canUseTool', ...);
it('refuses and asks to interrupt when canUseTool says interrupt', ...);

// The real script against a real socket, run with /bin/sh
it.each([
  ['an allowed call', allowJudge, { exit: 0, stdout: '' }],
  ['a refused call', denyJudge, { exit: 0, stdoutHas: '"permissionDecision":"deny"' }],
  ['no socket', null, { exit: 2 }],
  ['a closed socket', closedSocket, { exit: 2 }],
  ['a daemon error', throwingJudge, { exit: 2 }],
  ['a slow answer past --max-time', neverJudge, { exit: 2 }],
])('hook script: %s', ...);
it('refuses a call waiting on a card when the socket closes', ...);
it('binds over a stale socket file', ...); // removes the file; a session's path is its own
```

The socket tests use a short path under `/tmp`, because a Vitest temp dir is past the 104-byte limit, and skip with
`SANDBOXED` from `test/fixtures.ts`, as `apps/daemon/AGENTS.md` says.

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-guard.test.ts`
Expected: FAIL, module missing.

- [ ] **Step 3: Implement.** Deny JSON is
      `{ hookSpecificOutput: { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason } }`. A
      request that fails the schema, or a judge that throws, answers 500, so `curl --fail` refuses. `judgeHookCall` runs each
      `GuardCall`: `deny` refuses, `ask` calls `canUseTool` with `escalated: false`, `allow` goes on. Wire it into
      `codex-session.ts`; `interrupt` calls `turn/interrupt`; `TENDB_GUARD_MAX_SECONDS` is
      `Math.ceil(spec.mcp.toolTimeoutMs / 1000)`.

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/daemon typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): run the guard from a Codex PreToolUse hook`.

---

### Task 9: The sandbox, and running a real lane

**Files:**

- Modify: `apps/daemon/src/sessions/codex-lane-config.ts`
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts`, `sandbox/protected-reads.ts`, `sandbox/index.ts`
- Modify: `apps/daemon/src/runner/runner.ts:1511,1575`
- Test: `apps/daemon/src/sessions/codex-lane-config.test.ts`, `sandbox/lane-sandbox.test.ts`, `sandbox/profile.test.ts`,
  `runner/runner.test.ts`

**Interfaces:**

- Produces: `LaneSandboxSpec` gains `readonly shellEnv: Readonly<Record<string, string>>`, a command's whole environment
  for an agent that starts commands from nothing: `{ ...allowlisted(input.env), TMPDIR: tmpDir, ...commandEnv }`, the
  gate's recipe (`gate-sandbox.ts:167`). `commandEnv` alone holds no `PATH`, `HOME` or `TMPDIR`, because a Claude lane
  inherits those. `LaneSession.commandEnv` and what Claude lanes get don't change. `isEqualOrUnder` is exported from
  `sandbox/index.ts`. `codexThreadConfig` gains `permissions.lane` and `shell_environment_policy`.

- [ ] **Step 1: Write the failing tests.**

```ts
// codex-lane-config.test.ts, from a LaneSandboxSettings fixture and spec.cwd '/w/lane'
expect(config.permissions.lane.filesystem).toEqual({
  ':minimal': 'read',
  '/usr': 'read',                  // allowRead
  '/w/lane': 'write',              // the checkout
  '/tmp/lane-1': 'write',          // allowWrite
  '/w/lane/.env.local': 'deny',    // denyRead, past '/'
  '/w/lane/nested': 'read',        // denyWrite under a writable path
});
expect(config.permissions.lane.filesystem).not.toHaveProperty('/w/other'); // denyWrite elsewhere stays closed
expect(config.permissions.lane.filesystem).not.toHaveProperty('/h/install[s]'); // a listing pattern is left out
expect(config.permissions.lane.network).toEqual({
  enabled: true, mode: 'full', domains: { 'registry.npmjs.org': 'allow' },
  allow_local_binding: true, unix_sockets: { '/tmp/lane-1': 'allow' },
});
it('passes an empty host list through, which blocks every host', ...);
expect(config.shell_environment_policy).toEqual({ inherit: 'none', set: spec.sandbox.shellEnv });

// protected-reads test
expect(homeProtectedReads('/h')).toEqual(expect.arrayContaining(['/h/.codex', '/h/.agents']));
// lane-sandbox.test.ts, with PATH, HOME and ANTHROPIC_AUTH_TOKEN in the session env
expect(spec.shellEnv).toMatchObject({ PATH: expect.any(String), HOME: expect.any(String), TMPDIR: session.tmpDir });
expect(spec.shellEnv).toHaveProperty('GIT_CONFIG_GLOBAL', '/dev/null'); // from prepareCommandEnv
expect(spec.shellEnv).not.toHaveProperty('ANTHROPIC_AUTH_TOKEN');
// runner.test.ts
it('records the provider of the account a session runs on', ...);
it('builds a lane sandbox on the account home for a ChatGPT account', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-lane-config.test.ts src/sandbox/lane-sandbox.test.ts src/sandbox/profile.test.ts src/runner/runner.test.ts`
Expected: FAIL

- [ ] **Step 3: Implement.** Skip `'/'` in `denyRead`. Skip any `allowRead` entry holding `*` or `[`. `runner.ts:1511` calls
      `sessionConfigDir(account.kind, launch.env, homedir())`; `:1575` records `providerOf(account.kind)`. `project.provider` stays.

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/daemon typecheck`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): translate the lane sandbox for Codex and run real lanes`.

---

### Task 10: The briefing and brainstorm chat

**Files:**

- Modify: `apps/daemon/src/briefing/prompts.ts`, `apps/daemon/src/runner/runner.ts:1441,1459`, `packages/harness/src/index.ts`
- Modify: `apps/daemon/src/daemon/start.ts:893`
- Modify: `apps/desktop/src/views/shape/composer.tsx:130`
- Test: `apps/daemon/src/briefing/prompts.test.ts`, `packages/harness/src/harness.test.ts`,
  `apps/daemon/src/shape/service.test.ts`, `apps/desktop/src/views/shape/composer.test.tsx`

**Interfaces:**

- Produces: `PromptInput.provider: Provider` (from the kind of the account this session runs on, never
  `project.provider`); `StepBrief.skillBodies?: readonly string[]`;
  `readSkillBody(name: string, dir?: string): string | null` in `@10db/harness`; `RunnerOptions.skillBody(name: string):
  string | null`, wired in `start.ts` from `opts.harnessDir`.

- [ ] **Step 1: Write the failing tests.**

```ts
const codex = buildSessionPrompt({ ...input, provider: Provider.Codex, sandboxed: true });
expect(codex).toContain('Change files with apply_patch');
expect(codex).toContain('mcp__10db__ask_human');
expect(codex).toContain('The builder adds a host in Settings, which applies from your next session.');
expect(codex).not.toContain('auto mode');
expect(codex).not.toContain('AskUserQuestion');
expect(codex).toContain('the Edit or Write tool means apply_patch');
expect(codex).toContain(planningSkillBody); // the body, under `Skills to use`
const claude = buildSessionPrompt({ ...input, provider: Provider.Claude, sandboxed: true });
expect(claude).toBe(/* today's output for this input */);

it('briefs for the account a lane moved to', ...); // runner.test.ts: provider follows the account, session by session

// shape service: launch on a project whose account is codex_signin
await expect(start(codexProject)).rejects.toThrow("Brainstorm chat isn't available on a ChatGPT account");
it('starts again once the project is back on a Claude account', ...);
```

- [ ] **Step 2: Run them to see them fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/briefing/prompts.test.ts src/shape/service.test.ts && pnpm --filter @10db/harness exec vitest run`
Expected: FAIL

- [ ] **Step 3: Implement.** Claude's output doesn't change. For `Provider.Codex`:
  - Leave out the auto-mode line, and swap the hosts line for: "A command that reaches a network host outside the
    project's allowed domains fails with its output lost. If you need one, ask with `mcp__10db__ask_human`. The builder
    adds a host in Settings, which applies from your next session."
  - The edit rule says "Change files with apply_patch, never with an interpreter one-liner", then as it reads today.
  - After `How you work`, add: "In this session, the Edit or Write tool means apply_patch."
  - Under `Skills to use`, add each body from `skillBodies`.
  - `runner.ts`: move `getAccountRow(db, ctl.accountId)` from `:1473` above `buildSessionPrompt` at `:1441`, since
    `provider` comes from `providerOf(account.kind)`. It has no side effects, and `unready(account)` stays where it is.
  - `launch` in `start.ts` throws the `InvalidError` in the test above. The alert at `composer.tsx:130` shows that
    message under the title "Not available on this account", not "Couldn't reach Claude".

- [ ] **Step 4: Run them to see them pass.**

Run: the Step 2 command, then `pnpm --filter @10db/desktop exec vitest run src/views/shape`
Expected: PASS

- [ ] **Step 5: Commit** `feat(daemon): brief Codex lanes and refuse brainstorm chat on a ChatGPT account`.

---

### Task 11: Moves in both directions, and the live file

**Files:**

- Create: `apps/daemon/test/codex.live.test.ts`, `apps/daemon/test/fake-responses.ts`
- Modify: `apps/daemon/src/env.ts:51`, `apps/daemon/.env.example`
- Modify: `apps/daemon/src/accounts/limits.test.ts`, `accounts/moves.test.ts`, `runner/runner.test.ts`

**Interfaces:** Consumes the whole adapter. `TENDB_LIVE_CODEX` is `'0' | '1'`, like `TENDB_LIVE_CLAUDE`.
`fake-responses.ts` is the spike's server, typed.

- [ ] **Step 1: Write the move tests.** They pin existing behaviour, so they pass at once. To prove they can go red,
      temporarily make `moveTargets` and `usableFallback` skip accounts of another provider, watch them fail, and revert.

```ts
// limits.test.ts
it.each([
  ['a ChatGPT project falls back to a Claude account', codexAccount, claudeAccount],
  ['a Claude project falls back to a ChatGPT account', claudeAccount, codexAccount],
])('%s at its threshold, handing off', ...); // moved, handOff true, moved card raised, way back armed
it('offers a ChatGPT project with no fallback every other account on the card', ...);
it('pauses a ChatGPT project with no fallback at the hard limit', ...);

// runner.test.ts, on the fake adapter with kind-keyed sessions
it('runs the next session on the new account from the handoff, with the step alias mapped', ...);
it('does not resume a conversation from the other account', ...);
```

- [ ] **Step 2: Run them.**

Run: `pnpm --filter @10db/daemon exec vitest run src/accounts/limits.test.ts src/accounts/moves.test.ts src/runner/runner.test.ts`
Expected: PASS with the temporary change reverted, and `git diff` shows only tests.

- [ ] **Step 3: Write `codex.live.test.ts`,** skipped unless `TENDB_LIVE_CODEX=1`, on the real `codex`, `fake-responses.ts`,
      a home whose path has a space, and a checkout under `~/.10db/`, never `/tmp`:

```ts
it('ignores a planted .codex/ on a first session, a second session and a resume', ...); // planted MCP never runs
it('runs the hook, from a home path with a space', ...);
it('refuses a call the guard denies, for Bash, apply_patch and an MCP tool', ...);
it('refuses the call when the guard socket is gone', ...);
it('keeps a lane from reading auth.json, a .env file and another checkout', ...);
it('keeps a lane from writing .git', ...);
it('keeps a lane from reaching the guard socket', ...);
it('blocks an unlisted host and lets a POST reach a listed one', ...);
it('blocks every host for a project that lists none', ...);
it('runs with the real toolchain: node and git status', ...); // grant plain reads here if a toolchain needs them
it('resumes a thread after the process restarts', ...);
```

- [ ] **Step 4: Run it.**

Run: `TENDB_LIVE_CODEX=1 pnpm --filter @10db/daemon exec vitest run test/codex.live.test.ts`
Expected: PASS. Fix production code, not the test. A toolchain read that's missing goes in the translator.

- [ ] **Step 5: Confirm it skips by default.**

Run: `pnpm --filter @10db/daemon exec vitest run test/codex.live.test.ts`
Expected: skipped

- [ ] **Step 6: Commit** `test(daemon): cover moves between Claude and ChatGPT accounts and Codex live`.

---

### Task 12: Docs, and the first Ampsio lane

**Files:**

- Create: two files in `docs/architecture/decisions/`, `2026-11-05-chatgpt-plan-through-the-codex-app-server.md` and
  `2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md`
- Modify: `docs/architecture/open-questions.md`, `docs/architecture/04-accounts.md`,
  `docs/architecture/03-trust-boundaries.md`, `docs/open-items.md`, `apps/daemon/AGENTS.md`

**Interfaces:** None.

- [ ] **Step 1: Run one lane by hand, with Travis.** In the app: add a ChatGPT plan account, `codex login` in its home,
      confirm the email, fill in the Model map, add Ampsio on that account with no fallback, and start one small `quick`
      task. Expected: the lane runs, commits through `mcp__10db__commit`, the gate runs, usage shows tokens and limit
      percent, and Claude projects are unaffected.

- [ ] **Step 2: Write the decisions,** recording what the lane showed.
  - Terms and login: **Amends** decision 4. Travis's decision of 2026-11-05 and its reasons from the spec's terms section,
    and that a separate `codex login` replaces reusing `~/.codex`.
  - Sandbox and guard: the hook instead of approvals, why `approvalPolicy: never`, the trust pin, the failure modes
    handled, and the known gaps. Cites `decisions/2026-10-29-sandbox-is-the-boundary.md`.

- [ ] **Step 3: Update the docs.** Close the Codex row in `open-questions.md`. Tick `Accounts: Codex accounts` for
      `codex_signin` in `open-items.md`, leaving `openai_api_key`. Add the new modules and invariants to `04-accounts.md`,
      and the Codex boundary to `03-trust-boundaries.md`. `apps/daemon/AGENTS.md` says it also runs Codex sessions.

- [ ] **Step 4: Run the gate.**

Run: `make gate`
Expected: `GATE PASS`

- [ ] **Step 5: Commit** `docs: record the decisions for ChatGPT accounts`, naming every path.
