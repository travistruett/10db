# OAuth MCP Servers in 10db Sessions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief for the builder

**What changes for you.** Your MCP servers that sign in with OAuth work in 10db sessions the way they work in
Claude Code and Codex:

- **Claude plan.** OAuth servers already connect on Claude Code's default folder. An entry with an `oauth` block
  is no longer refused. Your claude.ai connectors come into sessions, as they do in Claude Code; the project's
  "Your MCP servers" switch turns them off too.
- **Claude API key and Bedrock.** These sessions use the sign-ins your own Claude Code keeps, as Claude Code does
  when you switch it to Bedrock in its default folder.
- **Codex.** Settings › Trust shows **Sign in** next to an OAuth server for each Codex account that isn't signed
  in. It runs Codex's own sign-in in that account's folder and opens your browser.
- **Gateway, and a Claude plan account on its own folder** (you have neither today). Gateway says what it lacks.
  An own-folder plan account gets the terminal command from Settings.

**What it buys.** Linear, Notion and your claude.ai connectors in lanes, Plan and chats, with no token handled by
10db.

**What could go wrong, and how we'd know.**

- **A keyed session could bill your plan.** API-key and Bedrock sessions now share a keychain entry with your
  plan login. The check before the prompt refuses an API-key session that isn't billing the key, and a Bedrock
  one that isn't on Bedrock. It doesn't compare plan names, though. Task 8 first confirms the entry really holds a
  plan login, then runs one live session of each kind.
- **Connectors could fail to load.** A short Claude Code start with no prompt reads them, in about 2 s (up to 10 s
  on an account with none), cached for 10 minutes. If it fails, the session starts without them and says so.
- **Managed MCP config.** If an organization's `managed-mcp.json` ever appears on this Mac, the connector start
  would launch its servers, and Claude Code has no switch to skip it. That start stops at the first entry that
  isn't a connector, and Task 8 checks it.
- **Connector tools act.** They can send mail. They take the guard and judge path of your other servers.

**Calls you might disagree with.**

- **Codex tokens go in a file** in the account's own folder (`mcp_oauth_credentials_store = "file"`). Under 10db's
  empty home that is where Codex's own fallback lands anyway.
- **10db opens the sign-in page with `/usr/bin/open`**, so the window never learns to open any https page.
- **Gateway doesn't read your sign-ins.** Nothing proves your plan login never reaches a gateway's own address.
  Its OAuth servers are named as not run there yet, and a follow-up is filed.
- **Codex gets no connectors**, and neither do API key and Bedrock (Claude Code offers none there). Settings says
  so, and a follow-up is filed.
- **No sign-in status for Claude accounts.** A session that finds a server signed out says where to sign in.

**What I need from you.** An API key and the Bedrock variables for two live rows, and one browser approval in the
Codex click-through.

---

**Goal:** OAuth MCP servers and claude.ai connectors run in 10db sessions as Claude Code and Codex run them, with
no token read, copied or stored by 10db.

**Architecture:** Each agent keeps its own token store.

- Claude's API-key and Bedrock accounts point Claude Code's keychain lookup at the builder's own entry
  (`CLAUDE_SECURESTORAGE_CONFIG_DIR`).
- Plan accounts get their claude.ai connectors through a probe: a no-prompt, non-strict Claude Code start on a
  fresh config folder that reads the account's entry. The session passes the connectors back as explicit
  `claudeai-proxy` entries, so `strictMcpConfig` stays on.
- Codex signs in through its app-server, in the account's own home, behind a Settings › Trust row. It calls
  `mcpServer/oauth/login` on an ephemeral thread that carries the one server.

**Tech Stack:** TypeScript, zod 4.6.7, `@anthropic-ai/claude-agent-sdk` 0.3.316 on Claude Code 2.1.302
(`CLAUDE_CODE_VERIFIED_ON`), Codex 0.167.0 app-server (`CODEX_VERIFIED_ON`), Vitest, Mantine 9.8.

**Spec:** the brief `~/Agents/notes/10db/oauth-mcp-run/plan-brief.md` and research
`~/Agents/notes/10db/oauth-mcp-run/research.md`. Review round 1:
`~/Agents/notes/10db/oauth-mcp-run/plan-review-r1.md`. Shape follows
`docs/superpowers/plans/2026-11-12-10db-trust-t6-your-mcp-servers.md`.

## Per provider

| Account                     | An OAuth server's token                                                                 | claude.ai connectors                                                                      | A server not signed in: the session note                     | Signs in where                                                          |
| --------------------------- | --------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------- |
| Claude plan, default folder | the builder's entry (no change: it already connects)                                    | relayed from the probe (Task 3)                                                           | "Sign in to it in Claude Code: run `claude`, then `/mcp`."   | the builder's own Claude Code                                           |
| Claude plan, its own folder | that folder's entry `Claude Code-credentials-<h>`                                       | relayed from the probe, on that folder's entry                                            | "Settings › Trust shows how to sign in."                     | terminal: `CLAUDE_CONFIG_DIR=<dir> claude`, then `/mcp` (Settings shows) |
| Claude API key              | the builder's entry, through `CLAUDE_SECURESTORAGE_CONFIG_DIR` (Task 2)                 | none: Claude Code offers none without a claude.ai login. Settings says so; follow-up      | as the default folder                                        | the builder's own Claude Code                                           |
| Claude Bedrock              | as API key                                                                              | none: Claude Code turns them off on third-party providers. Settings says so; follow-up    | as the default folder                                        | the builder's own Claude Code                                           |
| Claude Gateway              | its own empty entry: none (unchanged)                                                   | none, as Claude Code                                                                      | "…signs in with OAuth, which 10db doesn't run on a Gateway account yet." | not yet; follow-up (Task 9)                                             |
| Codex (ChatGPT plan)        | `$CODEX_HOME/.credentials.json`, file store (Task 4)                                    | none: Codex's apps stay off (`features.apps: false`). Settings says so; follow-up         | "Sign in in Settings › Trust."                               | Settings › Trust › Sign in (Tasks 5–7)                                  |

Terms used throughout:

- **The builder's entry** is the one the builder's own Claude Code uses. `CLAUDE_SECURESTORAGE_CONFIG_DIR` is set
  to the login shell's absolute `CLAUDE_CONFIG_DIR` (`Launcher.loginConfigDir()`), or to `''` for Claude Code's
  default folder.
- **The default account** is the one whose `configDir === launcher.loginConfigDir()` (`daemon/start.ts:690`).
  `null` means Claude Code's default folder.
- **An own folder** is a `configDir` that is non-null and differs from `loginConfigDir()`.
- **A variable "set"** means its key is present in the env, the empty string included.

## Verified while planning (2026-11-14, pinned CLIs, no prompt sent)

Spike scripts: `~/Agents/notes/10db/oauth-mcp-run/spikes/` (`fresh-dir.mjs`, `relay.mjs`, `codex-oauth.mjs`,
`codex-oauth-r2.mjs`). Each takes the arguments its first lines read. Task 0 reruns them if a pin moved.

**Claude connectors and the `oauth` field**

- **Strict hides connectors.** A strict session's `mcpServerStatus()` lists no claude.ai entries.
- **The fresh-folder probe works** (`fresh-dir.mjs`). The probe is a non-strict session with `settingSources: []`,
  a scratch cwd, a fresh empty `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR=''`.
  - It lists all 8 connectors within 2 s, each with `scope: 'claudeai'` and
    `config: { type: 'claudeai-proxy', url, id }`. Nothing else loads.
  - It creates no keychain entry for the scratch folder (checked by attribute lookup).
  - It writes only `.claude.json`, `backups/` and `sessions/` there.
  - There is no `managed-mcp.json` on this Mac. Claude Code 2.1.302 has no switch that skips managed MCP config.
