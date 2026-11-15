# OAuth MCP Servers in 10db Sessions: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

## Brief for the builder

**What changes for you.** Your MCP servers that sign in with OAuth work in 10db sessions the way they work in
Claude Code and Codex:

- **Claude plan.** OAuth servers already connected on Claude Code's default folder. An entry with an `oauth`
  block (a fixed client id or callback port) is no longer refused. Your claude.ai connectors (Gmail, Linear,
  Drive…) now come into sessions, as they do in Claude Code. The project's "Your MCP servers" switch turns them
  off too.
- **Claude API key and Bedrock.** These sessions use the sign-ins your own Claude Code keeps, as Claude Code does
  when you switch it to Bedrock in its default folder. Nothing to sign in again.
- **Codex.** Settings › Trust shows **Sign in** next to an OAuth server, for each Codex account that isn't signed
  in. It runs Codex's own sign-in in that account's folder and opens your browser. A session whose server still
  isn't signed in says "sign in in Settings › Trust".
- **A Claude plan account on its own folder** (you have none today). Settings shows the terminal command that
  signs it in: `CLAUDE_CONFIG_DIR=<dir> claude`, then `/mcp`.

**What it buys.** Linear, Notion and the claude.ai connectors in lanes, Plan and chats, on every account kind,
with no tokens handled by 10db.

**What could go wrong, and how we'd know.**

- An API-key or Bedrock session now meets your plan login in the shared keychain entry. If Claude Code ever
  preferred that login over the key, the session would bill your plan. 10db's identity check already refuses a
  session whose credentials differ from its account's. The live rows in Task 8 run one API-key and one Bedrock
  session and check that each runs as its account.
- Connectors are read by a short Claude Code start with no prompt (about 2 s, cached for 10 minutes per account).
  If it fails, the session starts without connectors and its first message says so.
- A connector's tools can send mail or change files. They take the same guard and judge path as your other
  servers, never an allow rule.
- Parallel sessions refresh one keychain entry, as parallel Claude Code sessions do (accepted).

**Calls you might disagree with.**

- Codex accounts keep MCP tokens in a file in the account's own folder (`mcp_oauth_credentials_store = "file"`).
  10db already gives Codex an empty home, and with that home Codex can't reach the keychain. Codex's own
  fallback would land in the same file, so the setting only makes that choice explicit.
- 10db opens the sign-in page itself, with `/usr/bin/open`. Handing it to the window instead would mean letting
  the window open any https page.
- Gateway accounts get the API-key treatment.
- No sign-in status for Claude accounts in Settings. A session that finds a server signed out says where to sign
  in.
- Codex's own connectors (`features.apps`) stay off, as today. They are not part of this run.

**What I need from you.** Two live runs that I can't do: an API key and the Bedrock variables for Task 8's
identity rows, and one browser approval for Task 8's Codex sign-in click-through.

---

**Goal:** OAuth MCP servers and claude.ai connectors run in 10db sessions as Claude Code and Codex run them, on
every account kind, with no token read, copied or stored by 10db.

**Architecture:** Each agent keeps its own token store. Claude's keyed accounts point Claude Code's keychain
lookup at the builder's own entry (`CLAUDE_SECURESTORAGE_CONFIG_DIR`). Plan accounts get their claude.ai
connectors through a probe: a no-prompt, non-strict Claude Code start on a fresh config folder that reads the
account's keychain entry. The probe lists the connectors, and the session passes them back as explicit
`claudeai-proxy` entries, so `strictMcpConfig` stays on. Codex signs in through its app-server
(`mcpServer/oauth/login` on an ephemeral thread that carries one server) in the account's own home, behind a
Settings › Trust row.

**Tech Stack:** TypeScript, zod 4.6.7, `@anthropic-ai/claude-agent-sdk` 0.3.316 on Claude Code 2.1.302
(`CLAUDE_CODE_VERIFIED_ON`), Codex 0.167.0 app-server (`CODEX_VERIFIED_ON`), Vitest, Mantine 9.8.

**Spec:** the brief `~/Agents/notes/10db/oauth-mcp-run/plan-brief.md` and research
`~/Agents/notes/10db/oauth-mcp-run/research.md`. Shape follows
`docs/superpowers/plans/2026-11-12-10db-trust-t6-your-mcp-servers.md`.

## Per provider

| Account                       | An OAuth server's token                                                                      | claude.ai connectors                                                                    | A server not signed in: the session note                                                     | Signs in where                                                           |
| ----------------------------- | -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Claude plan, default folder   | the builder's keychain entry `Claude Code-credentials` (no change: it already connects)      | relayed from the probe (Task 3)                                                         | "sign in to it in Claude Code: run `claude`, then `/mcp`"                                    | the builder's own Claude Code                                            |
| Claude plan, its own folder   | that folder's entry `Claude Code-credentials-<h>`                                            | relayed from the probe, on that folder's entry                                          | "sign in for this account: Settings › Trust shows how"                                       | terminal: `CLAUDE_CONFIG_DIR=<dir> claude`, then `/mcp` (Settings shows) |
| Claude API key (and Gateway)  | the builder's entry, through `CLAUDE_SECURESTORAGE_CONFIG_DIR` (Task 2)                      | none: Claude Code offers none without a claude.ai login. Settings' row note says so     | as the default folder                                                                        | the builder's own Claude Code                                            |
| Claude Bedrock                | as API key                                                                                   | none: Claude Code disables them on third-party providers. Settings' row note says so    | as the default folder                                                                        | the builder's own Claude Code                                            |
| Codex (ChatGPT plan)          | `$CODEX_HOME/.credentials.json` in the account's home, file store (Task 4)                   | not applicable; Codex's apps stay off (`features.apps: false`)                          | "sign in in Settings › Trust"                                                                | Settings › Trust › Sign in (Task 5–7)                                    |