- **Relaying them works** (`relay.mjs`). A strict session given those entries through `setMcpServers` connects all
  8, with `scope: 'dynamic'` and no errors. The SDK's `setMcpServers` type omits `McpClaudeAIProxyServerConfig`,
  but the CLI accepts it.
- **The CLI already reads `oauth`.** Claude Code 2.1.302's http and sse schema takes
  `oauth: { clientId?, callbackPort?, authServerMetadataUrl? (https), scopes? (string), xaa? (boolean) }`.
  - The SDK's `McpHttpServerConfig` type lacks the field.
  - The keychain key hashes `{type,url,headers}` only.
- **No sign-in method in the SDK.** The SDK has no public way to start a Claude MCP sign-in. `mcp_authenticate` is
  a private control subtype only. So an own-folder plan account gets the terminal command.

**Codex sign-in** (`codex-oauth.mjs`, `codex-oauth-r2.mjs`)

- **A thread is needed.** `mcpServer/oauth/login` without `threadId` fails with "No MCP server named … found".
  An app-server whose home is not signed in to ChatGPT runs all of the following.
- **`thread/start`** with `{ cwd, ephemeral: true, approvalPolicy: 'never', config: { mcp_servers: { <name>: { url } } } }`
  succeeds.
- **Status is known at once.** `mcpServerStatus/list { threadId, detail: 'toolsAndAuthOnly' }`, asked with no wait
  right after `thread/start`, answered within 283 ms: `authStatus: 'notLoggedIn'`, `runtimeStatus:
  'authenticationRequired'`. Task 4 still polls a server that reads `unknown`.
- **Login.** `mcpServer/oauth/login { name, threadId, timeoutSecs }` answers an https `authorizationUrl` on the
  server's host, and a `loginId`. The redirect is `127.0.0.1:<port>/callback`, on a new random port for each login
  (52530, then 52547). So nothing collides unless a server fixes its port.
- **The `oauth` block maps across.** Codex's server config takes `scopes: string[]`, `oauth_resource` and
  `oauth: { client_id, client_secret, token_endpoint_auth_method, callback_url, callback_port,
  authorization_server_issuer }`.
  - A thread config with `scopes: ['read']` and `oauth: { client_id: 'spike-client' }` started fine.
  - Its login URL carried `client_id=spike-client` and `scope=read`.
  - `McpServerOauthLoginParams.clientRegistration` is only `'auto' | 'cimd' | 'dcr'`. So the client id goes in the
    server config, never in the login params.
- **Shapes.**
  - `McpAuthStatus = 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'`.
  - `McpServerOauthLoginResponse = { authorizationUrl, loginId? }`.
  - `ListMcpServerStatusResponse = { data, nextCursor }`.
  - `McpServerOauthLoginCompletedNotification = { name, threadId, loginId?, success, error? }`.

## Global Constraints

- **Rules to read.** Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md` and
  `packages/contracts/AGENTS.md`. The `AGENTS.md` of each module touched: `session-setup`, `sessions`,
  `environment`, `accounts`, `trust` and `views/settings`. `.claude/rules/code-style.md` and
  `.claude/rules/testing.md`.
- **Branch and commits.** Branch `feat/oauth-mcp` in `~/Projects/10db-worktrees/oauth-mcp`. Tasks run in order,
  one commit per task.
  - Commits are Conventional Commits. Name every path (`git add a b && git commit -m '...'`) and use a
    single-quoted `-m`.
  - End each one with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
  - Each newly tested behavior carries one value card. A new row in an existing table needs none.
- **No token, ever.**
  - 10db never reads, copies, logs or stores an MCP token, a keychain entry's data or a `.credentials.json`.
  - No `security … -w` or `-g` anywhere, tests included. No read of `mcp-needs-auth-cache.json`: Task 2 deletes
    it unread.
  - Connector `url`/`id` and Codex's `authorizationUrl` are not secrets. They are still never logged, put in an
    event or stored.
- **One place for account variables.** Only `environment/launch.ts` sets or reads the values of
  `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR`. `session-env.ts` lists them only to strip them.
  Other modules call `launch.ts`'s exports.
- **Strict stays on.** `strictMcpConfig: true` stays on every Claude session.
  - Only the connector probe runs non-strict.
  - It runs on a fresh config folder under the data directory, with `settingSources: []`, `AUTOUPDATE_OFF`, no
    prompt, and an empty cwd no lane can write.
- **Test boundaries.** Daemon tests run on the fake SDK `query`, the fake Codex child or `FakeAdapter`. Only
  `*.live.test.ts` runs a real CLI.
- **Live homes.** Live rows' homes and account folders come from `homeOutsideTemp` (`apps/daemon/test/fixtures.ts`).
- **Copy.** A Note from 10db line about a server ends "It is not in this session; don't look for its tools.", as
  today.

## Review Focus

1. **A keyed session that bills the plan.** An API-key session with `CLAUDE_SECURESTORAGE_CONFIG_DIR` set passes
   `checkAccount` before the prompt against a confirmed `expectedIdentity`, and `checkInitCredentials` after
   `init`. A Bedrock session reads `apiProvider: 'bedrock'`. Neither writes `oauthAccount` into its folder. Task
   8 L2 and L3 run only after showing the shared entry holds a plan login.
2. **The login shell sets its own `CLAUDE_SECURESTORAGE_CONFIG_DIR`.** It is stripped like a billing switch.
   Task 2 row in `session-env.test.ts`.
3. **The switch turns connectors off.** With the project's Your MCP servers off (app-wide or by override), no
   `claudeai-proxy` entry is passed and the probe never runs. Task 3 row in `runner.test.ts`.
4. **A connector that collides with a configured server.** One whose tool prefix equals a project or builder
   server's is left out. Task 3 row on `connectorsForSession`.
5. **A sign-in the builder abandons, or a restart.**
   - It ends `failed` at the deadline, with an event, and its child closed.
   - A new click starts afresh.
   - A restart leaves no slot and reads the status again.
   - Status and sign-in run on the same home as sessions.

   Rows in Tasks 5 and 6.

---

## Codex sign-in: state × event

States per (Codex account, server):

- **Not signed in:** `authStatus` reads `notLoggedIn`.
- **Signing in:** a slot in memory.
- **Signed in:** `oAuth`.
- **Failed:** the last attempt's message, in memory.
- **Unknown:** the status read failed, timed out or kept reading `unknown`. It shows "Couldn't read whether it's
  signed in." with **Sign in**.

An expired token that Codex can't refresh reads `notLoggedIn`. Every change of a slot sends one
`McpSignInChanged` event.

| Event                           | Not signed in / Unknown                                                    | Signing in                                                                       | Signed in                                                                                              | Failed                    |
| ------------------------------- | -------------------------------------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------- |
| Builder clicks Sign in          | → signing in: the home prepared, app-server, ephemeral thread, login, `/usr/bin/open` | stays: the same page opens again (`reopen`), no second process                   | no button                                                                                              | → signing in              |
| Browser completes               | n/a                                                                        | → signed in: status cache dropped, event, child closed                            | n/a                                                                                                    | n/a                       |
| Abandoned, or `LOGIN_MS` passes | n/a                                                                        | → failed "The sign-in didn't finish. Try Sign in again.", event, child closed     | n/a                                                                                                    | stays                     |
| A fixed callback port is taken  | n/a                                                                        | → failed with the port message, event, child closed                               | n/a                                                                                                    | stays                     |
| Another server's click          | its own slot: slots are per (account, server)                              | unaffected                                                                       | unaffected                                                                                             | unaffected                |
| Daemon restart mid-login        | stays                                                                      | the child ends with the daemon; after restart the status read decides (signed in if Codex wrote the token first) | stays                                                                                                  | → as the status reads     |
| A session starts                | runs without the server; note "Sign in in Settings › Trust."               | as not signed in; sessions after completion get the server                        | connects                                                                                               | as not signed in          |
| Token expires mid-session       | n/a                                                                        | n/a                                                                              | Codex refreshes it (per-home lock). If it can't, that session's calls fail, and the next status read shows not signed in | n/a                       |

---

### Task 0: Confirm the starting point

**Files:** none (no commit).

- [ ] **Step 1:** Check that `CLAUDE_CODE_VERIFIED_ON` is `2.1.302` and `CODEX_VERIFIED_ON` is `0.167.0`
  (`apps/daemon/src/environment/agent-pins.ts`). If either moved, rerun the four spike scripts against the new
  pins, and stop if any verified fact above differs.
- [ ] **Step 2:** Confirm these names exist as used below. Where one moved, use it and list the mapping in the PR.
  - `session-setup/your-mcp-entry.ts`: `refusalOf`, `parseClaudeEntry`, `DeclaredYourServer`.
  - `session-setup/your-mcp-hash.ts`: `yourMcpConfigHash`.
  - `session-setup/your-mcp-plan.ts`: `YourRemotePlan`, `planYourMcp`.
  - `sessions/types.ts`: `YourSessionServer`.
  - `sessions/claude-session.ts`: `buildMcpServers`, `yourServersNote`.
  - `sessions/claude-mapping.ts`: `toSdkMcpServer`.
  - `sessions/mcp-tool-names.ts`: `mcpStatusToolNames`.
  - `environment/launch.ts`: `createLauncher`.
  - `environment/session-env.ts`: `BILLING_SWITCH_VARS`.
  - `environment/pinned-tools.ts`: `AUTOUPDATE_OFF`.
  - `sessions/codex-your-servers.ts`: `codexYourServers`.
  - `sessions/codex-home.ts`: `template`, `CodexHome`.
  - `sessions/codex-connect.ts`: `startCodexLogin`, `PORT_IN_USE`.
  - `sessions/account-check.ts`: `checkAccount`, `checkInitCredentials`.
  - `apps/daemon/scripts/codex-generate.ts`: `CODEX_SEED_TYPES`.
  - `trust/policy.ts`: `TrustPolicyInput`.
  - `apps/desktop/src/views/settings/your-mcp-servers.tsx`: `YourMcpServers`.

### Task 1: Claude takes an entry with an `oauth` block

**Files:**

- Modify:
  - `apps/daemon/src/session-setup/your-mcp-entry.ts`, `your-mcp-hash.ts`, `your-mcp-plan.ts` and
    `your-mcp-dto.ts`.
  - `apps/daemon/src/sessions/types.ts` and `sessions/claude-session.ts` (`buildMcpServers`).
  - The builders of a `YourSessionServer` (grep `codex: remote.codex`): `runner/runner.ts`,
    `daemon/shape-session-tools.ts`, `chat/hooks.ts` and `shape/explore-owner.ts`.
  - `packages/contracts/src/your-mcp.ts` (`YourMcpServerDto.oauth`), then regenerate
    `packages/contracts/generated/`.
- Test: `session-setup/your-mcp-config.test.ts`, `your-mcp-hash.test.ts`, `your-mcp-dto.test.ts` and
  `sessions/claude-adapter.test.ts`.

**Interfaces:**

- Produces:
  - `ClaudeOAuth` (zod `strictObject`) and `type ClaudeOAuth` in `your-mcp-entry.ts`:
    - `clientId?: string(min 1)`
    - `callbackPort?: int 1024–65535`
    - `authServerMetadataUrl?: https url`
    - `scopes?: string(min 1)`
    - `xaa?: boolean`
  - The remote variant of `DeclaredYourServer` gains `readonly oauth: ClaudeOAuth | null`. It is always null for
    `config.toml`.
  - `YourRemotePlan.oauth` and `YourSessionServer.claudeOAuth`, both `ClaudeOAuth | null`.
  - `YourMcpServerDto.oauth: McpConfigEntry[]`: the block's keys and values as text, or `[]`.

- [ ] **Step 1: Write the failing tests.**
  - `your-mcp-config.test.ts`:
    - The `oauth` refusal row goes.
    - An accepted row: `{ type: 'http', url: 'https://a.example', oauth: { clientId: 'x', callbackPort: 8080 } }`
      reads `refusal: null`, with that block in `declared.oauth`.
    - Refusal rows for `oauth: { clientSecret: 'x' }` and `oauth: { authServerMetadataUrl: 'http://a' }`. Each
      reads `It can't be read: oauth…`, naming the path, never the value.
  - `your-mcp-hash.test.ts`: the same entry with and without `oauth` hashes differently. The one without keeps
    the hash the existing row pins.
  - `your-mcp-dto.test.ts`: `oauth` lists `clientId=x` and `callbackPort=8080`.
  - `claude-adapter.test.ts`: in the `setMcpServers` record, a your-server with `claudeOAuth: { clientId: 'x' }`
    goes as `{ type: 'http', url, oauth: { clientId: 'x' } }`. One with null has no `oauth` key.
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/session-setup src/sessions/claude-adapter.test.ts`. Expected:
  FAIL on the old refusal and the missing `oauth`.
- [ ] **Step 3: Implement.**
  - Drop the `oauth` refusal in `refusalOf`, and parse the block with `ClaudeOAuth` in `ClaudeRemote`.
  - The hashed object includes `oauth` only when it is non-null.
  - `buildMcpServers` adds `oauth`, built as a typed variable rather than an object literal. The SDK type lacks
    the field and the CLI reads it, so no cast is needed.
  - `headersHelper` stays refused.
- [ ] **Step 4: Run the related tests, typecheck and lint.**
  - `pnpm --filter @10db/daemon exec vitest related <changed files> --run`
  - `pnpm --filter @10db/contracts generate`
  - `pnpm -r typecheck`
  - `pnpm exec eslint <changed files>`

  Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): your mcp servers with an oauth block reach claude as claude code reads them`.
  Value card:
  - `protects=` an oauth entry is approved by its exact block and reaches Claude with it.
  - `fails_when=` the block is dropped, refused, or left out of the hash.
  - `why_new=` the refusal row covered only the refusal.
  - `no_claim=` that an IdP accepts the client id.

### Task 2: Claude API-key and Bedrock accounts read the builder's sign-ins, and notes say where to sign in

**Files:**

- Modify: `apps/daemon/src/environment/launch.ts`, `environment/session-env.ts` and `environment/index.ts`.
- Create: `apps/daemon/src/sessions/claude-auth-cache.ts`.
- Modify: `sessions/claude-session.ts`, which runs the cache removal before `query` and changes `yourServersNote`.
- Test: `environment/launch.test.ts`, `environment/session-env.test.ts`, `sessions/claude-auth-cache.test.ts` and
  `sessions/claude-adapter.test.ts`.