"The builder's entry" is the one the builder's own Claude Code uses: `CLAUDE_SECURESTORAGE_CONFIG_DIR` is the
login shell's absolute `CLAUDE_CONFIG_DIR` (`Launcher.loginConfigDir()`), or empty for Claude Code's default
folder.

## Verified while planning (2026-11-14, pinned CLIs, no prompt sent)

Spike scripts: `~/Agents/notes/10db/oauth-mcp-run/spikes/`. Rerun them in Task 0 if a pin moved.

- **Strict hides connectors.** A strict session's `mcpServerStatus()` lists no claude.ai entries.
- **The fresh-folder probe works.** A non-strict session with `settingSources: []`, a scratch cwd, a fresh empty
  `CLAUDE_CONFIG_DIR` and `CLAUDE_SECURESTORAGE_CONFIG_DIR=` (empty) does three things:
  - It lists all 8 connectors within 2 s, each with `scope: 'claudeai'` and
    `config: { type: 'claudeai-proxy', url, id }`. Nothing else loads.
  - It creates no keychain entry for the scratch folder (attribute lookup).
  - It writes only `.claude.json`, `backups/` and `sessions/` in that folder.
  (`fresh-dir.mjs`)
- **Relaying them works.** A strict session given those entries through `setMcpServers` connects all 8, with
  `scope: 'dynamic'` and no errors (`relay.mjs`). The SDK's `setMcpServers` type omits
  `McpClaudeAIProxyServerConfig`. The CLI accepts it anyway.
- **The CLI already reads `oauth`.** Claude Code 2.1.302's http and sse config schema takes
  `oauth: { clientId?, callbackPort?, authServerMetadataUrl? (https), scopes? (string), xaa? (boolean) }`. The
  SDK's `McpHttpServerConfig` type lacks the field. The keychain entry's key hashes `{type,url,headers}` only.
- **Codex needs a thread to sign in.** `mcpServer/oauth/login` without `threadId` fails with "No MCP server named
  … found". On an app-server whose home is not signed in to ChatGPT, these work (`codex-oauth.mjs`):
  - `thread/start { ephemeral: true, config: { mcp_servers: { <name>: { url } } } }` succeeds.
  - `mcpServerStatus/list { threadId, detail: 'toolsAndAuthOnly' }` answers `authStatus: 'notLoggedIn'`.
  - `mcpServer/oauth/login { name, threadId, timeoutSecs }` answers an https `authorizationUrl` on the server's
    host, and a `loginId`.
- **Codex's other shapes.** `McpAuthStatus = 'unknown' | 'unsupported' | 'notLoggedIn' | 'bearerToken' | 'oAuth'`.
  `McpServerOauthLoginResponse = { authorizationUrl, loginId? }`. `ListMcpServerStatusResponse = { data, nextCursor }`.
- **No sign-in method in the SDK.** The SDK has no public way to start a Claude MCP sign-in. `mcp_authenticate`
  exists only as a private control subtype. So a Claude plan account on its own folder gets the terminal command
  (brief decision 4).

## Global Constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/contracts/AGENTS.md`, and the
  `AGENTS.md` of each module touched (`session-setup`, `sessions`, `environment`, `accounts`, `trust`,
  `views/settings`). `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- Branch `feat/oauth-mcp` in `~/Projects/10db-worktrees/oauth-mcp`. Tasks run in order, one commit per task.
  - Commits are Conventional Commits. Name every path: `git add a b && git commit -m '...'`, with a single-quoted
    `-m`.
  - Each commit ends with `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
  - Each newly tested behavior gets one value card in its commit. A new row in an existing table needs none.
- **No token, ever.**
  - 10db never reads, copies, logs or stores an MCP token, a keychain entry's data or a `.credentials.json`.
  - No `security … -w` or `-g`, no read of `mcp-needs-auth-cache.json`'s contents. Task 2 deletes that file; it
    never reads it.
  - The connector `url`/`id` and Codex's `authorizationUrl` are not secrets, but they are never logged or put in
    the database either.
- Only `environment/launch.ts` names `CLAUDE_SECURESTORAGE_CONFIG_DIR` and `CLAUDE_CONFIG_DIR`. Other modules call
  its exports.
- `strictMcpConfig: true` stays on every Claude session. Only the connector probe runs non-strict. It runs on a
  fresh config folder under the data directory, with `settingSources: []`, no prompt, and an empty cwd that no
  lane can write.
- Every daemon test runs on the fake SDK `query`, the fake Codex child or `FakeAdapter`. Only `*.live.test.ts`
  runs a real CLI. Probe homes in live rows use `homeOutsideTemp` (`apps/daemon/test/fixtures.ts`).
- Copy: Note from 10db lines end "It is not in this session; don't look for its tools." as today.

## Review Focus

1. **A keyed session that bills the plan.** An API-key session with `CLAUDE_SECURESTORAGE_CONFIG_DIR=` reports
   `apiKeySource: 'ANTHROPIC_API_KEY'`, and a Bedrock one `apiProvider: 'bedrock'`; anything else is refused by
   `checkInitCredentials`. Task 8 rows L2 and L3.
2. **The login shell sets its own `CLAUDE_SECURESTORAGE_CONFIG_DIR`.** It is stripped like a billing switch, so a
   plan account on its own folder never reads another folder's login. Task 2 row in `session-env.test.ts`.
3. **The switch turns connectors off.** With the project's Your MCP servers off (app or override), no
   `claudeai-proxy` entry is passed and the probe never runs. Task 3 row in `runner.test.ts`.
4. **A connector name that collides with a configured server.** A connector whose tool prefix
   (`claude_ai_<Name>`) equals a project or builder server name is left out; the configured one wins. Task 3 row
   in `claude-connectors.test.ts`.
5. **A sign-in the builder abandons.** It ends `failed` at the deadline, the app-server child is closed, and a
   new click starts afresh. A daemon restart leaves no slot behind and reads the status again. Task 5 and Task 6
   rows.

---

## Codex sign-in: state × event