**Interfaces:**

- Produces, from `environment` (all in `launch.ts`, the one file that sets or reads these variables' values):
  - `build()` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` to `loginConfigDir() ?? ''` on `AnthropicApiKey` and
    `Bedrock` only. Session and probe launches alike go through `build()`. Gateway and the subscription kinds
    never get it.
  - `BILLING_SWITCH_VARS` gains `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
  - `staleNeedsAuthCache(env): string | null` returns `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json` when both
    variables are set, `''` included. Otherwise null.
  - `McpSignInWhere` is an `as const` object:
    `{ BuildersClaudeCode: 'builders_claude_code', ThisAccount: 'this_account', NotYet: 'not_yet' }`.
  - `mcpSignInWhere(kind: AgentAccountKind, env): McpSignInWhere` decides in this order:
    1. `NotYet` for Gateway.
    2. `BuildersClaudeCode` when `CLAUDE_CONFIG_DIR` equals `loginConfigDir()` (the default account whose
       login shell sets one).
    3. `ThisAccount` when `CLAUDE_CONFIG_DIR` is set and `CLAUDE_SECURESTORAGE_CONFIG_DIR` is not.
    4. Otherwise `BuildersClaudeCode`.
- Produces, from `sessions`:
  - `removeStaleNeedsAuthCache(path): Promise<void>` unlinks the file without reading it.
  - It ignores `ENOENT`.
  - It rejects with `NeedsAuthCacheError` (a typed `Error`) for anything but a regular file or a link (`lstat`).

- [ ] **Step 1: Write the failing tests.**
  - `launch.test.ts`, the "a session launch" table:
    - The API key and Bedrock rows add `CLAUDE_SECURESTORAGE_CONFIG_DIR: ''`.
    - The Gateway and subscription rows list it in `absent`.
    - A new row: with the login shell's `CLAUDE_CONFIG_DIR=/h/b/.claude-other`, an API key adds
      `CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other'`.
    - "builds a probe like a session" asserts the probe has it too.
  - Pure tables in `launch.test.ts`:
    - `staleNeedsAuthCache`: rows for set `''`, set `/x`, and absent.
    - `mcpSignInWhere`: rows for Gateway, `''`, absent with `CLAUDE_CONFIG_DIR` set, `CLAUDE_CONFIG_DIR` equal to
      the login shell's, and neither set.
  - `session-env.test.ts`: a login env holding `CLAUDE_SECURESTORAGE_CONFIG_DIR=/x` loses it.
  - `claude-auth-cache.test.ts`, on a real temp dir:
    - The file goes and its sibling stays.
    - A missing file is fine.
    - A directory at that name is left alone and the call rejects with `NeedsAuthCacheError`.
  - `claude-adapter.test.ts`: `noteFor` takes `(kind, env)`. Its rows check the copy each case gives:
    - **Subscription, `{}`:** `oauthy isn't signed in. Sign in to it in Claude Code: run \`claude\`, then \`/mcp\`.
      It is not in this session; don't look for its tools.`
    - **API key, `{ CLAUDE_CONFIG_DIR: d, CLAUDE_SECURESTORAGE_CONFIG_DIR: '' }`:** the same copy.
    - **Subscription, `{ CLAUDE_CONFIG_DIR: d }`:** `oauthy isn't signed in for this account. Settings › Trust
      shows how to sign in. …`.
    - **Gateway:** `oauthy signs in with OAuth, which 10db doesn't run on a Gateway account yet. …`.
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/environment src/sessions/claude-auth-cache.test.ts src/sessions/claude-adapter.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Before `query`, the session calls `removeStaleNeedsAuthCache` on `staleNeedsAuthCache(spec.env)`. A failure
    is logged by its error name only, and the session goes on.
  - The comment above `build()` changes. A keyed session reads the builder's entry and runs as its key, and the
    preflight's `checkAccount` and the `init` check confirm it.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): claude api key and bedrock accounts use the builder's own mcp sign-ins`.
  Value card:
  - `protects=` API-key and Bedrock sessions read the builder's MCP sign-ins. Gateway, and plan accounts, never
    read another folder's.
  - `fails_when=` the variable is missing, inherited, or set on Gateway or a subscription. Or `''` reads as
    unset.
  - `why_new=` the launch rows covered only billing variables.
  - `no_claim=` that Claude Code prefers the key over the shared login (Task 8 L2 and L3).

### Task 3: claude.ai connectors come along on a Claude plan

**Files:**

- Create: `apps/daemon/src/sessions/claude-connectors.ts`.
- Modify:
  - `environment/launch.ts` (`Launcher.connectorProbe`).
  - `sessions/claude-adapter.ts` (owns the directory and its `stop`), `sessions/claude-session.ts`,
    `sessions/mcp-tool-names.ts` (exports `mcpToolPrefix`) and `sessions/types.ts`
    (`AgentSessionCore.claudeConnectors`).
  - `session-setup/your-mcp-plan.ts` and `your-mcp-for-session.ts` (`YourMcpPlan.connectorsOn`).
  - `trust/policy.ts` and the four session builders from Task 1.
  - `daemon/start.ts`: the startup sweep of `<dataDir>/connector-probe`, and stopping the directory on shutdown.
- Test: `sessions/claude-connectors.test.ts`, `sessions/claude-adapter.test.ts`, `environment/launch.test.ts`,
  `trust/policy.test.ts` and `runner/runner.test.ts`.

**Interfaces:**

- Produces:
  - `ClaudeConnector { name: string; url: string; id: string }`.
  - `connectorsFromStatus(status: unknown): ClaudeConnector[] | null` is the zod boundary.
    - It keeps entries with `scope: 'claudeai'` and `config: { type: 'claudeai-proxy', url: https, id: string(min 1) }`.
    - It drops a `dynamic` entry (one set over the control channel, never a file). It answers null as soon as
      any entry has another scope (`user`, `local`, `project`, `managed` or one it doesn't know). The probe then
      closes at once and logs only the count.
  - `mcpToolPrefix(name: string): string` is the server-name rule `mcpStatusToolNames` already uses.
  - `connectorsForSession(connectors, takenNames: readonly string[]): ClaudeConnector[]` drops a connector whose
    `mcpToolPrefix` equals that of a project, builder or 10db server.
  - `Launcher.connectorProbe(account: AccountRow, freshDir: string): Record<string, string> | null`.
    - For `ClaudeSubscription` it is `build(account)` with `CLAUDE_CONFIG_DIR=freshDir` and
      `CLAUDE_SECURESTORAGE_CONFIG_DIR=account.configDir ?? ''`.
    - For other kinds it is null.
  - `createConnectorDirectory(deps: { query; claudePath; probeRoot: string; clock: Clock; logger })` returns
    `{ list(accountId, env): Promise<readonly ClaudeConnector[] | null>; stop(): Promise<void> }`.
    - `CONNECTOR_PROBE_MS = 10_000`.
    - An answer with no claudeai entries by then is `[]`, meaning none. It is cached for
      `CONNECTOR_TTL_MS = 600_000`.
    - A CLI that never answered, threw, or loaded other scopes gives `null`, meaning failed. It is cached for
      `CONNECTOR_RETRY_MS = 60_000`.
    - Concurrent callers share one probe. `stop()` closes a probe in flight.
    - Nothing warms the cache at start. The cost: the first plan session per 10 minutes waits for the probe,
      about 2 s with connectors and up to `CONNECTOR_PROBE_MS` for an account that has none.
  - `AgentSessionCore.claudeConnectors: boolean` is `yours.connectorsOn && account.kind === ClaudeSubscription`.
  - `TrustPolicyInput.claudeConnectors: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `claude-connectors.test.ts`, pure rows:
    - `connectorsFromStatus`:
      - claudeai-proxy is kept.
      - An http url, a missing id, or a `dynamic` scope is dropped.
      - A `user` or `managed` entry anywhere gives null.
    - `connectorsForSession`: `claude.ai Gmail` is dropped when `claude_ai_Gmail` is taken.
  - `claude-connectors.test.ts`, the probe, on the fake `query`, a real temp dir and the fake clock:
    - Its options are `strictMcpConfig: false` and `settingSources: []`.
    - Its env has `DISABLE_AUTOUPDATER: '1'`.
    - Its cwd and `CLAUDE_CONFIG_DIR` are fresh under `probeRoot`.
    - No prompt is ever yielded.
    - It polls `mcpServerStatus` every 500 ms.
    - It ends `[]` at `CONNECTOR_PROBE_MS`, and `null` on a throw.
    - It always calls `close()`, and leaves `probeRoot` empty.
    - The TTL and retry caching hold, with one probe for two concurrent `list` calls.
    - `stop()` closes a probe in flight.
  - `claude-adapter.test.ts`:
    - With `claudeConnectors: true` on a subscription, `setMcpServers` gets `{ type: 'claudeai-proxy', url, id }`
      per kept connector, after the builder's servers and before 10db's.
    - With false, or on a keyed spec, the directory is never called.
    - A `null` answer, or none within `CONNECTOR_WAIT_MS = 12_000`, adds the note `Note from 10db: your claude.ai
      connectors didn't load in this session.`
    - `[]` adds no note.
    - A connector that reads `needs-auth` is named with "sign in to it on claude.ai".
  - `launch.test.ts`: `connectorProbe` rows for the default account (`''`), the default account on the login
    shell's folder (that folder), an own-folder subscription (its folder) and an API key (null).
  - `policy.test.ts`: `claudeConnectors: true` adds a line naming claude.ai connectors as the builder's own,
    outside the sandbox, with every call judged.
  - `runner.test.ts`, beside "starts a lane with your approved servers…": the spec has `claudeConnectors: true`,
    and false with the project's Your MCP servers override off.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - `probeRoot` is `<dataDir>/connector-probe`, mode 700. It is emptied at start and on `stop()`.
  - `buildMcpServers(spec, connectors)` takes the output of `connectorsForSession`.
  - `toSdkConnector` holds the one `as McpServerConfig` cast. Its comment says the SDK type omits
    `McpClaudeAIProxyServerConfig`, the CLI accepts it over `mcp_set_servers` (verified on 2.1.302), and the value
    was parsed by `connectorsFromStatus`.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): claude plan sessions get the account's claude.ai connectors`. Value card:
  - `protects=` a plan session gets its connectors under the Your MCP servers switch, with strict MCP config
    kept.
  - `fails_when=` the probe keeps other servers, skips cleanup or auto-updates, or runs with the switch off or on
    a keyed account.
  - `why_new=` nothing passed connectors before.
  - `no_claim=` that claude.ai keeps the proxy entry's shape (Task 8 L1).

### Task 4: Codex keeps MCP tokens in the account home, and its sessions say to sign in

**Files:**

- Modify:
  - `apps/daemon/src/sessions/codex-home.ts`: `template` gains `mcp_oauth_credentials_store: 'file'`, and
    `CodexHome` gains `ensureConfig()`.
  - `sessions/codex-session.ts`: the status read after `thread/start`.
  - `scripts/codex-generate.ts`: `CODEX_SEED_TYPES` gains `v2/ListMcpServerStatusResponse` and
    `v2/McpServerOauthLoginResponse`. Then regenerate `src/sessions/codex-generated/` with
    `pnpm --filter @10db/daemon generate:codex`.
- Create: `sessions/codex-mcp-auth.ts`.
- Test: `sessions/codex-home.test.ts`, `sessions/codex-session.test.ts` and `sessions/codex-mcp-auth.test.ts`.

**Interfaces:**

- Produces:
  - `McpAuthState` is an `as const` object:
    `{ SignedIn: 'signed_in', NotSignedIn: 'not_signed_in', NotOAuth: 'not_oauth', Unknown: 'unknown' }`.
  - `CODEX_MCP_STATUS_WAIT_MS = 5_000`, Codex's own deadline.
  - `readCodexMcpAuth(call: CodexCall, threadId: string, names: readonly string[], clock: Clock):
    Promise<Readonly<Record<string, McpAuthState>>>`.
    - It asks `mcpServerStatus/list { threadId, detail: 'toolsAndAuthOnly' }`, following `nextCursor`. The
      response is parsed with zod.
    - A name reading `unknown` is asked again every 250 ms until `CODEX_MCP_STATUS_WAIT_MS`.
    - It maps `oAuth` and `bearerToken` to SignedIn, `notLoggedIn` to NotSignedIn, and `unsupported` to
      NotOAuth. Unknown is what still reads `unknown` at the deadline.
  - `CodexHome.ensureConfig(): Promise<void>` writes `config.toml` and the hook as `prepare` does, but pins no
    checkout. `prepare` calls it.

- [ ] **Step 1: Write the failing tests.**
  - `codex-home.test.ts`:
    - The written config has `mcp_oauth_credentials_store = "file"`.
    - `ensureConfig` writes no `projects` entry.
  - `codex-mcp-auth.test.ts`, on the fake clock:
    - A table over the five `authStatus` values.
    - A two-page answer.
    - `unknown` then `notLoggedIn` reads NotSignedIn.
    - `unknown` past the deadline reads Unknown.
  - `codex-session.test.ts`, on the fake app-server:
    - A your-server reading `notLoggedIn` puts `Note from 10db: <name> isn't signed in for this account. Sign in in
      Settings › Trust. It is not in this session; don't look for its tools.` before the first turn's text.
    - A status error, or no answer within `CODEX_MCP_STATUS_WAIT_MS`, sends the prompt with no note.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The read runs only when the spec has a remote your-server, and it never ends the
  session.