States per (Codex account, server): **not signed in** (`authStatus` `notLoggedIn`), **signing in** (a slot in
memory), **signed in** (`oAuth`), **failed** (the last attempt's message, in memory). An expired token that
Codex can't refresh reads `notLoggedIn`, so it shows as not signed in.

| Event                              | Not signed in                                                                 | Signing in                                                                     | Signed in                       | Failed                                    |
| ---------------------------------- | ----------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------- | ----------------------------------------- |
| Builder clicks Sign in             | → signing in: app-server, ephemeral thread, login, `/usr/bin/open` the page   | stays: the same page opens again (`reopen`), no second process                 | no button                       | → signing in, as from not signed in       |
| Browser completes                  | n/a                                                                           | → signed in: status read again, event sent, child closed                        | n/a                             | n/a                                       |
| Abandoned, or `LOGIN_MS` passes    | n/a                                                                           | → failed "The sign-in didn't finish. Try Sign in again.", child closed          | n/a                             | stays                                     |
| A second click (another server)    | its own slot; slots are per (account, server)                                 | unaffected                                                                     | unaffected                      | unaffected                                |
| Daemon restart mid-login           | stays                                                                         | child ends with the daemon; after restart: status read → not signed in, or signed in if Codex wrote the token first | stays                           | → as status reads (memory gone)           |
| A session starts                   | runs without the server; note "sign in in Settings › Trust"                   | as not signed in; the next session after completion gets the server            | server connects                 | as not signed in                          |
| Token expires mid-session          | n/a                                                                           | n/a                                                                            | Codex refreshes it (per-home lock); if it can't, calls fail in that session and the next status read shows not signed in | n/a |

---

### Task 0: Confirm the starting point

**Files:** none (no commit).

- [ ] **Step 1:** Check that `CLAUDE_CODE_VERIFIED_ON` is `2.1.302` and `CODEX_VERIFIED_ON` is `0.167.0`
  (`apps/daemon/src/environment/agent-pins.ts`). If either moved, rerun the three spike scripts against the new
  pins (`node <script> <args>`, the arguments each script's first lines read) and stop if any result above
  differs.
- [ ] **Step 2:** Confirm these names exist as used below:
  - `refusalOf`, `parseClaudeEntry` and `DeclaredYourServer` (`session-setup/your-mcp-entry.ts`).
  - `yourMcpConfigHash` (`your-mcp-hash.ts`) and `YourRemotePlan` and `planYourMcp` (`your-mcp-plan.ts`).
  - `YourSessionServer` (`sessions/types.ts`), `buildMcpServers` and `yourServersNote`
    (`sessions/claude-session.ts`), and `toSdkMcpServer` (`sessions/claude-mapping.ts`).
  - `createLauncher` (`environment/launch.ts`) and `BILLING_SWITCH_VARS` (`environment/session-env.ts`).
  - `codexYourServers` (`sessions/codex-your-servers.ts`), `template` (`sessions/codex-home.ts`) and
    `startCodexLogin` (`sessions/codex-connect.ts`).
  - `CODEX_SEED_TYPES` (`scripts/codex-generate.ts`).
  - `TrustPolicyInput` (`trust/policy.ts`) and `YourMcpServers` (`desktop/src/views/settings/your-mcp-servers.tsx`).
  Where a name moved, use the new one and list the mapping in the PR.

### Task 1: Claude takes an entry with an `oauth` block

**Files:**

- Modify: `apps/daemon/src/session-setup/your-mcp-entry.ts`, `your-mcp-hash.ts`, `your-mcp-plan.ts`,
  `your-mcp-dto.ts`
- Modify: `apps/daemon/src/sessions/types.ts`, `sessions/claude-session.ts` (`buildMcpServers`),
  `runner/runner.ts`, `daemon/shape-session-tools.ts`, `chat/hooks.ts`, `shape/explore-owner.ts`. These are
  the places that build a `YourSessionServer`; grep `codex: remote.codex` to find them.
- Modify: `packages/contracts/src/your-mcp.ts` (`YourMcpServerDto.oauth`), then regenerate
  `packages/contracts/generated/`
- Test: `session-setup/your-mcp-config.test.ts`, `your-mcp-hash.test.ts`, `your-mcp-dto.test.ts`,
  `sessions/claude-adapter.test.ts`

**Interfaces:**

- Produces:
  - `ClaudeOAuth` (zod `strictObject`) and `type ClaudeOAuth`, in `your-mcp-entry.ts`. Fields:
    `clientId?: string(min 1)`, `callbackPort?: int 1024–65535`, `authServerMetadataUrl?: https url`,
    `scopes?: string(min 1)` and `xaa?: boolean`.
  - `DeclaredYourServer` (remote) gains `readonly oauth: ClaudeOAuth | null`. It is always null for
    `config.toml`.
  - `YourRemotePlan.oauth: ClaudeOAuth | null` and `YourSessionServer.claudeOAuth: ClaudeOAuth | null`.
  - `YourMcpServerDto.oauth: McpConfigEntry[]`: the block's keys and values as text, `[]` when it has none.

- [ ] **Step 1: Write the failing tests.**
  - In `your-mcp-config.test.ts`, the `oauth` refusal row goes. Add an accepted row:
    `{ type: 'http', url: 'https://a.example', oauth: { clientId: 'x', callbackPort: 8080 } }` reads with
    `refusal: null` and `declared.oauth` equal to that block.
  - Add refusal rows `oauth: { clientSecret: 'x' }` and `oauth: { authServerMetadataUrl: 'http://a' }`. Each
    reads `It can't be read: oauth…`, naming the path and never the value.
  - In `your-mcp-hash.test.ts`: the same entry with and without `oauth` hashes differently, and the entry
    without it keeps the hash the existing row pins.
  - In `your-mcp-dto.test.ts`: `oauth` lists `clientId=x` and `callbackPort=8080`.
  - In `claude-adapter.test.ts`, extend the `setMcpServers` record test: a your-server with
    `claudeOAuth: { clientId: 'x' }` is passed as `{ type: 'http', url, oauth: { clientId: 'x' } }`. One with
    null has no `oauth` key.
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/session-setup src/sessions/claude-adapter.test.ts`. Expected:
  FAIL on the old refusal text and the missing `oauth`.
- [ ] **Step 3: Implement.**
  - Drop the `oauth` refusal in `refusalOf`, and parse `oauth` with `ClaudeOAuth` in `ClaudeRemote`.
  - Include `oauth` in the hashed object only when non-null, so existing approvals keep their hash.
  - `buildMcpServers` adds `oauth` to a your-server's remote config. Build it as a typed variable, not an object
    literal: `McpHttpServerConfig` has no `oauth` field, and the CLI reads it (verified above). No cast.
  - `headersHelper` stays refused.
- [ ] **Step 4: Run the related tests, typecheck and lint.**
  `pnpm --filter @10db/daemon exec vitest related <changed files> --run`,
  `pnpm --filter @10db/contracts generate`, `pnpm -r typecheck`, `pnpm exec eslint <changed files>`. Expected:
  PASS.
- [ ] **Step 5: Commit.** `feat(daemon): your mcp servers with an oauth block reach claude as claude code reads them`.
  Value card:
  `protects=an oauth entry is approved by its exact block and reaches Claude with it;`
  `fails_when=the block is dropped, refused, or left out of the hash;`
  `why_new=the refusal row only covered the refusal;`
  `no_claim=that a given IdP accepts the client id`.

### Task 2: Claude's keyed accounts read the builder's sign-ins; notes say where to sign in

**Files:**

- Modify: `apps/daemon/src/environment/launch.ts`, `environment/session-env.ts`, `environment/index.ts`
- Create: `apps/daemon/src/sessions/claude-auth-cache.ts`
- Modify: `sessions/claude-session.ts` (calls it before `query`; `yourServersNote`)
- Test: `environment/launch.test.ts`, `environment/session-env.test.ts`, `sessions/claude-auth-cache.test.ts`,
  `sessions/claude-adapter.test.ts`

**Interfaces:**

- Produces (from `environment`):
  - `launch.ts` `build()` sets `CLAUDE_SECURESTORAGE_CONFIG_DIR` on the `AnthropicApiKey`, `Bedrock` and
    `Gateway` kinds, to `loginConfigDir() ?? ''`.
  - `BILLING_SWITCH_VARS` gains `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
  - `staleNeedsAuthCache(env: Readonly<Record<string, string>>): string | null`: the path
    `<CLAUDE_CONFIG_DIR>/mcp-needs-auth-cache.json` when the env reads another folder's entry (both variables
    set), else null.
  - `McpSignInWhere` as const `{ BuildersClaudeCode: 'builders_claude_code', ThisAccount: 'this_account' }`.
  - `mcpSignInWhere(env): McpSignInWhere`: `ThisAccount` when `CLAUDE_CONFIG_DIR` is set and
    `CLAUDE_SECURESTORAGE_CONFIG_DIR` is not.
- Produces (from `sessions`): `removeStaleNeedsAuthCache(path: string): Promise<void>`. It unlinks the file and
  never reads it. It ignores `ENOENT`, and rejects with `NeedsAuthCacheError` (a typed `Error`) on anything but a
  regular file or a link (`lstat`).

- [ ] **Step 1: Write the failing tests.**
  - `launch.test.ts` "a session launch" table: the API key, Bedrock and Gateway rows add
    `CLAUDE_SECURESTORAGE_CONFIG_DIR: ''`.
    - A new row: with the login shell's `CLAUDE_CONFIG_DIR=/h/b/.claude-other`, an API key adds
      `CLAUDE_SECURESTORAGE_CONFIG_DIR: '/h/b/.claude-other'`.
    - The subscription rows list it in `absent`.
  - `session-env.test.ts`: a login env holding `CLAUDE_SECURESTORAGE_CONFIG_DIR=/x` loses it.
  - `claude-auth-cache.test.ts`, on a real temp dir, with three cases:
    - The file goes and a sibling stays.
    - A missing file is fine.
    - A directory at that name is left and the call rejects with `NeedsAuthCacheError`.
  - `claude-adapter.test.ts` `noteFor` gains an `env` argument. The existing OAuth row expects
    `oauthy isn't signed in. Sign in to it in Claude Code: run \`claude\`, then \`/mcp\`. It is not in this
    session; don't look for its tools.` A new row with `CLAUDE_CONFIG_DIR` only expects
    `oauthy isn't signed in for this account. Settings › Trust shows how to sign in. …`.
- [ ] **Step 2: Run them and watch them fail.**
  `pnpm --filter @10db/daemon exec vitest run src/environment src/sessions/claude-auth-cache.test.ts src/sessions/claude-adapter.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** The session calls `removeStaleNeedsAuthCache` on `staleNeedsAuthCache(spec.env)`
  before `query`. A failure is logged by its name only and the session goes on. `yourServersNote` takes the
  `McpSignInWhere`. Then update the comment above `build()`: a keyed session reads the builder's keychain entry,
  and runs as its key, which the identity check confirms.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(daemon): keyed claude accounts use the builder's own mcp sign-ins`. Value card:
  `protects=API key, Bedrock and Gateway sessions read the builder's MCP sign-ins and plan accounts never read another folder's;`
  `fails_when=the variable is missing, inherited from the login shell, or set on a subscription;`
  `why_new=launch rows covered only billing variables;`
  `no_claim=that Claude Code prefers the key over the shared login (Task 8 L2, L3)`.

### Task 3: claude.ai connectors come along on a Claude plan

**Files:**

- Create: `apps/daemon/src/sessions/claude-connectors.ts`
- Modify: `environment/launch.ts` (`Launcher.connectorProbe`), `sessions/claude-adapter.ts` (owns the directory),
  `sessions/claude-session.ts`, `sessions/types.ts` (`AgentSessionCore.claudeConnectors`)
- Modify: `session-setup/your-mcp-plan.ts` and `your-mcp-for-session.ts` (`YourMcpPlan.connectorsOn`),
  `trust/policy.ts`, and the four session builders from Task 1
- Test: `sessions/claude-connectors.test.ts`, `sessions/claude-adapter.test.ts`, `environment/launch.test.ts`,
  `trust/policy.test.ts`, `runner/runner.test.ts`

**Interfaces:**

- Produces:
  - `ClaudeConnector { name: string; url: string; id: string }`.
  - `connectorsFromStatus(status: unknown): ClaudeConnector[]`: the zod boundary. It keeps an entry with
    `scope: 'claudeai'` and `config: { type: 'claudeai-proxy', url: https, id: string(min 1) }` and drops the
    rest.
  - `Launcher.connectorProbe(account: AccountRow, freshDir: string): Record<string, string> | null`. For
    `ClaudeSubscription` it is the account's env with `CLAUDE_CONFIG_DIR=freshDir` and
    `CLAUDE_SECURESTORAGE_CONFIG_DIR=account.configDir ?? loginConfigDir() ?? ''`. Other kinds get null.
  - `createConnectorDirectory(deps: { query; claudePath; probeRoot: string; clock: Clock; logger })` returns
    `{ list(accountId, env): Promise<readonly ClaudeConnector[] | null> }`.
    - It caches per account for `CONNECTOR_TTL_MS = 600_000` and shares one probe across concurrent callers.
    - It answers null when the probe failed.
  - `AgentSessionCore.claudeConnectors: boolean`. Callers set it to `yours.connectorsOn && account.kind ===
    ClaudeSubscription`.
  - `TrustPolicyInput.claudeConnectors: boolean`.

- [ ] **Step 1: Write the failing tests.**
  - `claude-connectors.test.ts`. A pure table for `connectorsFromStatus`: claudeai-proxy kept, `scope: 'dynamic'`
    dropped, an http url dropped, a missing id dropped. A probe on the fake `query`, using a real temp dir and the
    fake clock, with four cases:
    - Options are `strictMcpConfig: false`, `settingSources: []`, cwd and `CLAUDE_CONFIG_DIR` fresh under
      `probeRoot`, and no prompt is ever yielded.
    - It polls `mcpServerStatus` every 500 ms until claudeai entries appear, or until `CONNECTOR_PROBE_MS = 10_000`
      passes and it returns `[]`.
    - It always calls `close()` and removes both folders.
    - Two `list` calls inside the TTL run one probe. After the TTL they run a second.
  - Collision row: a connector `claude.ai Gmail` is dropped when a configured server is named `claude_ai_Gmail`.
  - `claude-adapter.test.ts`: with `claudeConnectors: true` on a subscription, `setMcpServers` gets every
    connector as `{ type: 'claudeai-proxy', url, id }` next to the others. With false, or on a keyed spec, the
    directory is never called. When the directory answers null, the prompt carries
    `Note from 10db: your claude.ai connectors didn't load in this session.` A connector that reports
    `needs-auth` is named with `sign in to it on claude.ai`.
  - `launch.test.ts`: `connectorProbe` rows for the default account, an own-folder subscription and an API key
    (null).
  - `policy.test.ts`: `claudeConnectors: true` adds a line that names claude.ai connectors as the builder's own,
    outside the sandbox, judged per call.
  - `runner.test.ts`, beside "starts a lane with your approved servers…": the spec has `claudeConnectors: true`.
    With the project's Your MCP servers override off it is false.
- [ ] **Step 2: Run them and watch them fail.** `vitest run` on those files. Expected: FAIL.
- [ ] **Step 3: Implement.**
  - The probe's `probeRoot` is `<dataDir>/connector-probe`, made mode 700.
  - The session asks the directory before `setMcpServers`, within `MCP_STATUS_WAIT_MS`.
  - `buildMcpServers(spec, connectors)` writes the connectors after the builder's servers and before 10db's.
  - `toSdkConnector` holds the one `as McpServerConfig` cast. Its comment says the SDK type omits
    `McpClaudeAIProxyServerConfig`, which the CLI accepts over `mcp_set_servers`, and that the value was
    validated by `connectorsFromStatus`.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(daemon): claude plan sessions get the account's claude.ai connectors`. Value card:
  `protects=a plan session gets its connectors, under the Your MCP servers switch, with strict MCP config kept;`
  `fails_when=the probe leaks other servers, skips cleanup, runs with the switch off or on a keyed account;`
  `why_new=nothing passed connectors before;`
  `no_claim=that claude.ai keeps the proxy entry shape (Task 8 L1)`.

### Task 4: Codex keeps MCP tokens in the account home, and its session says to sign in

**Files:**

- Modify: `apps/daemon/src/sessions/codex-home.ts` (`template`: `mcp_oauth_credentials_store: 'file'`)
- Modify: `sessions/codex-session.ts` (status read after `thread/start`), `scripts/codex-generate.ts`
  (`CODEX_SEED_TYPES` += `v2/ListMcpServerStatusResponse`, `v2/McpServerOauthLoginResponse`), then regenerate
  `src/sessions/codex-generated/` with `pnpm --filter @10db/daemon generate:codex`
- Create: `sessions/codex-mcp-auth.ts`
- Test: `sessions/codex-home.test.ts`, `sessions/codex-session.test.ts`, `sessions/codex-mcp-auth.test.ts`

**Interfaces:**

- Produces:
  - `McpAuthState` as const `{ SignedIn: 'signed_in', NotSignedIn: 'not_signed_in', NotOAuth: 'not_oauth',
    Unknown: 'unknown' }`.
  - `readCodexMcpAuth(call: CodexCall, threadId: string, names: readonly string[]):
    Promise<Readonly<Record<string, McpAuthState>>>`. It sends `mcpServerStatus/list { threadId, detail:
    'toolsAndAuthOnly' }` and follows `nextCursor`. It maps `oAuth` and `bearerToken` to SignedIn, `notLoggedIn`
    to NotSignedIn, `unsupported` to NotOAuth and `unknown` to Unknown. The response is parsed with zod.

- [ ] **Step 1: Write the failing tests.**
  - `codex-home.test.ts`: the written config has `mcp_oauth_credentials_store = "file"`.
  - `codex-mcp-auth.test.ts`: a table over the five `authStatus` values, and a two-page answer.
  - `codex-session.test.ts`, on the fake app-server: a your-server answering `notLoggedIn` puts
    `Note from 10db: <name> isn't signed in for this account. Sign in in Settings › Trust. It is not in this
    session; don't look for its tools.` before the first turn's text. A status error, or no answer within
    `MCP_STATUS_WAIT_MS`, sends the prompt with no note.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** The status read runs only when the spec has a remote your-server. It runs on the
  session's own `ask` deadline and never ends the session.
- [ ] **Step 4: Run the related tests, typecheck, lint, and `pnpm --filter @10db/daemon drift`.** Expected:
  PASS.
- [ ] **Step 5: Commit.** `feat(daemon): codex mcp sign-ins stay in the account home and sessions name a server to sign in`.
  Value card:
  `protects=Codex tokens land where Codex sessions read them, and a signed-out server is named;`
  `fails_when=the store setting goes, or a status failure blocks the prompt;`
  `why_new=Codex sessions had no MCP status read;`
  `no_claim=that Codex refreshes a token mid-session`.

### Task 5: The Codex adapter signs a server in

**Files:**

- Create: `apps/daemon/src/sessions/codex-mcp-sign-in.ts`
- Modify: `sessions/types.ts` (`AgentAdapter.startMcpSignIn`, `AgentAdapter.mcpAuthStatus`),
  `sessions/codex-adapter.ts`, `sessions/claude-adapter.ts`, `sessions/routed-adapter.ts`,
  `sessions/fake-adapter.ts`, `sessions/index.ts`
- Test: `sessions/codex-mcp-sign-in.test.ts`, `sessions/routed-adapter.test.ts`, `sessions/fake-adapter.test.ts`

**Interfaces:**

- Consumes: `codexYourServers` (Task 1 shape), `readCodexMcpAuth` (Task 4), `stopLoginProcess`, `LOGIN_MS`,
  `CODEX_CLIENT_INFO`.
- Produces:
  - `McpSignInSpec { kind: AgentAccountKind; env: Readonly<Record<string, string>>; name: string; server:
    YourSessionServer }` and `McpAuthSpec { kind; env; servers: Readonly<Record<string, YourSessionServer>> }`.
  - `McpSignIn { outcome: Promise<{ ok: true } | { ok: false; message: string }>; reopen(): Promise<void>;
    cancel(): Promise<void> }`.
  - `startMcpSignIn(spec: McpSignInSpec): Promise<McpSignIn>` and `mcpAuthStatus(spec: McpAuthSpec):
    Promise<Readonly<Record<string, McpAuthState>>>`.
  - The Claude adapter's `startMcpSignIn` throws `McpSignInUnsupportedError`, and its `mcpAuthStatus` answers
    `{}`.
  - `openPage(url: string): Promise<void>` defaults to `execFile('/usr/bin/open', [url])`. It is injected for
    tests.

- [ ] **Step 1: Write the failing tests.** In `codex-mcp-sign-in.test.ts`, on the fake child (the
  `codex-connect.test.ts` pattern):
  - The spawn env is the spec's env plus `HOME=<CODEX_HOME>/home`, after `CodexHome.prepare(<CODEX_HOME>/home)`.
  - `thread/start` carries `ephemeral: true`, `approvalPolicy: 'never'` and `config.mcp_servers` equal to
    `codexYourServers` of that one server.
  - `mcpServer/oauth/login { name, threadId, timeoutSecs: LOGIN_MS / 1000 }`. Then `openPage` is called once
    with the `authorizationUrl`.
  - A completion with the same `loginId` and `success` gives `{ ok: true }`. A failed one gives "The sign-in
    didn't finish. Try Sign in again." Either way the child is closed.
  - `LOGIN_MS` on the fake clock gives the same failure and closes the child.
  - An `authorizationUrl` that isn't plain https (http, userinfo, or not a URL) is refused. It is never opened
    and the child is closed.
  - `reopen` opens the same url again.
  - `mcpAuthStatus` runs one app-server, one ephemeral thread carrying every given server, and `readCodexMcpAuth`,
    then closes.
  - In `routed-adapter.test.ts`, a row routes both methods by kind.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Mirror `startCodexLogin`: early completions are buffered, the start has its own
  deadline, and the settle runs only after the process is gone. Nothing the child printed, and not the url, is
  logged or put in an error. The `FakeAdapter` keeps sign-ins in memory: `completeMcpSignIn(name, ok)` and
  `mcpAuth` per name.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(daemon): the codex adapter signs an mcp server in with codex's own login`. Value
  card:
  `protects=a Codex sign-in runs in the account home on the session's exact server config and always closes its process;`
  `fails_when=the config differs from the session's, the page opens unchecked, or a timeout leaves the child;`
  `why_new=the account login covers ChatGPT sign-in only;`
  `no_claim=that the IdP's page works (Task 8 L4)`.

### Task 6: Settings' sign-in rows and routes

**Files:**

- Modify: `packages/contracts/src/your-mcp.ts` (`McpSignInState`, `McpSignInRowDto`, `McpSignInsDto`,
  `StartMcpSignIn`), `packages/contracts/src/events.ts` (`EventType.McpSignInChanged: 'mcp_sign_in.changed'`),
  `src/json-schema.ts`, then regenerate
- Create: `apps/daemon/src/accounts/mcp-sign-ins.ts`
- Modify: `environment/launch.ts` (`claudeMcpSignInCommand`), `accounts/index.ts`, `api/services.ts`,
  `api/app.ts`, `daemon/trust-services.ts`, `daemon/start.ts` (wiring, stop on shutdown)
- Test: `accounts/mcp-sign-ins.test.ts`, `api/app.test.ts`, `environment/launch.test.ts`

**Interfaces:**

- Consumes: `startMcpSignIn` and `mcpAuthStatus` (Task 5), `readYourMcpConfig`, `planYourMcp`,
  `appTrustSwitches`, `mcpApprovals`, `Launcher.probe`.
- Produces:
  - `McpSignInState` as const `{ SignedIn: 'signed_in', NotSignedIn: 'not_signed_in', SigningIn: 'signing_in',
    Failed: 'failed', Unknown: 'unknown' }`.
  - `McpSignInRowDto { accountId, accountLabel, key: YourMcpServerKey, name, state, how: 'button' | 'terminal',
    command: string | null, message: string | null }`.
  - `McpSignInsDto { rows }` and `StartMcpSignIn { accountId, key }`.
  - `GET /settings/trust/mcp-sign-ins` answers `McpSignInsDto`. `POST` with `StartMcpSignIn` answers
    `McpSignInsDto`, 404 for an unknown account or key, and 409 for an account that isn't Codex.
  - `claudeMcpSignInCommand(configDir: string): string` is `CLAUDE_CONFIG_DIR=<quoted dir> claude`.
  - `createMcpSignIns(deps)` returns `{ list(): Promise<McpSignInsDto>; start(input): Promise<McpSignInsDto>;
    stopAll(): Promise<void> }`.

The candidates are the servers `planYourMcp` plans, on app switches, whose remote plan has `headers === null`.

- **Codex rows.** One row per (non-archived Codex account, candidate). The state comes from `mcpAuthStatus`,
  cached per account for 60 s and dropped when a sign-in ends. `NotOAuth` rows are left out.
- **Claude rows.** One terminal row per (subscription account with its own folder, candidate), with the command
  and the message "Then run /mcp and sign in." These rows have no state read.

- [ ] **Step 1: Write the failing tests.** In `mcp-sign-ins.test.ts`, on real SQLite in a temp dir, with the
  `FakeAdapter`:
  - A Codex account and an approved headerless server give a `not_signed_in` row. A server with a header, or one
    reading `not_oauth`, gives no row.
  - `start` goes to `signing_in`. Then `completeMcpSignIn(ok)` gives `signed_in` and one `McpSignInChanged`
    event.
  - A second `start` calls `reopen`, not `startMcpSignIn`.
  - A failure gives `failed` with its message. A new `start` goes back to `signing_in`.
  - `stopAll` cancels every slot.
  - A new service on the same database has no slot and reads the status again (restart).
  - An own-folder subscription gives a terminal row with `claudeMcpSignInCommand(dir)`. The default account gives
    none.
  - In `app.test.ts`, through `app.request`: the GET and POST contracts parse with their schemas, plus 404 and
    409.
- [ ] **Step 2: Run them and watch them fail.** Expected: FAIL.
- [ ] **Step 3: Implement.** Slots live in memory only. The env comes from `Launcher.probe(account).env`. An
  account the launcher refuses gets a row with state `unknown` and the refusal's message.
- [ ] **Step 4: Run the related tests, typecheck, lint, and contracts generate.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(daemon): settings lists and starts mcp sign-ins for each account`. Value card:
  `protects=each Codex account × OAuth server reads true, signs in once at a time and recovers after a restart;`
  `fails_when=a second click starts a second process, a failure sticks, or a restart leaves a phantom slot;`
  `why_new=no sign-in service existed;`
  `no_claim=that the window shows it (Task 7)`.

### Task 7: Settings › Trust shows Sign in

**Files:**

- Modify: `apps/desktop/src/daemon/trust-queries.ts` (`useMcpSignIns`, `useStartMcpSignIn`),
  `src/daemon/events.ts` (`INVALIDATIONS` for `McpSignInChanged`)
- Modify: `src/views/settings/your-mcp-servers.tsx`, `trust-rows.ts`, `views/settings/AGENTS.md`
- Test: `src/views/settings/your-mcp-servers.test.tsx`

**Copy:**

- Under each server, one line per row, as `<account>: ` followed by:
  - **signed in:** "Signed in".
  - **not signed in:** "Not signed in", with a **Sign in** button.
  - **signing in:** "Signing in in your browser…", with **Open page again**.
  - **failed:** the row's message in red, with **Sign in**.
  - **terminal:** the command in a `Code` block with a `CopyButton`, and "Then run /mcp and sign in."
- The approve modal's no-headers line becomes "It sends no headers. If it signs in with OAuth, sign it in
  as each agent does: in Claude Code, or below for a Codex account."
- `trust-rows.ts` `yourMcpServers.providers` becomes "Claude and Codex sessions both get every approved server.
  Tool filters from config.toml apply in Codex sessions only. Servers that sign in with OAuth use the sign-in
  Claude Code or Codex keeps. Sessions on a Claude plan also get your claude.ai connectors. Claude Code offers
  none on an API key or Bedrock."
- `ServerText` adds "Signs in with OAuth: clientId=…" from `oauth`.

- [ ] **Step 1: Write the failing tests.** `your-mcp-servers.test.tsx` (MSW): a table over the five row kinds
  renders the copy above. Clicking Sign in posts `{ accountId, key }`. Clicking Open page again posts the same.
  The terminal row shows the command. An `mcp_sign_in.changed` event refetches the rows.
- [ ] **Step 2: Run them and watch them fail.** `pnpm --filter @10db/desktop exec vitest run src/views/settings`.
  Expected: FAIL.
- [ ] **Step 3: Implement.** Use Mantine components and tokens only (`DESIGN.md`), in dark and light.
- [ ] **Step 4: Run the related tests, typecheck and lint.** Expected: PASS.
- [ ] **Step 5: Commit.** `feat(desktop): settings › trust signs a codex account in to an oauth server`. Value
  card:
  `protects=the builder sees each account's sign-in state and can start one;`
  `fails_when=a state renders wrong or the click posts the wrong pair;`
  `why_new=the view had no sign-in rows;`
  `no_claim=the browser hand-off (Task 8 L4)`.

### Task 8: Live rows per provider, and the token stores stay unreadable

**Files:**

- Modify: `apps/daemon/test/your-mcp-probe.ts`. `laneProbeScript(filesRoot, tokenFiles: readonly string[] = [])`
  adds three probes, and `PROBES_HELD` adds `KEYCHAINS=denied`, `SECURITY=denied` and `TOKEN_FILE=denied`:
  - `ls ~/Library/Keychains`.
  - `/usr/bin/security find-generic-password -s 'Claude Code-credentials' >/dev/null 2>&1`, an attribute lookup
    whose output is discarded and never `-w` or `-g`.
  - `test -r <each token file> && head -c0 <file>`, printing `ok` or `denied` only.
- Modify: `test/lane-sandbox.live.test.ts`, `test/codex.live.test.ts`, `src/env.ts` and `.env.example`
  (`TENDB_LIVE_API_KEY`, `TENDB_LIVE_OAUTH_SERVER`)
- Run, not commit: the click-through.

Rows (manual, never CI; each prints what it observed through `TENDB_LIVE_REPORT`):

- **L1 Claude plan, default folder** (`TENDB_LIVE_CLAUDE=1`).
  - A sandboxed lane with the builder's signed-in OAuth server, named by `TENDB_LIVE_OAUTH_SERVER`, connects and
    lists its tools.
  - The lane gets its claude.ai connectors with status `connected`.
  - The lane shell's probes hold.
- **L2 API key** (`TENDB_LIVE_API_KEY=1`, `ANTHROPIC_API_KEY` set, an own folder from `homeOutsideTemp`). The
  same server connects, init reports `apiKeySource: 'ANTHROPIC_API_KEY'`, `checkInitCredentials` passes, and
  no connector is passed.
- **L3 Bedrock** (`TENDB_LIVE_BEDROCK=1`). The same server connects, and the account reads `apiProvider:
  'bedrock'`.
- **L4 Codex** (`TENDB_LIVE_CODEX=1`, an account home from `homeOutsideTemp`).
  - `mcpAuthStatus` reads `not_signed_in`.
  - `startMcpSignIn` with an `openPage` that records gives an https url on the server's host.
  - `cancel` closes the child.
  - A lane shell can't read a canary `.credentials.json` planted in the home.
- **Click-through.** On `pnpm dev`, with a Codex account connected in the dev data folder, drive Settings › Trust
  with `/browse` up to Sign in. The builder approves in the browser. The row reads Signed in, and a Codex lane
  then lists the server's tool. Afterwards `test -f <home>/.credentials.json` holds; the file is never read.

- [ ] **Step 1: Extend the probe helpers and add the rows.** Run each with its switch and see it pass. Run L1's
  probe line once with `/usr/bin/security` allowed by hand (outside the sandbox) to see it print `ok`, so
  `denied` in the lane means something.
- [ ] **Step 2: Do the click-through.** Record the result in the PR.
- [ ] **Step 3: Commit.** `test(daemon): live rows for oauth mcp servers on every account kind`. Value card:
  `protects=each provider connects a signed-in server as its own account and no lane reads a token store;`
  `fails_when=a keyed session bills the plan, or a lane shell reaches the keychain or a credentials file;`
  `why_new=T6's live rows had no OAuth server and no token store;`
  `no_claim=CI coverage (manual rows)`.

### Task 9: Docs and decisions

**Files:**

- Create: `docs/architecture/decisions/2026-11-14-mcp-sign-ins-stay-in-each-agents-own-store.md` (**Amends:**
  decision 105). It records:
  - Keyed Claude accounts read the builder's keychain entry through `CLAUDE_SECURESTORAGE_CONFIG_DIR`.
  - Codex accounts use the file store in their home, and sign in from Settings with Codex's own login.
  - 10db never touches a token.
  - Why: the alternatives were copying tokens, or signing in again per account.
- Create: `docs/architecture/decisions/2026-11-14-claude-ai-connectors-are-relayed-under-strict-mcp-config.md`.
  It records the probe, the relay, the switch, and why `strictMcpConfig` stays on. Dropping it would load
  `~/.claude.json` user and local servers outside the approval and the launch, and project `.mcp.json` outside
  `srt`.
- Modify: `apps/daemon/src/session-setup/AGENTS.md`, `sessions/AGENTS.md`, `environment/AGENTS.md`,
  `accounts/AGENTS.md`, `apps/desktop/src/views/settings/AGENTS.md`, `docs/architecture/03-trust-boundaries.md`
  (§4.6). Each gains a line or two on what changed.

- [ ] **Step 1:** Write them. Cite decisions by path.
- [ ] **Step 2:** Run `pnpm --filter @10db/repo-checks exec vitest run` for the docs rules (cited paths,
  no `CLAUDE.md`). Expected: PASS.
- [ ] **Step 3: Commit.** `docs: oauth mcp servers and claude.ai connectors in 10db sessions`.

### Task 10: Adversarial review

- [ ] Dispatch `code-reviewer` (opus) on the branch from `origin/main` (base `f528d6c4`), with this plan and
  Tasks 1–9. This is round 1, so it lists every finding. It hunts for:
  - Any token read or logged, and any `-w` or `-g`.
  - A keyed session that could run on the plan login.
  - The probe loading anything but connectors, or leaving folders behind.
  - A sign-in process left running.
  - A page opened without the https check.
  - Connectors reaching a session with the switch off.
- [ ] Fix the blocking findings in one commit and do round 2 on those findings only, at most two rounds. Then run
  the full `make gate` once and open the PR. Its title is
  `feat: oauth mcp servers and claude.ai connectors run in 10db sessions as claude code and codex run them`.