- [ ] **Step 4: Run the related tests, typecheck, lint and `pnpm --filter @10db/daemon drift`.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): codex mcp sign-ins stay in the account home and sessions name a server to sign in`.
  Value card:
  - `protects=` Codex tokens land where Codex sessions read them, and a signed-out server is named.
  - `fails_when=` the store setting goes, an `unknown` reads as signed out, or a status failure blocks the
    prompt.
  - `why_new=` Codex sessions had no MCP status read.
  - `no_claim=` that Codex refreshes a token mid-session.

### Task 5: The Codex adapter signs a server in

**Files:**

- Create: `apps/daemon/src/sessions/codex-mcp-sign-in.ts`.
- Modify:
  - `sessions/codex-your-servers.ts` (the `oauth` mapping) and `sessions/codex-session.ts` (uses `codexChildHome`).
  - `sessions/codex-connect.ts` (exports `PORT_IN_USE`).
  - `sessions/types.ts` (`AgentAdapter.startMcpSignIn`, `AgentAdapter.mcpAuthStatus`).
  - `sessions/codex-adapter.ts`, `sessions/claude-adapter.ts`, `sessions/routed-adapter.ts`,
    `sessions/fake-adapter.ts` and `sessions/index.ts`.
- Test: `sessions/codex-mcp-sign-in.test.ts`, `sessions/codex-your-servers.test.ts`, `sessions/codex-session.test.ts`,
  `sessions/routed-adapter.test.ts` and `sessions/fake-adapter.test.ts`.

**Interfaces:**

- Consumes: `readCodexMcpAuth`, `CodexHome.ensureConfig`, `stopLoginProcess`, `LOGIN_MS` and `CODEX_CLIENT_INFO`.
- Produces:
  - `codexChildHome(env): { codexHome: string; home: string }`. It throws `McpSignInError` when `CODEX_HOME` isn't
    set. Both `startCodexSession` and the two calls below take `HOME` from it, so status, sign-in and sessions
    share one home.
  - `openCodexHome(deps, env, servers): Promise<{ call: CodexCall; threadId: string; close(): Promise<void> }>`.
    It is the one spawn path for status and sign-in, in this order:
    1. `ensureConfig()` before the spawn.
    2. `HOME` from `codexChildHome`.
    3. `initialize`.
    4. `thread/start { cwd: home, ephemeral: true, approvalPolicy: 'never', config: { mcp_servers: codexYourServers(servers) } }`.
  - `McpSignInSpec { kind; env; name; server: YourSessionServer }` and
    `McpAuthSpec { kind; env; servers: Readonly<Record<string, YourSessionServer>> }`.
  - `McpSignIn { outcome: Promise<{ ok: true } | { ok: false; message: string }>; reopen(): Promise<void>; cancel(): Promise<void> }`.
  - `startMcpSignIn(spec): Promise<McpSignIn>` and `mcpAuthStatus(spec): Promise<Readonly<Record<string, McpAuthState>>>`.
    The Claude adapter throws `McpSignInUnsupportedError` and answers `{}`.
  - `openPage(url): Promise<void>` defaults to `execFile('/usr/bin/open', [url])` and is injected in tests.
  - `codexYourServers` maps `claudeOAuth` into Codex's keys:
    - `clientId` goes to `oauth.client_id`.
    - `callbackPort` goes to `oauth.callback_port`.
    - `scopes` becomes `scopes`, split on whitespace.
    - `authServerMetadataUrl` and `xaa` have no Codex key and are left out. Settings says so (Task 7), and a
      follow-up is filed (Task 9).
    - `clientRegistration` in the login params stays unset (`auto`).

- [ ] **Step 1: Write the failing tests.**
  - `codex-your-servers.test.ts`: a row with `claudeOAuth: { clientId: 'x', callbackPort: 9000, scopes: 'read write', xaa: true }`
    gives `oauth: { client_id: 'x', callback_port: 9000 }` and `scopes: ['read', 'write']`, with no `xaa`.
  - `codex-session.test.ts`: the spawned `HOME` equals `codexChildHome(env).home`.
  - `codex-mcp-sign-in.test.ts`, on the fake child (the `codex-connect.test.ts` pattern):
    - **Same home as sessions.**
      - The env is the spec's env plus `HOME` from `codexChildHome`.
      - `ensureConfig` runs before the spawn.
      - A spec with no `CODEX_HOME` rejects before any spawn.
    - **Login call.**
      - `thread/start` carries exactly the one server, through `codexYourServers`.
      - Then `mcpServer/oauth/login { name, threadId, timeoutSecs: LOGIN_MS / 1000 }`.
      - Then `openPage` is called once, with the url.
    - **Completion matching.**
      - A completion counts when `name` and `threadId` match, and `loginId` too when both sides carry one.
      - A completion for another thread is ignored.
      - A response without `loginId` and a matching completion with one give `{ ok: true }`.
    - **Failures.**
      - A failed completion gives "The sign-in didn't finish. Try Sign in again."
      - A `PORT_IN_USE` error gives "Codex could not listen for the sign-in on its callback port: another program
        is using it. Close it and try Sign in again."
      - `LOGIN_MS` on the fake clock fails the same way as a failed completion.
      - Each failure closes the child.
    - **Page checks.**
      - A url that isn't plain https (http, userinfo, or not a URL) is never opened, and the child is closed.
      - `reopen` opens the same url again.
    - **Status.** `mcpAuthStatus` runs one `openCodexHome` with every given server and `readCodexMcpAuth`, then
      closes.
  - `routed-adapter.test.ts`: both methods are routed by kind.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Mirror `startCodexLogin`: early completions are buffered, the start has its own deadline, and a settle lands
    only once the process is gone.
  - Neither the child's output nor the url is ever logged or put in an error.
  - `FakeAdapter` keeps sign-ins in memory, through `completeMcpSignIn(name, ok)` and a per-name `mcpAuth`.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): the codex adapter signs an mcp server in with codex's own login`. Value
  card:
  - `protects=` a Codex sign-in and status read run in the session's home, on the session's server config, and
    always close their process.
  - `fails_when=` the home or config differs, a completion is mismatched, the page opens unchecked, or a timeout
    leaves the child.
  - `why_new=` the account login covers ChatGPT sign-in only.
  - `no_claim=` that the IdP's page works (Task 8 L4).

### Task 6: Settings' sign-in rows and routes

**Files:**

- Modify:
  - `packages/contracts/src/your-mcp.ts`: `McpSignInState`, `McpSignInRowDto`, `McpSignInTerminalDto`,
    `McpSignInsDto` and `StartMcpSignIn`.
  - `packages/contracts/src/events.ts`: `EventType.McpSignInChanged: 'mcp_sign_in.changed'` and
    `McpSignInChangedData`.
  - `src/json-schema.ts`, then regenerate.
- Create: `apps/daemon/src/accounts/mcp-sign-ins.ts`.
- Modify: `environment/launch.ts` (`claudeMcpSignInCommand`), `accounts/index.ts`, `api/services.ts`,
  `api/app.ts`, `daemon/trust-services.ts` and `daemon/start.ts` (wiring, and `stopAll` on shutdown).
- Test: `accounts/mcp-sign-ins.test.ts`, `api/app.test.ts` and `environment/launch.test.ts`.

**Interfaces:**

- Consumes: `startMcpSignIn` and `mcpAuthStatus` (Task 5), `readYourMcpConfig`, `planYourMcp`, `appTrustSwitches`,
  `mcpApprovals` and `Launcher.probe`.
- Produces:
  - `McpSignInState` is an `as const` object: `{ SignedIn: 'signed_in', NotSignedIn: 'not_signed_in',
    SigningIn: 'signing_in', Failed: 'failed', Unknown: 'unknown' }`.
  - `McpSignInRowDto { accountId: AccountId, accountLabel, key: YourMcpServerKey, name, state, message: string | null }`.
  - `McpSignInTerminalDto { accountId: AccountId, accountLabel, command: string }`.
  - `McpSignInsDto { rows, terminal }` and `StartMcpSignIn { accountId: AccountId, key: YourMcpServerKey }`.
  - `McpSignInChangedData { accountId, key, state }`. Entity `mcp_sign_in`. It never carries a url.
  - `GET /settings/trust/mcp-sign-ins` answers `McpSignInsDto`. `POST` with `StartMcpSignIn` answers
    `McpSignInsDto`; 404 for an unknown account or key; 409 for an account that isn't Codex or has no folder.
  - `claudeMcpSignInCommand(configDir): string` is `CLAUDE_CONFIG_DIR=<quoted dir> claude`.
  - `createMcpSignIns(deps)` returns `{ list(); start(input); stopAll() }`, each a `Promise`.

**What the rows hold.** Candidates are the servers `planYourMcp` plans on app switches whose remote plan has
`headers === null`.

- **`rows`.** One per (non-archived Codex account, candidate).
  - State comes from `mcpAuthStatus` with `SIGN_IN_STATUS_MS = 15_000` per account, run in parallel.
  - A timeout or an error gives `unknown` with "Couldn't read whether it's signed in."
  - The status is cached 60 s per account and dropped when a slot ends.
  - `NotOAuth` servers are left out.
  - An account the launcher refuses gives `unknown` with the refusal's message.
- **`terminal`.** One entry per own-folder subscription account, present only when at least one candidate exists.

- [ ] **Step 1: Write the failing tests.** `mcp-sign-ins.test.ts`, on real SQLite in a temp dir with `FakeAdapter`:
  - **Rows and candidates.**
    - A Codex account and an approved headerless server give a `not_signed_in` row.
    - A header server gives no row, and neither does a server reading `not_oauth`.
    - A status that never answers gives `unknown` at `SIGN_IN_STATUS_MS` on the fake clock.
  - **Sign-in flow.**
    - `start` gives `signing_in` and an event.
    - `completeMcpSignIn(ok)` gives `signed_in` and an event.
    - A failure gives `failed` with its message, and an event.
    - `stopAll` cancels every slot, and each sends an event.
    - A second `start` calls `reopen` and never `startMcpSignIn`.
    - After a failure, `start` goes back to `signing_in`.
    - No event data holds a url.
  - **Restart.** A new service on the same database has no slot, and reads the status again.
  - **Terminal entries.**
    - An own-folder subscription gives one terminal entry with `claudeMcpSignInCommand(dir)`.
    - The default account gives none, on either kind of folder.
    - With no candidate there are none at all.
  - **Routes.** `app.test.ts`, through `app.request`: the GET and POST contracts parse with their schemas, and
    the 404 and 409 cases answer as above.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.**
  - Slots are kept in memory only.
  - The env is `Launcher.probe(account).env`.
- [ ] **Step 4: Run the related tests, typecheck, lint and contracts generate.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(daemon): settings lists and starts mcp sign-ins for each account`. Value card:
  - `protects=` each Codex account × OAuth server reads true, signs in one at a time, says when it can't tell, and
    recovers after a restart.
  - `fails_when=` a second click starts a second process, a failure sticks or sends no event, a slow status hangs
    Settings, or a restart leaves a phantom slot.
  - `why_new=` no sign-in service existed.
  - `no_claim=` that the window shows it (Task 7).

### Task 7: Settings › Trust shows Sign in

**Files:**

- Modify: `apps/desktop/src/daemon/trust-queries.ts` (`useMcpSignIns`, `useStartMcpSignIn`) and
  `src/daemon/events.ts` (`INVALIDATIONS` for `McpSignInChanged`).
- Modify: `src/views/settings/your-mcp-servers.tsx`, `trust-rows.ts` and `views/settings/AGENTS.md`.
- Test: `src/views/settings/your-mcp-servers.test.tsx`.

**Copy:**

- **One line per row** under each server, `<account>: ` then:
  - Signed in: "Signed in".
  - Not signed in: "Not signed in", with **Sign in**.
  - Signing in: "Signing in in your browser…", with **Open page again**.
  - Failed: the message in red, with **Sign in**.
  - Unknown: "Couldn't read whether it's signed in.", with **Sign in**.
- **Terminal entries** go once, at the foot of the card, per account: "To sign <account> in to a server that signs
  in with OAuth, run:", then the command in a `Code` block with a `CopyButton`, then "Then run /mcp and sign in."
- **`ServerText`** shows "Signs in with OAuth: clientId=…" from `oauth`. When `oauth` holds
  `authServerMetadataUrl` or `xaa`, it adds "Codex sessions don't use: authServerMetadataUrl, xaa".
- **The approve modal's no-headers line** becomes "It sends no headers. If it signs in with OAuth, sign it in as
  each agent does: in Claude Code, or below for a Codex account."
- **`trust-rows.ts`, `yourMcpServers.providers`** becomes: "Claude and Codex sessions both get every approved
  server. Tool filters from config.toml apply in Codex sessions only. Servers that sign in with OAuth use the
  sign-in Claude Code or Codex keeps. On a Gateway account they don't run yet. Sessions on a Claude plan also get
  your claude.ai connectors. API key, Bedrock and Codex sessions don't, yet."

- [ ] **Step 1: Write the failing tests.** In `your-mcp-servers.test.tsx` (MSW):
  - A table over the five row states renders the copy above.
  - Sign in posts `{ accountId, key }`, and so does Open page again.
  - The terminal entry renders once, with its command.
  - An `mcp_sign_in.changed` event refetches the rows.
  - The Codex-unused line shows only when the block holds `xaa` or `authServerMetadataUrl`.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/desktop exec vitest run src/views/settings`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Use Mantine components and tokens only (`DESIGN.md`), and check dark and light.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): settings › trust signs a codex account in to an oauth server`. Value
  card:
  - `protects=` the builder sees each account's sign-in state and can start one.
  - `fails_when=` a state renders wrong, or a click posts the wrong pair.
  - `why_new=` the view had no sign-in rows.
  - `no_claim=` the browser hand-off (Task 8).

### Task 8: Live rows per provider, and the token stores stay unreadable

**Files:**

- Modify: `apps/daemon/test/your-mcp-probe.ts`. `laneProbeScript(filesRoot, opts: { home: string; tokenFiles:
  readonly string[] } = …)` adds probes that print only `ok` or `denied`:
  - `KEYCHAINS`: `ls '<home>/Library/Keychains' >/dev/null 2>&1`, with `home` the real home path, never `~`.
  - `SECURITY_CLAUDE`:
    `/usr/bin/security find-generic-password -s 'Claude Code-credentials' '<home>/Library/Keychains/login.keychain-db' >/dev/null 2>&1`.
    This is an attribute lookup with its output discarded, never `-w` or `-g`.
  - `SECURITY_CODEX`: the same, with `-s 'Codex MCP Credentials'`.
  - `TOKEN_FILE`: `head -c1 '<file>' >/dev/null 2>&1`, once for each token file.

  `PROBES_HELD` adds `KEYCHAINS=denied`, `SECURITY_CLAUDE=denied`, `SECURITY_CODEX=denied` and `TOKEN_FILE=denied`.
- Modify: `test/lane-sandbox.live.test.ts`, `test/codex.live.test.ts`, `src/env.ts` and `.env.example`
  (`TENDB_LIVE_API_KEY`, `TENDB_LIVE_OAUTH_SERVER`).
- Run, not commit: the click-through.

**Rows.** They are manual and never run in CI. Each prints what it observed through `TENDB_LIVE_REPORT`.

**Folders.** L1's data directory, and so its `<dataDir>/connector-probe`, sits outside any checkout and outside the
OS temp dir, in a fresh `~/Library/Caches/10db-live-<id>` removed afterwards: the connector probe refuses to start
under a `.mcp.json`, and the repo's own sits above `homeOutsideTemp`. The folder is checked for a `.mcp.json` above
it. The parent `.mcp.json` row plants its file in that folder, between the data directory and home, never in home.

- **L0 Probe lines mean something.** Run each new probe line once outside any sandbox, and see `ok` for the
  keychain lines and for a planted canary token file.
- **L1 Claude plan, default folder** (`TENDB_LIVE_CLAUDE=1`).
  - A sandboxed lane with the builder's signed-in OAuth server (`TENDB_LIVE_OAUTH_SERVER`) connects and lists its
    tools.
  - The lane gets its claude.ai connectors with status `connected`.
  - The probe's status held only `scope: 'claudeai'`, and `probeRoot` is empty afterwards.
  - No `Claude Code-credentials-<sha256(freshDir)[:8]>` entry exists (attribute lookup only).
  - The lane's probes hold.
  - **Parent `.mcp.json`.** Plant a `.mcp.json` in a parent of the probe's cwd that names a stand-in stdio server
    which would write a marker file. The probe is refused, the session says "your claude.ai connectors didn't load
    in this session", and the marker file does not exist. Repeat with the marker server in
    `/Library/Application Support/ClaudeCode/managed-mcp.json` only if the builder's Mac has that folder writable;
    otherwise the unit row stands for it.
  - **Stale needs-auth cache.** Seed the account's `mcp-needs-auth-cache.json` naming a server that has since been
    signed in. The session connects the server (the cache is removed before it starts), on a plan account and on a
    keyed one.
- **L2 API key** (`TENDB_LIVE_API_KEY=1`, `ANTHROPIC_API_KEY`, the account folder from `homeOutsideTemp`). In order:
  1. **Show that the shared entry holds a plan login.** On a fresh folder, with `CLAUDE_SECURESTORAGE_CONFIG_DIR`
     set as Task 2 sets it and no key, `claude auth status --json` reports a claude.ai subscription. It reports
     no token. If it doesn't, the row stops as inconclusive.
  2. **Run the session.**
     - The same server connects.
     - The preflight's `checkAccount` passes against a confirmed `expectedIdentity`, the key's.
     - `init` reports `apiKeySource: 'ANTHROPIC_API_KEY'`.
     - No connector is passed.
  3. **Check the folder.** After the session and one `Launcher.probe` run, the account folder's `.claude.json`
     has no `oauthAccount` key. Only key names are read.
  4. The lane's probes hold.
  5. **Keyed accountInfo and refresh.** The keyed session's `accountInfo` and `Launcher.probe` report the key's
     organization, not the plan's. Then refresh the plan login while a keyed session and a connector probe, each on
     its own `CLAUDE_CONFIG_DIR`, share the one keychain item: note whether either loses its login, and record it in
     the PR.
- **L3 Bedrock** (`TENDB_LIVE_BEDROCK=1`). Step 1 of L2 first. Then the same server connects, `checkAccount`
  passes, the account reads `apiProvider: 'bedrock'`, there is no `oauthAccount`, and the probes hold.
- **L4 Codex** (`TENDB_LIVE_CODEX=1`). The account's `configDir` is under the test daemon's data directory
  (`homeOutsideTemp`), so the lane's protected reads deny it.
  - `mcpAuthStatus` reads `not_signed_in`.
  - `startMcpSignIn`, with an `openPage` that records, gives an https url on the server's host.
  - `cancel` closes the child.
  - A Codex lane runs every probe line, with the real home and a canary `.credentials.json` planted in that
    `configDir`, and all of them hold.
- **Click-through**, on `pnpm dev`. First seed an own-folder subscription account in the dev data, so the
  terminal entry shows.
  - Drive Settings › Trust with `/browse` up to Sign in, for a connected Codex account. The builder approves in
    the browser.
  - The row reads Signed in, and a Codex lane then lists the server's tool. `test -f <home>/.credentials.json`
    holds; the file is never read.
  - The terminal entry shows its command.
  - Check both in dark and light.

- [ ] **Step 1:** Extend the probe helpers and add the rows. Run L0, then each row with its switch, and see it
  pass.
- [ ] **Step 2:** Do the click-through, and record the results in the PR.
- [ ] **Step 3: Commit** `test(daemon): live rows for oauth mcp servers on every account kind`. Value card:
  - `protects=` each provider connects a signed-in server as its own account, and no lane reads a token store.
  - `fails_when=` a keyed session bills the plan, the probe loads other servers, or a lane shell reaches the
    keychain or a credentials file.
  - `why_new=` T6's live rows had no OAuth server and no token store.
  - `no_claim=` CI coverage (the rows are manual).

### Task 9: Docs, decisions and follow-ups

**Files:**

- Create: `docs/architecture/decisions/2026-11-14-mcp-sign-ins-stay-in-each-agents-own-store.md` (**Amends:**
  decision 105). It records:
  - API-key and Bedrock accounts read the builder's entry through `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
    - Those sessions may also refresh the plan's stored login (`claudeAiOauth`), as the builder's own Claude Code
      does.
    - Gateway is left out until it is proven safe.
  - Codex accounts use the file store in their home, and sign in from Settings with Codex's own login.
  - 10db never touches a token.
  - Why: the alternatives were copying tokens, or signing in again per account.
- Create: `docs/architecture/decisions/2026-11-14-claude-ai-connectors-are-relayed-under-strict-mcp-config.md`. It
  records:
  - The probe, the relay and the switch.
  - The probe's stop on any non-connector entry, and the `managed-mcp.json` risk.
  - Why `strictMcpConfig` stays on: dropping it would load `~/.claude.json`'s user and local servers outside the
    approval and the launch, and the project's `.mcp.json` outside `srt`.
- Modify, a line or two each: `apps/daemon/src/session-setup/AGENTS.md`, `sessions/AGENTS.md`,
  `environment/AGENTS.md`, `accounts/AGENTS.md`, `apps/desktop/src/views/settings/AGENTS.md` and
  `docs/architecture/03-trust-boundaries.md` §4.6.
- File follow-up tasks with the `10db-task` skill, one each:
  1. OAuth MCP servers on Gateway accounts. Prove the plan's bearer never reaches `ANTHROPIC_BASE_URL`, or sign in
     per account.
  2. Connectors on Codex sessions (Codex's apps) and on API-key and Bedrock accounts.
  3. Codex's missing OAuth fields: `authServerMetadataUrl` and `xaa` have no mapping, and `config.toml`'s own
     `oauth`, `scopes` and `oauth_resource` keys aren't read.

- [ ] **Step 1:** Write the docs, citing decisions by path, and file the three tasks.
- [ ] **Step 2:** Run `pnpm --filter @10db/repo-checks exec vitest run` for the docs rules (cited paths, no
  `CLAUDE.md`). Expected: PASS.
- [ ] **Step 3: Commit** `docs: oauth mcp servers and claude.ai connectors in 10db sessions`.

### Task 10: Adversarial review

- [ ] **Round 1.** Dispatch `code-reviewer` (opus) on the branch from `origin/main` (base `f528d6c4`), with this
  plan and Tasks 1–9. Round 1 lists every finding. It hunts for:
  - A token read or logged, or any `-w` or `-g`.
  - A keyed session that could run on the plan login.
  - Gateway getting the shared entry.
  - The probe loading anything but connectors, or leaving folders behind.
  - A sign-in process left running.
  - A status read on another home.
  - A page opened without the https check.
  - Connectors reaching a session with the switch off.
- [ ] **Fix and finish.**
  - Fix the blocking findings in one commit.
  - Round 2 checks those findings only, at most two rounds.
  - Then run `make gate` once, and open the PR titled
    `feat: oauth mcp servers and claude.ai connectors run in 10db sessions as claude code and codex run them`.
