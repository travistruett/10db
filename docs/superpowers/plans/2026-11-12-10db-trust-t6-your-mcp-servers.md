# 10db Trust T6, Your MCP Servers: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The builder's own MCP servers come into every lane, pass, Plan conversation and chat, on every account
kind. They come from `~/.claude.json`, `~/.codex/config.toml` and the builder's installed plugins, and are stdio or
header-auth servers. Each runs as Claude Code runs it: outside the kernel sandbox, with its calls judged like any
other call. A server from either file runs only after the builder approves it once in Settings › Trust. It can be
switched off there, app-wide or per project. Servers a repository declares (`.mcp.json`) stay as built: approved by
hash, under `srt`.

**Architecture:**

- `session-setup/` reads the two files and the loaded plugins' MCP declarations. The daemon reads only the
  `mcpServers` and `mcp_servers` keys, through zod. It reviews each server, hashing every value but the secret
  ones, and plans one session's servers from the trust switches, the approvals and the login environment.
- `sandbox/your-mcp-launch.ts` turns each stdio server into a launch:
  - It refuses a server whose command, arguments, working folder or code-loading variables a lane can write.
  - It puts the server's environment in a sealed file in the files root.
  - It starts the server through `env -i` from the builder's home, so the session's credentials don't reach it and
    no env value is on a command line.
- The adapters pass the servers next to the project's: Claude through `setMcpServers`, Codex as `mcp_servers`
  entries in the thread config of a lane or an explore thread.
- The session's `TrustPolicy` tells the judge that these tools act outside the sandbox.
- Settings › Trust (T2 Task 14) lists every server with Approve and a switch. The project's Trust overrides each
  one.

**Tech Stack:** TypeScript, zod 4.6.7, smol-toml 1.9.1, `@anthropic-ai/claude-agent-sdk` 0.3.316,
`@anthropic-ai/sandbox-runtime` 0.0.81, Codex 0.167.0 app-server, Vitest, Mantine 9.8.

**Spec:** `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`:

- §6: the rows "The builder's MCP servers" and "The project's MCP servers", "Your MCP servers in T6", "The
  builder's MCP servers run as Claude Code runs them", and calls 14 and 16.
- §9 (Settings › Trust), §10 (MCP row), §11, §12 (T6 row and order).

Decision: `docs/architecture/decisions/2026-11-12-10db-trusts-the-developer-and-contains-the-agent.md`. Research:
`docs/architecture/research/2026-11-12-trust-line-research.md` (L3, "Loading the builder's setup through the Agent
SDK"). Today's repo-server design: `docs/architecture/03-trust-boundaries.md` §4.6.

## Starting point: M5b has merged

The roadmap's order is … M5a → M5b → **T6** → M6. Task 0 confirms each name below. Where a milestone chose another
name, use that one and list the mapping in the PR.

- **T2** (`2026-11-12-10db-trust-t2-setup-comes-along.md`):
  - `TrustSwitches`, `TrustOverrides`, `effectiveTrust`, `TrustSettingsDto` and `ProjectTrustDto` in
    `packages/contracts/src/trust.ts`.
  - `appTrustSwitches`, `trustSwitchesFor` and `setAppTrustSwitches` in
    `apps/daemon/src/permissions/trust-switches.ts`.
  - `session-setup/` with `LeftOut`, `leftOutNote`, `readInstalledPlugins` and `planSessionSetup`. Since Task 5,
    `planSessionSetup` adds `<id>'s MCP servers: until 10db runs your MCP servers (T6)` for each loaded plugin that
    declares servers. Task 7 replaces that item.
  - The `builderHome` the runner and the Plan sandbox deps carry, and `readRepoConfigFile` exported from `sessions`.
  - The plugin wrapper (`sandbox/plugin-wrapper.ts`, `wrapPlugin`, T2 Task 6 Step 6). Every plugin reaches Claude
    Code through it, never by `installPath`. It links every top-level entry but `.claude-plugin`, `.mcp.json` and
    `hooks`, drops the manifest's `mcpServers`, and re-emits `hooks.json` with each command hook prefixed
    `cd "$CLAUDE_PLUGIN_ROOT" &&`. So no plugin's MCP server starts today, and T2's Task 8 (M1) recorded whether
    `strictMcpConfig` alone would have kept them out.
  - `LaneSessionInput.setup`, `LaneSession.setup`, and the laneWritable list T2 Task 10 builds.
  - Settings › Trust and the project's Trust: `trust-section.tsx`, `project-trust-section.tsx`, `trust-rows.ts`
    (`TRUST_ROWS`), `GET|PUT /settings/trust` and `GET|PUT /projects/:projectId/trust`.
- **M2a and M2b:**
  - `buildMcpServers(spec)` and `toSdkMcpServer` in `sessions/claude-session.ts`.
  - `AgentSessionCore.projectMcpServers` in `sessions/types.ts`.
  - `codexThreadConfig(spec)` in `sessions/codex-lane-config.ts`. It throws `CodexLaneConfigError` without a lane
    sandbox.
- **T3** (`2026-11-12-10db-trust-t3-policy-and-auto-mode.md`):
  - `TrustPolicy` (`@10db/contracts`, `trust-policy.ts`), `TrustPolicyInput`, `buildTrustPolicy` and `isAttended`
    (`apps/daemon/src/trust/policy.ts`), `AgentSessionCore.policy`, and `renderClaudeAutoMode`
    (`sessions/claude-auto-mode.ts`), which puts `policy.environment` in auto mode's `environment`.
  - `JudgeKind` and the guard's `JudgedRule.OutOfProxyTool` (`guard/judged-rules.ts`), which sends repo MCP tools
    to the judge where one runs. T3's live row 2 checks that auto mode's classifier sees an MCP call. If it failed
    and T3 sent MCP tools back to the floor's ask, your servers' calls take the same path: a card when attended, a
    skip when unattended. Task 8's judged-call rows then assert that, and the PR says so.
- **T4 and T5:** T4's unattended skip (`skipped_actions`), T5's `crossesLimit`, `renderAutoReviewPolicy`, and the
  `default_tools_approval_mode` value T5 gives project servers on Codex.
- **M4b, M5a and M5b:**
  - The explore engine's `ExploreOwnerHooks.spec(conv, start)`, with Plan's in `conversation/explore-owner.ts` and
    the chat's in `chat/hooks.ts`. The engine calls `spec` each time it starts a session for a conversation, a
    resume included.
  - The Plan sandbox deps (`daemon/shape-session-tools.ts` today, `:150-230`), which build the project's servers
    for an explore session.
  - M5b's Codex explore profile: a chat's and Plan's Codex thread on a read-only `sandboxPolicy`, with its own
    thread-config builder beside `codexThreadConfig`. Plan on Codex runs without `agents`
    (`capabilities.subagents`).
- **Built today:**
  - `readRepoMcp`, `resolveProjectMcp`, `RemoteMcpServer`, `TENDB_MCP_SERVER`, `SENSITIVE_NAME` and
    `expandsOnCommandLine` (`sessions/project-mcp.ts`).
  - `SandboxedMcpServer`, sealed files and the files root (`sandbox/mcp-sandbox.ts`, `sandbox/sealed-file.ts`),
    `shellAssignments` (`sandbox/env-file.ts:14`, which refuses a name that isn't a shell identifier and a value
    with a control character), the stale sweep's `SEALED_FILE` (`sandbox/stale-files.ts:17`), `SYSTEM_TEMP_ROOTS`
    (`sandbox/temp-dir.ts:82`), `DEFAULT_WORKTREE_BASE` (`daemon/worktree-root.ts:9`) and `SandboxRoots`
    (`daemon/sandbox-roots.ts`).
  - `realOrSelf` (`sessions/codex-lane-permissions.ts:22`): a path's nearest existing ancestor, resolved, plus the
    rest. Task 4 moves it into `sandbox/` (`sandbox/real-or-self.ts`, exported through `sandbox/index.ts`), and
    `sessions` imports it from there.
  - `Launcher.projectEnv()`: the login environment without billing switches (`environment/launch.ts:95-96,180`),
    and the login `CLAUDE_CONFIG_DIR` and `CODEX_HOME` that `ProjectAccess` takes as `loginConfigDir` and
    `loginCodexHome` (`sandbox/project-access.ts:56,61`).
  - A read-only step refuses every tool outside `READ_ONLY_TOOLS` but `mcp__10db__*` (`guard/judge.ts:733-738`).
  - srt's Seatbelt profile allows `process-info*` only `(target same-sandbox)`
    (`@anthropic-ai/sandbox-runtime` 0.0.81, `dist/sandbox/macos-sandbox-utils.js:764`). So a lane command can't
    read an unsandboxed process's arguments or environment. Task 4 measures this; Task 6 measures Codex's own
    profile.

## Global Constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `apps/desktop/AGENTS.md`, `packages/contracts/AGENTS.md`,
  `.claude/rules/code-style.md`, `.claude/rules/testing.md`.
- Branch `feat/trust-t6` in its own worktree:
  `git worktree add ../10db-worktrees/trust-t6 -b feat/trust-t6 origin/main`. Tasks in order. One commit per task
  unless a task says otherwise. Commits are Conventional Commits that name every path
  (`git add a b && git commit -m '...'`), use a single-quoted `-m`, and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- Each newly tested behaviour carries one value card in its commit. A new row in an existing table needs none.
- **This changes what runs outside the sandbox.**
  - Tasks 4, 6 and 7 take small red-first steps, with their tests on the real-thing rung: real processes, Seatbelt
    through srt, Codex's own profile in the live row, and real files in a temp home.
  - Task 12 is the adversarial review `decisions/2026-10-29-sandbox-is-the-boundary.md` requires.
- **Nothing lane-writable runs outside the sandbox, as far as 10db can see.**
  - `laneWritableRoots` (Task 4) is the one list every caller uses. It covers every checkout, the whole worktree
    base (so a worktree made after a session starts is covered), the lane temp roots and the system temp roots.
  - A server is left out when its command, a path argument, an argument holding a lane-writable root, its `cwd` or
    a declared code-loading variable resolves into one. That covers a path that doesn't exist yet.
  - A code-loading variable or PATH entry from the login env that does so is dropped, with a note.
  - Every server starts from the builder's home with a cleaned PATH. So `npx`, `uvx` and a bare command never
    resolve inside a checkout.
  - This is best effort, and Task 11 says so: a shim, an `sh -c` script, or a server that loads code from a
    checkout by its own logic passes it.
- **Secrets stay out of reach:**
  - Secret-named env values (`SENSITIVE_NAME`) and every header value never reach a command line, a log line, a
    DTO, an error message, a note or the database. Other env values reach only the Settings DTO (`shownEnv`), so
    the builder sees what the hash covers. A config's hash covers env values except the secret-named ones, and
    header names only.
  - `${VAR}` in a command or argument is refused, as `.mcp.json`'s is. Literal arguments and URLs are shown in
    Settings, hashed, and visible to every local process, as in Claude Code. Refusal reasons name a field
    (`argument 3`), never its text.
  - An error about a file never quotes it. JSON.parse and smol-toml errors carry fragments of the input, so their
    messages are dropped.
- **Reading `~/.claude.json` is reading a credential-adjacent file.** Only the daemon reads it, and only its
  `mcpServers` key. No sandbox profile opens it (trust line §2), and no agent gets a path to it.
- **State.** A session's servers are fixed when it starts (call 14). An approval, a switch or a config change
  applies from the next session. Every switch says "Applies from the next session."
- **Provider parity.** Every approved server reaches every account kind. Each task states its behaviour per
  provider. Vertex is not an account kind (`packages/contracts/src/accounts.ts:10-17`).
- No AA numbers anywhere in the repo.

**Per provider:**

| | Claude plan, API, Bedrock | Claude gateway | Codex (ChatGPT plan) |
| --- | --- | --- | --- |
| How a server reaches the session | `setMcpServers`, over the control channel | same | `mcp_servers` in the lane's or explore thread's config, over stdin |
| Who starts a stdio server | Claude Code, through 10db's launch | same | Codex app-server, through 10db's launch |
| Who connects to an http or sse server | Claude Code | same | Codex app-server |
| Who judges a call | auto mode | 10db's judge (T5) | 10db's judge (T5) |
| Tool filters from `config.toml` (`enabled_tools`, `disabled_tools`) | not applied; Settings says so (call 9) | same | applied |
| A server that signs in with OAuth | left out, named in the note (Task 5) | same | left out, named in the note (Task 6) |
| Without an OpenRouter key, unattended | unaffected | `rules` floor: the call is skipped and listed | per T5 |

## Calls made in this plan

1. **Approval covers what runs, not the secrets.** The hash covers:
   - the source, transport, command, arguments, working folder and URL;
   - env names, and env values except where the name matches `SENSITIVE_NAME`;
   - header names, Codex's `env_vars`, `bearer_token_env_var` and `env_http_headers`, and the tool filters.

   A rotated token or header doesn't ask again. A new variable, a changed command, or a changed `PATH`,
   `NODE_OPTIONS` or `npm_config_registry` does. Settings shows every hashed env value (`shownEnv`).
2. **Approval lives in Settings › Trust, with no Inbox card.** A server not yet approved is left out of each session
   and named in its note. Unattended work never waits on it.
3. **Plugin servers need no approval.** Installing the plugin was the builder's approval, as in Claude Code. They
   follow the plugin's switch and their own.
4. **Every server starts from the builder's home, not the checkout** (Review Focus 1). A server that relied on the
   project as its working folder sees the home instead. Settings says so.
5. **Env, as each tool gives it:**
   - A server from `~/.claude.json` or a plugin gets `projectEnv()` (the login env without billing switches) plus
     its own `env`.
   - A server from `config.toml` gets Codex's base names (`CODEX_MCP_BASE_ENV`, confirmed in Task 0) from that env,
     plus `env_vars` and its own `env`.
   - A login variable that a sealed file can't hold (a multi-line PEM, a name that isn't an identifier) is dropped,
     with a note naming it. A declared one refuses its server.
6. **`${VAR}` expands from the login environment, any name, in env values, URLs and header values** of
   `~/.claude.json` and plugin entries. It is refused in a command or argument, as `.mcp.json`'s is
   (`expandsOnCommandLine`): an argument is on a command line every local process can read. A literal secret in an
   argument or URL is the builder's choice, as in Claude Code; it is shown and hashed.
7. **Name clashes:**
   - A name the project's `.mcp.json` declares is the project's, whatever its approval, as Claude Code's project
     scope wins over user scope.
   - Then `~/.claude.json`, then `config.toml`, then plugins in `readInstalledPlugins` order.
   - Reserved names (`10db…`, or any with `__`) are refused when read.
8. **Only the user scope of `~/.claude.json`.** Its `projects[<path>].mcpServers` (local scope), `headersHelper`,
   `oauth` entries and claude.ai connectors are left out with a reason, and become follow-up tasks. A
   `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the builder's shell is not followed: the files are `~/.claude.json` and
   `~/.codex/config.toml`. Settings says when the shell sets either.
9. **Tool filters from `config.toml` apply on Codex only.** Claude has no per-server filter in `setMcpServers`.
   Settings says so, and a follow-up task closes it.
10. **A remote server on loopback is allowed** for the builder's own, unlike the project's in Plan, except when it
    carries headers and the session's sandbox lets commands bind local ports (the project's loopback switch on).
    A lane could then listen on that port first and receive the headers. Such a server is left out with a note. A
    DNS name that resolves to loopback is not caught; Task 11 records it.
11. **Plan's subagents get none of these servers.** Plan's main session does, on Claude and on Codex. On Claude its
    researchers keep their tool lists; on Codex, Plan has no subagents (M5b).
12. **A read-only step refuses your servers' tools**, as it refuses the project's (`guard/judge.ts:733-738`). The
    servers are still in the session; the step's role is to read.
13. **Coordination for MCP tools is told to the judge, not enforced.** The guard's coordination rules judge shell
    commands and file paths. A GitHub server's merge or a filesystem server's write is not a command, so the
    session's `TrustPolicy` carries a line saying these tools act outside the sandbox under the four limits and the
    coordination rules, and the judge weighs it.
14. **"The next session" is the next session start.** A lane step, a pass turn's session, and each time the
    explore engine calls `spec` for a Plan conversation or chat, a resume included. A live session keeps its set.
15. **A plugin's server is named as Claude Code names it**, `plugin_<pluginName>_<server>` (tools
    `mcp__plugin_<pluginName>_<server>__*`), so the builder's instructions and skills that name a tool still
    match. Task 0 confirms the form.

## Review Focus

1. **A server that would run lane-written code.** It is left out when its command, a path argument, an argument
   holding a lane-writable root, its `cwd` or a declared code-loading variable resolves into a checkout, the
   worktree base or a temp root, through a link or before the path exists. A bare `npx -y pkg` resolves from the
   home with a clean PATH, so a checkout's `node_modules/.bin` is never reached. Rows in Task 4.
2. **A secret value escaping.** It must not reach a parse error that quotes the file, a note, a log line, a DTO, a
   command line, the database, or a lane's `ps -E`, on Claude or Codex. Rows in Task 2, Task 4, Task 6, Task 8 and
   Task 10, each proved red by a named mutation.
3. **A config that changes between the page and Approve, or after approval.** A stale hash is refused with 409 and
   nothing is stored. A changed config is off and named until approved again. Rows in Task 3 and Task 10.
4. **Switches stored by T2, before these keys existed.** They read with Your MCP servers on and no per-server
   switch, never as an invalid value that turns everything off. A project override without the key leaves the
   app's value. Rows in Task 1.
5. **A file or entry 10db can't use.** `~/.claude.json` caught mid-write, a name with a space, a multi-line login
   variable, or an OAuth server. Each leaves out what it must with a reason that quotes nothing, and Settings and
   the session still load. Rows in Tasks 2, 4, 5 and 10.

---

### Task 0: Confirm the starting point and run live check L5

No code. One docs commit with the live check's results.

- [ ] **Step 1: Find each name in "Starting point".**

```bash
git grep -n "TrustSwitches\|effectiveTrust\|trustSwitchesFor\|planSessionSetup\|leftOutNote\|readInstalledPlugins\|wrapPlugin" -- packages/contracts/src apps/daemon/src | head -30
git grep -n "export function buildMcpServers\|export function toSdkMcpServer\|projectMcpServers" -- apps/daemon/src/sessions | head
git grep -n "buildTrustPolicy\|TrustPolicyInput\|renderClaudeAutoMode\|OutOfProxyTool" -- apps/daemon/src packages/contracts/src | head
git grep -n "default_tools_approval_mode\|crossesLimit\|renderAutoReviewPolicy" -- apps/daemon/src | head
git grep -ln "ExploreOwnerHooks" -- apps/daemon/src/conversation apps/daemon/src/chat
git grep -n "sandboxPolicy\|capabilities.subagents\|mcp_servers" -- apps/daemon/src/sessions | head -20
```

  Expected: every name is found, including M5b's Codex explore thread-config builder (the function that sets
  `sandboxPolicy` read-only and `mcp_servers` for an explore thread). Write any that differs in a scratch note. Each
  later task uses the found name, and the PR lists the mapping.

- [ ] **Step 2: L5a. How Claude Code names and runs a plugin's servers.** Read T2's Task 8 (M1) record in the
  research notes. Then, through the Agent SDK's own options (`plugins: [{ type: 'local', path: <unwrapped install
  path of a plugin with a stdio server> }]`, `strictMcpConfig: true`, `settingSources: []`), start one session in a
  scratch repo with the pinned Claude Code, and read `mcpServerStatus()`. Record the server's name (expected
  `plugin:<plugin>:<server>`), its tools' prefix (expected `mcp__plugin_<plugin>_<server>__`) and, if it started,
  its working folder. If M1 found `strictMcpConfig` keeps plugin servers out, start it once without
  `strictMcpConfig` to read the name.
- [ ] **Step 3: L5b. Codex's MCP base env and `cwd`.** Read the pinned 0.167.0 source at tag `rust-v0.167.0`
  (`codex-rs`, the MCP client's env builder). Record:
  - the default env names it gives a stdio server, which become `CODEX_MCP_BASE_ENV`;
  - whether `cwd` is honoured;
  - which keys `mcp_servers.<id>` accepts. This confirms Task 2's Codex schema.
- [ ] **Step 4: L5c. A Codex stdio server outside Codex's sandbox.** With app-server 0.167.0 on the ChatGPT account's
  `CODEX_HOME`, start a thread whose config has `permissions` set to 10db's `lane` profile and `mcp_servers.probe`.
  The probe is a stdio server on the pattern of `PROBE_SERVER` in `test/mcp-sandbox.seatbelt.test.ts` that reads a
  canary in the home and fetches `https://example.com`. Record whether both work. Expected: both, since Codex
  sandboxes commands and not MCP servers. If not, Task 6's rows change. Stop and report.
- [ ] **Step 5: L5d. What an OAuth server reports.** Configure one remote server that signs in with OAuth (a
  vendor's hosted MCP endpoint with no headers):
  - on Claude, through `setMcpServers`: record `mcpServerStatus()`'s status for it (expected `needs-auth`);
  - on Codex, as an `mcp_servers` entry: record what `mcpServerStatus/list` (or the start notification) reports for
    it.

  Tasks 5 and 6 map these to the OAuth reason.
- [ ] **Step 6: Commit** the results as a section `### L5: the builder's MCP servers` in
  `docs/architecture/research/2026-11-12-trust-line-research.md`, as
  `docs: live check l5 for the builder's mcp servers`.

---

### Task 1: Switches and approvals for your MCP servers

**Files:**

- Modify: `packages/contracts/src/trust.ts`, `trust.test.ts`
- Create: `packages/contracts/src/your-mcp.ts`, `your-mcp.test.ts`
- Modify: `packages/contracts/src/index.ts`, `packages/contracts/src/json-schema.ts`,
  `packages/contracts/generated/*` (by `pnpm --filter @10db/contracts generate`)
- Modify: `apps/daemon/src/permissions/trust-switches.ts`, `trust-switches.test.ts`, `permissions/index.ts`

**Interfaces:**

- Produces in `your-mcp.ts`:
  - `YourMcpSource = { ClaudeJson: 'claude_json', CodexConfig: 'codex_config', Plugin: 'plugin' } as const`, with
    its type.
  - `YourMcpServerState = { New: 'new', Changed: 'changed', Approved: 'approved', LeftOut: 'left_out' } as const`.
    A plugin server is `approved` from the start (call 3).
  - `YourMcpServerKey`, a branded string made only by `yourMcpServerKey(source, name, pluginId?: string)`.
    - The key is `claude_json:<n>`, `codex_config:<n>` or `plugin:<p>:<n>`, where `<n>` and `<p>` are
      `encodeURIComponent` of the name and the plugin id. So every name a file holds has a key, one with a space
      included (Review Focus 5).
    - It is derived, not minted, so it is not in `ids.ts`. Its schema is
      `z.string().regex(/^(?:claude_json|codex_config|plugin:[A-Za-z0-9%._~!*'()-]+):[A-Za-z0-9%._~!*'()-]+$/).brand<'YourMcpServerKey'>()`.
  - `YourMcpServerDto = z.strictObject({ key, name, source, pluginId: z.string().nullable(), transport: McpTransport.nullable(), command: z.string().nullable(), args: z.array(z.string()), cwd: z.string().nullable(), url: z.string().nullable(), envNames: z.array(z.string()), headerNames: z.array(z.string()), shownEnv: z.array(McpConfigEntry), configHash: z.string().nullable(), state: YourMcpServerState, reason: z.string().nullable(), on: z.boolean(), codexOnly: z.array(z.string()), sendsNoHeaders: z.boolean() })`.
    - `shownEnv` holds the entries whose values the hash covers: every one but the `SENSITIVE_NAME` ones (call 1).
    - `configHash` is null for a `left_out` entry the reader couldn't parse.
    - `codexOnly` names the keys only Codex applies (call 9).
    - `sendsNoHeaders` is true for a remote server with no header and no bearer token: Approve warns about OAuth
      (Task 10).
  - `ApproveYourMcpServer = z.strictObject({ key: YourMcpServerKey, configHash: z.string().regex(/^[0-9a-f]{64}$/) })`.
- Modifies `trust.ts`:
  - `TrustSwitches` gains `yourMcpServers: z.boolean().default(true)` and
    `mcpServers: z.record(YourMcpServerKey, z.boolean()).default({})`.
  - `TrustOverrides` is written out field by field, with every field `.optional()` and **no defaults**. A
    `.partial()` over defaulted fields would fill them in and override the app (Review Focus 4).
  - `effectiveTrust` merges `mcpServers` key by key, as `plugins`.
  - `TrustSettingsDto` gains `mcpServers: YourMcpServerDto[]` and `mcpNotice: z.string().nullable()` (Task 10).
- Produces in `permissions/trust-switches.ts`:
  - `mcpApprovals(db: DbReader, onInvalid?: (stored: unknown) => void): ReadonlyMap<YourMcpServerKey, string>`,
    from app setting `trust.mcp-approvals`, a record of key to a 64-hex hash. Absent is empty. Invalid is empty, and
    `onInvalid` is told: the safe side, since nothing is approved.
  - `approveMcpServer(ctx: WriteContext, key: YourMcpServerKey, configHash: string): void`.

**Per provider:** the same for every account kind.

- [ ] **Step 1: Write the failing tests.**
  - `trust.test.ts`, new table rows:
    - `a value stored before your MCP servers parses with them on and no per-server switch` (Review Focus 4): parse
      T2's `TRUST_DEFAULTS` without the two keys.
    - `an override without yourMcpServers leaves the app's off`: app off, override `{}`, effective off.
    - `mcpServers merge key by key, the override's winning`.
  - `your-mcp.test.ts`:
    - `yourMcpServerKey` rows: one per source.
    - `a name with a space or a colon makes a key the schema takes`.
    - `the key schema refuses a key with no source`.
  - `trust-switches.test.ts` (real SQLite, `createTestStore`):
    - `no approvals at first`.
    - `keeps an approval and reads it back`.
    - `an approvals value that is not the shape is empty, and says so`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm exec vitest run --project contracts packages/contracts/src/trust.test.ts packages/contracts/src/your-mcp.test.ts && pnpm --filter @10db/daemon exec vitest run src/permissions/trust-switches.test.ts`
  Expected: FAIL, because the fields and modules don't exist.
- [ ] **Step 3: Implement. Register `YourMcpServerDto` and `ApproveYourMcpServer` in `CONTRACT_SCHEMAS`, then run
  `pnpm --filter @10db/contracts generate`.**
- [ ] **Step 4: Run the tests, then typecheck both packages.** Expected: PASS.
- [ ] **Step 5: Commit** as `feat(daemon): switches and approvals for the builder's mcp servers`, with this value
  card: `protects=a T2-era value reads with the servers on, an override never fills defaults, any name has a key,
  approvals are hashes only; fails_when=a stored value without the new keys turns every switch off, or a project
  override flips the app's; why_new=trust.test covers T2's fields only; no_claim=that any session reads them
  (Tasks 3, 8)`.

---

### Task 2: Read your MCP servers from `~/.claude.json` and `~/.codex/config.toml`

**Files:**

- Create: `apps/daemon/src/session-setup/your-mcp-config.ts`, `your-mcp-config.test.ts`,
  `your-mcp-hash.ts`, `your-mcp-hash.test.ts`
- Modify: `apps/daemon/src/session-setup/index.ts`
- Modify: `apps/daemon/src/sessions/project-mcp.ts`. Export `RemoteUrl`, `HeaderMap`, `SENSITIVE_NAME`,
  `expandsOnCommandLine` and `EnvName` (`z.string().regex(ENV_NAME)`) through `sessions/index.ts`, so both readers
  share them.
- Modify: `apps/daemon/src/sessions/types.ts`. Add `interface CodexServerExtras`, below. Sessions come before
  `session-setup` in the module order, and the sandbox needs none of it.

**Interfaces:**

- Produces in `your-mcp-hash.ts`:
  - `yourMcpConfigHash(source: YourMcpSource, server: DeclaredYourServer): string`. It is the sha256 hex of
    `JSON.stringify` of a normalized object (call 1):
    - source, transport, command, args and cwd;
    - env entries sorted by name, each with its value, but the name alone where `SENSITIVE_NAME` matches;
    - `envVars` sorted;
    - url, header names sorted, `envHeaders` sorted, `bearerTokenVar` and the tool filters.
  - `shownEnvOf(server): McpConfigEntry[]`: the entries whose values the hash covers.
- Produces in `sessions/types.ts`:
  `interface CodexServerExtras { readonly enabledTools: readonly string[] | null; readonly disabledTools: readonly string[]; readonly startupTimeoutSec: number | null; readonly toolTimeoutSec: number | null }`.
- Produces in `your-mcp-config.ts`:
  - `type DeclaredYourServer`, one of:
    - `{ transport: 'stdio'; command: string; args: readonly string[]; env: Readonly<Record<string, string>>; envVars: readonly string[]; cwd: string | null; codex: CodexServerExtras }`
    - `{ transport: 'http' | 'sse'; url: string; headers: Readonly<Record<string, string>>; envHeaders: Readonly<Record<string, string>>; bearerTokenVar: string | null; codex: CodexServerExtras }`
  - `interface YourMcpEntry { readonly key: YourMcpServerKey; readonly name: string; readonly source: YourMcpSource; readonly pluginId: string | null; readonly declared: DeclaredYourServer | null; readonly configHash: string | null; readonly enabledInSource: boolean; readonly refusal: string | null }`.
    `declared` and `configHash` are null only when the entry didn't parse.
  - `YOUR_MCP_FILE_MAX_BYTES = 32 * 1024 * 1024` **(call: `~/.claude.json` holds project history and grows)**.
  - `readYourMcpConfig(input: { home: string; laneWritable: readonly string[]; plugins: readonly { id: string; installPath: string }[] }): { entries: YourMcpEntry[]; fileProblems: LeftOut[] }`.
    `plugins` is used from Task 7; until then callers pass `[]`.
  - **The file.** Each file may be a link, as T2 allows the builder's `CLAUDE.md`. Its real path must be a regular
    file, at most the cap, and not under `laneWritable`. Otherwise it is one `fileProblems` item, and that file
    gives no entries. A missing file is no entries and no problem.
  - **`~/.claude.json`:**
    - `JSON.parse`, then `z.looseObject({ mcpServers: z.record(z.string(), z.unknown()).optional() })`. Nothing else
      in the file is kept.
    - Each entry is parsed alone, so one bad entry refuses only itself:
      - stdio: `z.looseObject({ type: z.literal('stdio').optional(), command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(EnvName, z.string()).optional() })`;
      - remote: `z.looseObject({ type: z.enum(['http', 'sse']), url: RemoteUrl, headers: HeaderMap.optional() })`.
  - **`~/.codex/config.toml`:**
    - smol-toml `parse`, then `z.looseObject({ mcp_servers: z.record(z.string(), z.unknown()).optional() })`.
    - Each entry is parsed alone:
      - stdio: `z.looseObject({ command: z.string().min(1), args: z.array(z.string()).optional(), env: z.record(EnvName, z.string()).optional(), env_vars: z.array(EnvName).optional(), cwd: z.string().optional(), enabled: z.boolean().optional(), enabled_tools: z.array(z.string()).optional(), disabled_tools: z.array(z.string()).optional(), startup_timeout_sec: z.number().positive().optional(), tool_timeout_sec: z.number().positive().optional() })`;
      - remote: `url`, `bearer_token_env_var`, `http_headers`, `env_http_headers`, `enabled` and the same filters and
        timeouts.
    - `enabledInSource` is `enabled ?? true`; it is true for `~/.claude.json`. Task 0 Step 3 confirms the keys.
  - **Refusals, in order, as exact reasons.** None quotes a value, an argument or the URL (Review Focus 2):
    - an empty name is skipped, with no entry;
    - a name `McpServerName` refuses: `Its name can't be an MCP server name.` (Review Focus 5);
    - a reserved name, starting with `TENDB_MCP_SERVER` or holding `__`: `Its name is kept for 10db's own server.`;
    - an entry with `headersHelper`: `It runs a command for its headers, which 10db doesn't run yet.`;
    - an entry with `oauth`: `It signs in with OAuth, which 10db doesn't support yet.`;
    - another `type`: `Its type isn't stdio, http or sse.`;
    - `${` in the command or an argument (`expandsOnCommandLine`, call 6): `Its <command | argument N> uses ${…},
      which would put a value on a command line. Set it in its env block instead.`;
    - a command starting with `-`: `Its command can't start with "-". Point it at a script instead.`;
    - anything else that doesn't parse: `It can't be read: <describeIssues paths only>`.
  - **Errors never quote the file** (Review Focus 2, 5). A JSON or TOML parse failure is
    `{ what: '~/.claude.json', why: 'It is not valid JSON, so none of its MCP servers load.' }` (or `config.toml`
    and `TOML`), without the parser's message.

**Per provider:** the same reading for all. Which session gets what is Task 3.

- [ ] **Step 1: Write the failing tests.**
  - `your-mcp-hash.test.ts`, a table:
    - `the same config hashes the same, map order aside`
    - `a changed TOKEN value doesn't change the hash`
    - `a changed NODE_OPTIONS, PATH or npm_config_registry value does`
    - `a new env name does`
    - `a changed arg does`
    - `a changed header value doesn't, a new header name does`
    - `the source is part of it`
    - `shownEnv holds PATH and not TOKEN`
  - `your-mcp-config.test.ts`, over a temp home (`tempDir`):
    - `reads a stdio and an http server from ~/.claude.json and nothing else of the file`: the file also holds
      `primaryApiKey: 'sk-canary'` and `projects`. Assert that no entry, problem or reason contains `sk-canary`.
    - `reads stdio and http servers from config.toml with env_vars, filters and timeouts`
    - `enabled = false in config.toml is enabledInSource false`
    - `one bad entry refuses itself and the rest load`
    - `headersHelper, oauth and an unknown type are refused with their reasons`
    - `a name with a space is refused with a key, and the rest load` (Review Focus 5)
    - `10db-extra and a__b are refused as reserved`
    - `${TOKEN} in an argument is refused, naming argument 2 and no text`: the argument is `--key=${TOKEN}sk-canary`;
      assert no `sk-canary` and no `${TOKEN}` in the reason.
    - `a command starting with - is refused`
    - `a ~/.claude.json that is not JSON is one problem that quotes nothing` (Review Focus 5): the file is
      `{"mcpServers": {"a": {"env": {"T": "sk-canary"` (cut mid-write). Assert that the problem's text has no
      `sk-canary` and no `{`.
    - `a config.toml that is not TOML is one problem that quotes nothing`
    - `a ~/.claude.json linked to a dotfiles folder loads`
    - `a ~/.claude.json whose real path is in a checkout is a problem`
    - `a file over the cap is a problem`
    - `no files is empty`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/your-mcp-hash.test.ts src/session-setup/your-mcp-config.test.ts`
- [ ] **Step 3: Implement both.**
- [ ] **Step 4: Run them to see them pass. Prove each no-secret row red** by one mutation each, reverted after:
  append the parser's `error.message` to the problem's `why` (the two parse rows), and put the argument's text in
  the `${` reason (the argument row). Then typecheck and lint `apps/daemon/src/session-setup apps/daemon/src/sessions`.
- [ ] **Step 5: Commit** as `feat(daemon): read the builder's mcp servers from claude and codex config`, with two
  value cards, each naming its mutations:
  - the hash: `protects=approval covers what runs and every non-secret value; fails_when=a token rotation asks
    again or a PATH change doesn't; why_new=project-mcp hashes every value, a different rule; no_claim=what a
    server does with its env`;
  - the reader: `protects=only the MCP keys are read, any name is listed, and no error or reason quotes the file;
    fails_when=a parse error or reason carries a secret, or one bad entry drops all; why_new=nothing reads these
    files; no_claim=launching (Task 4)`.

---

### Task 3: One session's servers, from the switches, approvals and login env

**Files:**

- Create: `apps/daemon/src/session-setup/your-mcp-plan.ts`, `your-mcp-plan.test.ts`
- Modify: `apps/daemon/src/session-setup/index.ts`

**Interfaces:**

- Consumes: Task 1's switches and approvals, Task 2's entries, and T2's `LeftOut`.
- Produces:
  - `CODEX_MCP_BASE_ENV`: the names Task 0 Step 3 recorded, as an `as const` array.
  - `interface YourStdioPlan { readonly command: string; readonly args: readonly string[]; readonly cwd: string | null; readonly env: Readonly<Record<string, string>>; readonly declaredEnv: readonly string[]; readonly codex: CodexServerExtras }`.
    `env` is the whole environment the server gets. `declaredEnv` names the variables the entry itself set
    (`env`, `env_vars`, `CLAUDE_PLUGIN_ROOT`), so Task 4 can tell a declared variable from a login one.
  - `interface YourRemotePlan { readonly type: 'http' | 'sse'; readonly url: string; readonly headers: Readonly<Record<string, string>> | null; readonly codex: CodexServerExtras }`.
  - `interface YourMcpPlan { readonly stdio: Readonly<Record<string, YourStdioPlan>>; readonly remote: Readonly<Record<string, YourRemotePlan>>; readonly leftOut: readonly LeftOut[] }`.
  - `serverState(entry: YourMcpEntry, approvals: ReadonlyMap<YourMcpServerKey, string>): YourMcpServerState`.
    Settings uses it too (Task 10).
  - `planYourMcp(args: { entries: readonly YourMcpEntry[]; switches: TrustSwitches; approvals: ReadonlyMap<YourMcpServerKey, string>; projectServerNames: readonly string[]; loginEnv: Readonly<Record<string, string>>; localBinding: boolean }): YourMcpPlan`.
    `localBinding` is whether the session's sandbox lets commands bind local ports: the project's `sandboxLoopback`.
    The rules apply in order, the first that matches deciding:
    1. `switches.yourMcpServers` false: no servers, no note.
    2. `refusal` set: left out with it.
    3. Off by `switches.mcpServers[key] ?? enabledInSource`: no note.
    4. Not a plugin, with no approval: `waiting for your approval in Settings › Trust`.
    5. An approval for another hash: `changed since you approved it; approve it again in Settings › Trust`.
    6. A name in `projectServerNames`: `the project's .mcp.json declares a server with this name`.
    7. A name already taken by an earlier source (call 7): `a server named <n> is already in this session from
       <source label>`.
    8. Expansion fails: the reason names the variable, never a value.
    9. A remote server whose expanded URL's host is loopback (`localhost`, `*.localhost`, `127.0.0.0/8`, `::1`,
       `0.0.0.0`), with headers, while `localBinding` (call 10): `it sends its headers to this Mac, where this
       project's commands may listen; turn the project's loopback off to use it`.
  - **Expansion.**
    - Claude-file and plugin entries: `${VAR}` and `${VAR:-default}` expand from `loginEnv` in env values, the url
      and header values (call 6). The command and arguments hold none (Task 2 refused them). An unset name with no
      default fails, and the result may hold no `${`.
    - Codex-file entries:
      - `env_vars` copies the set names from `loginEnv`, skipping unset ones as Codex does;
      - `bearer_token_env_var` becomes `Authorization: Bearer <value>`, and fails when unset;
      - `env_http_headers` sets a header for each set name.
  - **Env** (call 5):
    - Claude-file and plugin: `{ ...loginEnv, ...env }`.
    - Codex-file: the `CODEX_MCP_BASE_ENV` names from `loginEnv`, then `env_vars`, then `env`.
    - `loginEnv` is `Launcher.projectEnv()`, so no billing switch or account secret is in it.
  - The source labels are `~/.claude.json`, `~/.codex/config.toml` and `the <pluginId> plugin`. Each left-out item's
    `what` is `your MCP server <name> (<source label>)`.

**Per provider:** one plan for every account kind. Tasks 5 and 6 turn it into each adapter's config.

- [ ] **Step 1: Write the failing table**, every row named:
  - `an approved stdio server is planned with the login env and its own, its declared names listed`
  - `a Codex-file server gets only the base names, env_vars and its env`
  - `the master switch off plans none and notes none`
  - `a server switched off here is not planned and not noted`
  - `a server off in config.toml stays off unless switched on here`
  - `a new server waits for approval, named` (Review Focus 3)
  - `a changed server is off until approved again, named` (Review Focus 3)
  - `a plugin server needs no approval`
  - `a project server's name wins, and yours is named`
  - `~/.claude.json wins a name over config.toml`
  - `${TOKEN} expands from the login env into env, the url and a header`
  - `${MISSING} without a default is left out, naming MISSING and no value`
  - `bearer_token_env_var becomes an Authorization header`
  - `a localhost server with headers is left out while the project's loopback is on, and kept while it is off`
  - `a localhost server with no headers is kept either way`
  - `no left-out reason holds any env, header, argument or URL text`: canary values in every field.
- [ ] **Step 2: Run it to see it fail.** Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/your-mcp-plan.test.ts`
- [ ] **Step 3: Implement.** Reuse `project-mcp.ts`'s `VARIABLE_REF` by exporting an `expandFrom(value, env)` that
  throws a typed `YourMcpExpandError` naming the variable. Don't touch `.mcp.json`'s own expansion rules.
- [ ] **Step 4: Run it to see it pass.** Prove the last row red by putting the URL in rule 9's reason, then revert.
- [ ] **Step 5: Commit** as `feat(daemon): plan a session's mcp servers from the builder's switches and approvals`,
  with a value card whose `fails_when` names an unapproved or changed server reaching a session, or headers sent to
  a port a lane can bind.

---

### Task 4: Launch a server outside the sandbox, but never lane-written code

This is what runs outside the kernel sandbox. Each step is red first. Three commits.

**Files:**

- Create: `apps/daemon/src/sandbox/lane-writable.ts`, `lane-writable.test.ts`
- Create: `apps/daemon/src/sandbox/your-mcp-launch.ts`, `your-mcp-launch.test.ts`
- Create: `apps/daemon/test/your-mcp-launch.process.test.ts`, `apps/daemon/test/your-mcp.seatbelt.test.ts`
- Modify: `apps/daemon/src/sandbox/lane-sandbox.ts` (`LaneSessionInput.yourMcpServers?`,
  `LaneSession.yourMcpServers`, `LaneSession.yourMcpLeftOut`, `forSession`, dispose)
- Modify: `apps/daemon/src/sandbox/stale-files.ts:17` (`SEALED_FILE` gains `ymcp`), `stale-files.test.ts`
- Modify: `apps/daemon/src/sandbox/index.ts`
- Create: `apps/daemon/src/sandbox/real-or-self.ts`. Move `realOrSelf` here from
  `sessions/codex-lane-permissions.ts`, which imports it through `sandbox/index.ts`; its behaviour is unchanged, and
  `codex-lane-permissions`' tests run unchanged.
- Modify: T2's callers of its laneWritable list (the runner, the Plan sandbox deps, `session-setup`) to use
  `laneWritableRoots`, in the second commit.

**Interfaces:**

- `lane-writable.ts`:
  - `laneWritableRoots(roots: { checkouts: readonly string[]; worktreeBase: string; sandboxTempRoots: readonly string[]; systemTempRoots: readonly string[] }): string[]`.
    It returns every checkout, the whole `worktreeBase` (`DEFAULT_WORKTREE_BASE` or the daemon's), every lane temp
    root of `SandboxRoots`, `SYSTEM_TEMP_ROOTS`, and their aliases `/tmp` and `/var/tmp`, each with its real path
    beside it. The one list for Tasks 4, 8,
    9 and 10.
  - `underLaneWritable(path: string, roots: readonly string[], base: string): string | null`. It checks the path as
    written (`~/` expanded, relative ones against `base`) and as `realOrSelf` resolves it (the nearest existing
    ancestor, resolved, plus the rest). It returns the matching root's kind (`a project's folder`, `the worktree
    folder`, `a temp folder`) or null. So a path that doesn't exist yet is judged by where it would be.
- The sandbox imports nothing from `session-setup`. It declares the structural
  `interface UnsandboxedStdioServer { readonly command: string; readonly args: readonly string[]; readonly cwd: string | null; readonly env: Readonly<Record<string, string>>; readonly declaredEnv: readonly string[] }`,
  which `YourStdioPlan` satisfies.
- `LOADS_CODE`: `PATH`, `NODE_OPTIONS`, `NODE_PATH`, `NODE_EXTRA_CA_CERTS`, `PYTHONPATH`, `PYTHONHOME`,
  `PYTHONSTARTUP`, `PYTHONINSPECT`, `PERL5OPT`, `PERL5LIB`, `RUBYOPT`, `RUBYLIB`, `BASH_ENV`, `ENV`, `ZDOTDIR`,
  `CLASSPATH`, `JAVA_TOOL_OPTIONS`, `_JAVA_OPTIONS`, `GIT_SSH_COMMAND`, `GIT_EXEC_PATH`, `SSL_CERT_FILE`,
  `SSL_CERT_DIR`, `CURL_CA_BUNDLE`, `REQUESTS_CA_BUNDLE`; and every name starting `DYLD_`, `LD_`, `GIT_CONFIG_`,
  `npm_config_`, `NPM_CONFIG_`, `PIP_`, `UV_`, `GEM_` or `BUNDLE_`. Use `loadsCode(name: string): boolean`.
- `prepareYourMcpRun(server: UnsandboxedStdioServer, ctx: { home: string; laneWritable: readonly string[] }): { refusal: string | null; env: Record<string, string>; dropped: string[] }`.
  It works on the expanded server. It refuses, naming a field and a root kind, never a value:
  - **the command:** absolute, `~/…`, a path with a `/` resolved against `cwd ?? home`, or a bare name looked up in
    the cleaned PATH. It is refused when `underLaneWritable`. A command not found is not refused: the server fails
    to connect, and the note says so.
  - **each argument:** one that is absolute or starts with `~/`, `./` or `../`, the part after its first `=`, and
    any argument that holds a lane-writable root as a substring. Each is refused when `underLaneWritable`.
  - **`cwd`:** when `underLaneWritable`.
  - **a declared `loadsCode` variable:** each part of its value split on `:`, whitespace and `=`, when
    `underLaneWritable`.
  - **a declared variable `shellAssignments` can't hold** (a name that isn't an identifier, a control character):
    `Its env variable <NAME> can't be passed to it.`
  - The refusal reads `Its <command | argument N | working folder | NAME> points at <root kind>, which an agent can
    write. Run it from a project's .mcp.json instead, where 10db sandboxes it.`

  It cleans what the login env brought:
  - `PATH` keeps only absolute entries not `underLaneWritable`, whether or not they exist; undefined is `HOST_PATH`.
  - A login `loadsCode` variable that points into a lane-writable root, and a login variable `shellAssignments`
    can't hold, is dropped and named in `dropped`.
  - `HOME` is `home`.
- `class YourMcpServer`: a private `#launch` and a constructor key only this file holds, as `SandboxedMcpServer`
  does. `launch(): McpLaunch` returns a fresh copy.
- `launchYourMcpServers(input: { home: string; filesRoot: string; laneWritable: readonly string[]; servers: Readonly<Record<string, UnsandboxedStdioServer>> }): { servers: Record<string, YourMcpServer>; leftOut: { what: string; why: string }[]; dispose(): void }`.
  - A refused server is a `leftOut` item with its refusal, and gets no file. Each `dropped` name adds
    `{ what: 'your MCP server <name>', why: 'it runs without <NAMES> from your login environment, which point where an agent can write or can't be passed' }`.
  - It writes one sealed file per server, kind
    `{ prefix: '10db-ymcp-', suffix: '.sh', what: 'your MCP server env file' }`, of `export` lines for the cleaned
    env.
  - The launch is exact **(call: the server's argv holds no env value, and its folder is never a checkout, call
    4)**:

```ts
{ command: '/usr/bin/env',
  args: ['-i', `PATH=${HOST_PATH}`, `HOME=${home}`, '/bin/sh', '-c',
         'cd -- "$1" && . "$0" && shift && exec "$@"', envFile, cwd ?? home, command, ...args] }
```

  - `dispose()` removes the files. Never `srt`.
- `LaneSessionInput.yourMcpServers` is **optional**, default `{}`, so callers compile before Task 8.
  `LaneSession.yourMcpServers: Readonly<Record<string, YourMcpServer>>` and
  `LaneSession.yourMcpLeftOut: readonly { readonly what: string; readonly why: string }[]`. `forSession` runs `launchYourMcpServers` with
  `laneWritableRoots` over the session's checkouts and roots, and disposes the launches with the session. The Codex
  extras are not here: Task 8 joins each launch with its plan's `codex`.

**Per provider:** Claude Code and Codex app-server run the same launch. Neither gives the server its own environment:
`env -i` drops it, and with it the session's credentials, `TENDB_MCP_TOKEN` and Codex's empty `HOME`.

- [ ] **Step 1: Write the failing tables** (real temp dirs for real paths; exhaustive, per
  `.claude/rules/testing.md` for the sandbox).
  - `lane-writable.test.ts`:
    - `lists every checkout, the worktree base, the lane temp roots and the system temp roots`
    - `a worktree made after the list was built is under the base`
    - `a path that doesn't exist yet in a checkout is under it`
    - `a path whose existing ancestor links into a checkout is under it`
    - `a path in the home is under none`
  - `your-mcp-launch.test.ts`, `prepareYourMcpRun`:
    - `npx -y pkg from the home is allowed`
    - `a command in a checkout is refused`
    - `a command linked from the home into a checkout is refused`
    - `node with a script in a checkout is refused`
    - `node with a script not yet built in a checkout is refused` (`<checkout>/dist/server.js`, absent)
    - `--config=<checkout>/x.json is refused`
    - `uv --directory <checkout> run x is refused`
    - `an argument holding a checkout path inside other text is refused` (`--opt=a,<checkout>/b`)
    - `a cwd in a worktree made after the session started is refused`
    - `a declared NODE_OPTIONS=--require <checkout>/x.js is refused`
    - `a declared PYTHONPATH with a checkout entry is refused`
    - `a declared DYLD_INSERT_LIBRARIES into a temp root is refused`
    - `a login PYTHONPATH into a checkout is dropped and named`
    - `a login variable with a newline is dropped and named; the server runs`
    - `a declared variable with a newline refuses the server`
    - `a PATH entry in a checkout is dropped, existing or not`
    - `a relative PATH entry is dropped`
    - `a bare name whose only PATH match is in a checkout is not found, not run`
    - `a missing command is not refused`
    - `an argument that only looks like a word is not a path`
    - `no refusal holds an argument's or a value's text`
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/lane-writable.test.ts src/sandbox/your-mcp-launch.test.ts`
- [ ] **Step 3: Implement `lane-writable.ts` and `prepareYourMcpRun`. Run them to see them pass. Commit** as
  `feat(daemon): refuse a builder mcp server that would run what a lane can write`, with this value card:
  `protects=no command, argument, cwd, code-loading variable or PATH entry in a checkout, the worktree base or a temp
  root runs unsandboxed, existing or not; fails_when=a link, a --x=path, an unbuilt script, a later worktree or a
  NODE_OPTIONS reaches lane-written code; why_new=repo servers run under srt, so nothing judged this;
  no_claim=a shim or a server that loads from a checkout by its own logic (Task 11 accepts it)`.

- [ ] **Step 4: Write the failing launch rows.**
  - `your-mcp-launch.test.ts`, pure over a temp files root:
    - `writes one sealed env file per server, mode 0400, with the cleaned PATH and the home`
    - `the launch's argv holds no env value`
    - `a refused server has a left-out item and no file`
    - `dispose removes the files`
  - `stale-files.test.ts`: a new row, `a 10db-ymcp env file of a dead daemon is swept`.
  - `test/your-mcp-launch.process.test.ts`, a real child process with no sandbox. Spawn the launch as Claude Code
    does:
    `spawn(command, args, { cwd: <a temp checkout>, env: { ...process.env, ANTHROPIC_API_KEY: 'sk-canary', TENDB_MCP_TOKEN: 'tok-canary' } })`.
    The server is a node script that prints `{ cwd, env }` as JSON. Assert:
    - `cwd` is the home;
    - `env.TOKEN` is the declared value;
    - `ANTHROPIC_API_KEY` and `TENDB_MCP_TOKEN` are absent, though the spawn env held both;
    - `PATH` has no checkout entry.
- [ ] **Step 5: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sandbox/your-mcp-launch.test.ts src/sandbox/stale-files.test.ts test/your-mcp-launch.process.test.ts`
- [ ] **Step 6: Implement `launchYourMcpServers`, the sweep and the `forSession` wiring, and move T2's laneWritable
  callers onto `laneWritableRoots`. Run them to see them pass, then `src/sandbox` and `src/session-setup` unchanged.
  Prove the argv row red by passing the env as `NAME=value` arguments to `env`, then revert. Commit** as
  `feat(daemon): launch the builder's mcp servers from home with a sealed env`, with this value card:
  `protects=the server gets its env and not the session's credentials, from home, with nothing on argv;
  fails_when=Claude Code's env reaches it, or it starts in the checkout; why_new=mcp-sandbox covers srt launches
  only; no_claim=Codex's own spawn (Task 6 live row)`.

- [ ] **Step 7: The real kernel.** Write `test/your-mcp.seatbelt.test.ts` on the pattern of
  `test/mcp-sandbox.seatbelt.test.ts` (the `SEATBELT` guard, srt through `resolveSandboxRuntime`, a real
  `createLaneSandbox` session).
  - Start a server through its `YourMcpServer` launch, outside the sandbox. Its declared env holds
    `TOKEN=sk-canary`, its argument is `--marker=arg-canary`, and it reads a canary file in the fake home. It stays
    up until the test ends, and reports its own pid.
  - **Positive controls, outside the sandbox:** `ps -E -p <pid>` shows `sk-canary`, and `ps -ww -o args= -p <pid>`
    shows `arg-canary`. Both must hold, or the test fails as vacuous.
  - Run one `sh -c` probe as a lane command under the session's srt profile, with `/bin/ps` named in full. Before
    and after the probe, assert the server's pid is alive (`process.kill(pid, 0)`). It expects:

```ts
expect(results).toEqual({
  'server-read-home-canary': 'ok',      // reported by the server: it runs outside the sandbox
  'lane-ps-env': 'denied',              // /bin/ps -E -p <pid>: no sk-canary in its output
  'lane-ps-args': 'denied',             // /bin/ps -ww -o args= -p <pid>: no arg-canary in its output
  'lane-read-env-file': 'denied',       // cat <filesRoot>/10db-ymcp-*.sh
  'lane-read-claude-json': 'denied',    // cat <home>/.claude.json
  'lane-write-files-root': 'denied',    // touch <filesRoot>/x
});
```

  - Run: `pnpm --filter @10db/daemon exec vitest run test/your-mcp.seatbelt.test.ts`.
  - To prove it red: put the env file under the lane's temp dir instead of the files root, and `lane-read-env-file`
    turns `ok`. Restore it, and name the mutation in the commit.
  - If `lane-ps-env` is `ok` with the real code, stop. A lane can read every unsandboxed process's environment, the
    claude process's credential among them. That is an R1 gap beyond T6: report it to the builder before going on.
- [ ] **Step 8: Commit** as `test(daemon): a lane can't read a builder mcp server's env, args or env file`, with
  this value card: `protects=srt keeps a lane off an unsandboxed server's process info and sealed file;
  fails_when=srt stops scoping process-info to same-sandbox, or the env file lands where a lane reads;
  why_new=mcp-sandbox's Seatbelt test runs servers inside srt; no_claim=Codex's profile (Task 6) or Claude Code's
  embedded sandbox (Task 11 live row)`.

---

### Task 5: Claude sessions take your servers

**Files:**

- Modify: `apps/daemon/src/sessions/types.ts`. `AgentSessionCore` gains
  `readonly yourMcpServers: Readonly<Record<string, YourSessionServer>>`, where
  `interface YourSessionServer { readonly connect: YourMcpServer | RemoteMcpServer; readonly codex: CodexServerExtras }`.
- Modify: `apps/daemon/src/sessions/claude-session.ts` (`buildMcpServers`; `toSdkMcpServer` gains a `YourMcpServer`
  branch, `{ type: 'stdio', command, args }` with no `env`), the failed-to-connect note, and its tests
- Modify: `apps/daemon/src/sessions/fake-adapter.ts` only where the type checks need it

**Interfaces:**

- `buildMcpServers(spec)` returns the project's servers, then yours, then `10db` last, so no other server takes
  10db's name.
- After the servers are registered, the adapter reads `mcpServerStatus()` once, as it does today for its log. Your
  servers that didn't connect go in the note, split by source and by status:
  - `…these MCP servers from the repo's .mcp.json failed to connect…`, as today;
  - `…these of your own MCP servers failed to connect and are not in this session: <names>.`;
  - a server whose status is the one Task 0 Step 5 recorded for OAuth (expected `needs-auth`):
    `…<name> signs in with OAuth, which 10db doesn't support yet.`
- `allowedTools` never gains an `mcp__<your server>__*` entry: an allow rule would settle a call before the judge
  sees it.

**Per provider:** Claude plan, API, Bedrock and gateway alike. On a gateway, calls reach 10db's judge through T5's
hook.

- [ ] **Step 1: Write the failing rows** in the `buildMcpServers` and options tests:
  - `passes your stdio server as its launch, with no env block`
  - `passes your http server with its headers`
  - `writes 10db last`
  - `names a failed server of yours apart from the repo's`
  - `names your server that needs OAuth with the OAuth reason`
  - `allows no tool of your servers by rule`: for each judge value, the options' `allowedTools` has no `mcp__mine__`
    entry.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-session.test.ts src/sessions/claude-query-options.test.ts`
  The `allowedTools` row passes before the change. Prove it red by adding `mcp__${name}__*` for each of yours in
  `allowedToolsFor`, then revert, and name the mutation in the commit.
- [ ] **Step 3: Implement.** Pass `yourMcpServers: {}` from every caller that builds a spec, until Tasks 8 and 9
  fill it.
- [ ] **Step 4: Run them to see them pass, then `src/sessions` whole.**
- [ ] **Step 5: Commit** as `feat(daemon): claude sessions take the builder's mcp servers`, with a value card
  (`no_claim=what the classifier decides on a call`).

---

### Task 6: Codex sessions take your servers, in lanes and explore threads

**Files:**

- Create: `apps/daemon/src/sessions/codex-your-servers.ts`, `codex-your-servers.test.ts`
- Modify: `apps/daemon/src/sessions/codex-lane-config.ts` (`codexThreadConfig`) and M5b's explore thread-config
  builder (Task 0's name), each to add `codexYourServers(spec)`
- Modify: the Codex session's start (`sessions/codex-session.ts`), to map the OAuth status Task 0 Step 5 recorded
  into the note, as Task 5 does
- Modify: `apps/daemon/test/codex.live.test.ts` (two manual rows)

**Interfaces:**

- `codexYourServers(spec: Pick<AgentSessionCore, 'yourMcpServers'>, opts: { stdio: boolean }): Record<string, Record<string, unknown>>`.
  The lane and explore builders add its entries before `10db`:
  - stdio: `{ command, args, default_tools_approval_mode: <T5's value for project servers> }`, with no `env` block;
  - remote: `{ url, http_headers?, default_tools_approval_mode }`;
  - each with `enabled_tools`, `disabled_tools`, `startup_timeout_sec` and `tool_timeout_sec` where set (call 9);
  - with `stdio: false`, stdio servers are left out, and their names come back for the note.
- The lane builder passes `stdio: true`. The explore builder ships `stdio: false`, and turns to `true` only once
  Step 5's explore row passes: the explore thread reads none of the server's env, its args or its env file. Until
  then the note says
  `it runs in Codex chats and Plan once 10db closes their sandbox's read of its files`. A follow-up task closes it.
- The config travels over stdin, as today. It is never written to the Codex home.

**Per provider:** Codex (ChatGPT plan) only, in lanes and in M5b's chats and Plan threads.

- [ ] **Step 1: Write the failing rows** (pure):
  - `adds your stdio server as its launch, with no env block`
  - `adds your http server with its headers and filters`
  - `keeps 10db's entry and the project's`
  - `with stdio off, leaves stdio servers out and names them`
  - in the explore builder's test: `an explore thread gets your remote server`
- [ ] **Step 2: Run them to see them fail.** Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/codex-your-servers.test.ts src/sessions/codex-lane-config.test.ts`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass.**
- [ ] **Step 5: Add the live rows** (manual, never CI) to `test/codex.live.test.ts`, with Task 4 Step 7's server and
  positive controls. Each runs the same six probes as Task 4 Step 7, as shell commands in the thread:
  - `a builder stdio server answers in a Codex lane thread, and the lane's shell can't read its env, args, env file
    or ~/.claude.json`;
  - `the same in an explore thread on M5b's read-only sandboxPolicy`.

  Run: `TENDB_LIVE_CODEX=1 pnpm --filter @10db/daemon exec vitest run test/codex.live.test.ts -t "builder stdio server"`.
  If the lane row reads any of them, stop and report: Codex's `lane` profile has a gap beyond T6. If the explore row
  reads the env, the args or the env file, the explore builder keeps `stdio: false` and the follow-up is filed;
  only a passing explore row turns it to `true`.
- [ ] **Step 6: Commit** as `feat(daemon): codex sessions take the builder's mcp servers`, with a value card that
  records both live rows' results.

---

### Task 7: Your plugins' MCP servers, through 10db's launch

T2's wrapper (`wrapPlugin`) already keeps every plugin's MCP servers out of Claude Code, and links every other
top-level entry. This task brings the servers back through Tasks 3 to 6, so they start from the home with a sealed
env, and reach Codex too.

**Files:**

- Create: `apps/daemon/src/session-setup/plugin-mcp.ts`, `plugin-mcp.test.ts`
- Modify: `apps/daemon/src/session-setup/your-mcp-config.ts` (`readYourMcpConfig` reads the `plugins` it is given)
- Modify: `apps/daemon/src/session-setup/plan.ts` (T2's `planSessionSetup`): drop the item
  `<id>'s MCP servers: until 10db runs your MCP servers (T6)`, and its row in `plan.test.ts`

**Interfaces:**

- `readPluginMcp(plugin: { id: string; installPath: string }): YourMcpEntry[]`. It reads `<installPath>/.mcp.json`
  and the `mcpServers` of `<installPath>/.claude-plugin/plugin.json` (an object, or a relative path inside the
  plugin). Both go through `readRepoConfigFile` and the Task 2 entry schemas and refusals.
  - `${CLAUDE_PLUGIN_ROOT}` expands to `installPath` in env values, the url and headers, and `CLAUDE_PLUGIN_ROOT` is
    set in the server's env.
  - In a command or argument, `${CLAUDE_PLUGIN_ROOT}` is the one expansion allowed: it is a path, not a secret, and
    Claude Code writes plugin commands that way. It expands to `installPath` before Task 2's `${` check.
  - Source `plugin`, key `plugin:<id>:<name>`, and the session name `plugin_<pluginName>_<server>` (call 15), with
    `<pluginName>` the id before `@` and the form Task 0 Step 2 recorded.
- `readYourMcpConfig` adds the entries of every plugin `planSessionSetup` loads, so a plugin off by its switch
  brings none.

**Per provider:** every account kind gets a loaded plugin's servers through Tasks 5 and 6. Before this task, none
had them: T2's wrapper dropped them, and Codex has no plugin format.

- [ ] **Step 1: Read the format.** List `.mcp.json` and `.claude-plugin/plugin.json` of two installed plugins with MCP
  servers on the builder's Mac (`readInstalledPlugins`), and record the shapes in the commit.
- [ ] **Step 2: Write the failing rows.**
  - `plugin-mcp.test.ts`, over a temp install path:
    - `reads a plugin's .mcp.json server, CLAUDE_PLUGIN_ROOT expanded in its command and env`
    - `names it plugin_<plugin>_<server>`
    - `a plugin server whose session name fails McpServerName is refused with that reason, and the rest load`
    - `reads inline mcpServers from plugin.json`
    - `a plugin.json mcpServers path outside the plugin is refused`
    - `a link in the plugin's .mcp.json is refused`
    - `${TOKEN} in a plugin server's argument is refused`
  - `your-mcp-plan.test.ts`, new rows: `a plugin's server follows the plugin's switch`, `and its own`.
  - `plan.test.ts` (T2): the row `a plugin with a .mcp.json gets the MCP left-out item` becomes
    `a plugin with a .mcp.json gets no left-out item`.
- [ ] **Step 3: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup`
- [ ] **Step 4: Implement. Run them to see them pass, then `src/sandbox/plugin-wrapper.test.ts` unchanged** (the
  wrapper still drops `.mcp.json`).
- [ ] **Step 5: Commit** as `feat(daemon): bring the builder's plugin mcp servers through 10db's launch`, with a
  value card.

---

### Task 8: Lanes and passes start with your servers, and the policy says what they are

**Files:**

- Create: `apps/daemon/src/session-setup/your-mcp-for-session.ts`, `your-mcp-for-session.test.ts`
- Modify: `apps/daemon/src/runner/runner.ts`, beside T2's setup wiring and today's project MCP (`:2005-2070`,
  `:2335-2350`):
  - read `yourMcpForSession(...)`;
  - pass `plan.stdio` as `yourMcpServers` to `forSession`;
  - set the spec's `yourMcpServers` by joining each `laneSession.yourMcpServers[name]` with `plan.stdio[name].codex`,
    and each `plan.remote[name]` as `{ connect: { type, url, headers }, codex }`;
  - add `plan.leftOut` and `laneSession.yourMcpLeftOut` to T2's `leftOutNote`;
  - pass the session's server names to `buildTrustPolicy`.
- Modify: `apps/daemon/src/trust/policy.ts` (T3). `TrustPolicyInput` gains `yourMcpServers: readonly string[]`.
  When it is non-empty, `environment` gains, after the containment line:
  `Outside the sandbox: the MCP servers ${names.join(', ')} are the builder's own and run with the builder's access. Their tools can read and change anything the builder can, so judge each call to them under the four limits and the coordination rules above, as if the session made it directly.`
  `renderClaudeAutoMode` already carries `environment`, and T5's `renderAutoReviewPolicy` and `crossesLimit` read
  the same policy.
- Test: `apps/daemon/src/runner/runner.test.ts` (the `sandboxProbe` describe T2 Task 10 used),
  `apps/daemon/src/trust/policy.test.ts`, `apps/daemon/src/guard/judge.test.ts`

**Interfaces:**

- `yourMcpForSession(args: { db: DbReader; home: string; projectId: ProjectId; projectServerNames: readonly string[]; loginEnv: Readonly<Record<string, string>>; laneWritable: readonly string[]; localBinding: boolean; plugins: readonly { id: string; installPath: string }[] }): YourMcpPlan`.
  It composes `readYourMcpConfig`, `trustSwitchesFor`, `mcpApprovals` and `planYourMcp`. A file problem becomes a
  `leftOut` item. `laneWritable` is `laneWritableRoots(...)`.
- `projectServerNames` is every name in the repo's `.mcp.json` (`readRepoMcp(...).servers` and its ignored ones),
  whatever their approval (call 7).
- Without a lane sandbox (`opts.laneSandbox` null), your stdio servers are left out with
  `it runs only beside the lane sandbox, which is off`, as the project's are. Remote ones still go.
- A read-only step's guard keeps refusing your servers' tools (call 12): `guard/judge.ts:733-738` is unchanged.

**Per provider:** the same wiring for Claude and Codex lanes. The adapters differ (Tasks 5, 6). The policy line
reaches auto mode and 10db's judge alike.

- [ ] **Step 1: Write the failing tests.**
  - `your-mcp-for-session.test.ts`, over a temp home and real SQLite: `an approved server in ~/.claude.json is
    planned for the project, and a project override off drops it`.
  - `policy.test.ts`: `a session with your servers names them outside the sandbox in its environment; one without
    has no such line`.
  - `judge.test.ts`, a new row in the read-only table: `a read-only step refuses mcp__mine__ping`.
  - `runner.test.ts`:
    - `starts a lane with your approved server and names the one waiting for approval`: write `~/.claude.json` in
      the probe's temp home with two servers, and approve one. Expect the spec's `yourMcpServers` to hold it as a
      launch, and the prompt to name the other.
    - `a call to your server's tool reaches the judge and makes no card`: on the fake adapter, the session calls
      `mcp__mine__ping`. Assert the guard's verdict is the judge's (`JudgedRule.OutOfProxyTool` under T3's names),
      and that no Inbox item was made. One row per judge value. On `rules`, unattended, the call is a T4 skip.
    - `the lane's policy and its auto-mode settings carry the outside-the-sandbox line`.
    - `the prompt's note and the daemon log of a session start hold no env value, argument or URL text` (Review
      Focus 2): the server's env holds `sk-canary`, its argument `arg-canary`, and a refused server's URL
      `url-canary`. Read the prompt and the test logger's lines.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/session-setup/your-mcp-for-session.test.ts src/trust/policy.test.ts src/guard/judge.test.ts && pnpm --filter @10db/daemon exec vitest run src/runner/runner.test.ts -t "your approved server|your server's tool|outside-the-sandbox|no env value"`
  The read-only row passes before the change; prove it red by adding `mcp__mine__` to the read-only exception, then
  revert.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass, then the whole runner file unchanged.** Prove the log row red by logging
  the spec's `yourMcpServers` at debug, then revert.
- [ ] **Step 5: Commit** as `feat(daemon): lanes and passes start with the builder's mcp servers`, with one value
  card for the wiring, one for the policy line and one for the judged-call row, each naming its mutation.

---

### Task 9: Plan conversations and chats start with your servers, on Claude and Codex

**Files:**

- Modify: the Plan sandbox deps (`daemon/shape-session-tools.ts`, or the name Task 0 found). Call
  `yourMcpForSession` beside the project's servers, pass `yourMcpServers` into `forSession`, and return the joined
  `YourSessionServer`s and the left-out items with the sandbox.
- Modify: `apps/daemon/src/conversation/explore-owner.ts` (Plan's `spec`) and `apps/daemon/src/chat/hooks.ts` (the
  chat's), to set `yourMcpServers`, pass the names to `buildTrustPolicy`, and add the left-out note. Both run on
  each `spec` call, so a resumed session re-plans (call 14).
- Modify: `apps/daemon/src/shape/confinement.ts`. A call to one of the session's own servers' tools is judged as a
  project server's is, by the session's judge. It is never refused as an unknown tool.
- Test: `apps/daemon/src/shape/confinement.test.ts`, `apps/daemon/src/chat/hooks.test.ts`, the Plan spec test
  (explore-owner or service), and M5b's Codex explore options table

**Per provider:**

- Claude plan, API, Bedrock and gateway: Plan's main session and a chat get your servers.
- Codex (M5b): a chat and Plan get your remote servers, and your stdio servers per Task 6's explore row.
- Plan's subagents get none on Claude; on Codex, Plan has none (call 11).

- [ ] **Step 1: Write the failing rows.**
  - `confinement.test.ts`, one row per judge: `a call to your server's tool goes to the judge, not refused`.
  - `hooks.test.ts`: the M5a row `The MCP servers are exactly 10db's own plus the approved one` gains `and yours`.
  - `hooks.test.ts`: `a chat resumed after an approval starts with the newly approved server`: call `spec` once,
    approve a second server, call `spec` again with a resume id, and expect both.
  - The Plan spec test: `a Plan session starts with your approved server, and its agents get none`.
  - M5b's Codex explore options table:
    - `a Codex chat starts with your approved server`;
    - `Codex Plan starts with your approved server`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run src/shape/confinement.test.ts src/chat src/conversation src/sessions`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass, then `src/shape`, `src/chat`, `src/conversation` and `src/daemon` whole.**
- [ ] **Step 5: Commit** as `feat(daemon): plan conversations and chats start with the builder's mcp servers`, with
  a value card.

---

### Task 10: Settings › Trust lists, approves and switches your servers

A vertical slice: services, a route, two sections. It is run against the real backend before review.

**Files:**

- Modify: `apps/daemon/src/api/services.ts` (`approveYourMcpServer(input: ApproveYourMcpServer): TrustSettingsDto`),
  `apps/daemon/src/api/app.ts` (`POST /settings/trust/mcp-servers/approve`, body parsed by `ApproveYourMcpServer`)
- Modify: `apps/daemon/src/daemon/services.ts`:
  - `trustSettings()` fills `mcpServers` from `readYourMcpConfig` (with the loaded plugins) and `serverState`;
  - `on` is `switches.mcpServers[key] ?? enabledInSource`, and false unless the state is `approved`;
  - a stdio server `prepareYourMcpRun` refuses against `laneWritableRoots` today is `left_out` with that reason;
  - `mcpNotice` is set when the login env has `CLAUDE_CONFIG_DIR` or `CODEX_HOME` (`loginConfigDir`,
    `loginCodexHome`): `Your shell sets CLAUDE_CONFIG_DIR. 10db reads your servers from ~/.claude.json, not from
    there.` (and the `CODEX_HOME` sentence the same way), or null.
- Modify: `apps/daemon/test/trust-api.test.ts` (T2's harness, temp home)
- Modify: `apps/desktop/src/daemon/queries.ts` (`useApproveYourMcpServer`)
- Create: `apps/desktop/src/views/settings/your-mcp-servers.tsx`, `your-mcp-servers.test.tsx`
- Modify: `apps/desktop/src/views/settings/trust-section.tsx`, `project-trust-section.tsx`,
  `project-trust-section.test.tsx`, `trust-rows.ts`

**Interfaces:**

- **Approve:**
  - The daemon re-reads the config. When the key's current `configHash` differs from the body's, it throws
    `ConflictError`: `This server changed since the page loaded. Review it again.` (409), and stores nothing (Review
    Focus 3).
  - A `left_out` server throws `ConflictError` with its reason.
  - A plugin server throws `InvalidError`: `A plugin's servers come with the plugin.`
- **`trust-rows.ts`** gains the row `{ key: 'yourMcpServers', label: 'Your MCP servers', description, providers }`.
  - `description`: `The MCP servers in your ~/.claude.json, ~/.codex/config.toml and plugins. Each runs as Claude
    Code runs it, outside 10db's sandbox, from your home folder, and every call to it is judged. Applies from the
    next session.`
  - `providers`: `Claude and Codex sessions both get every approved server. Tool filters from config.toml apply in
    Codex sessions only. Servers that sign in with OAuth, and claude.ai connectors, are not here yet.`
  - **"Your plugins"** (T2's row) changes in the same commit. Its `providers` becomes: `Claude: skills, agents,
    commands and hooks, as Claude Code runs them. Their MCP servers are listed under Your MCP servers. Codex:
    skills, and the plugins' MCP servers.`
- **`YourMcpServers`** shows `mcpNotice` above the list when set, then each server: its name, the source label, and
  `Runs <command args>` or `Connects to <url>`. Then:
  - `Sets <NAME, NAME>` with names only, and `shownEnv` as `NAME=value`;
  - `Sends headers <Name, Name>`;
  - a state badge: `New`, `Changed`, or nothing;
  - `reason` for `left_out`, and no Approve and no switch;
  - an **Approve** button for `new` and `changed`. It opens a confirm `Modal`: `<name> runs outside 10db's
    sandbox, as Claude Code runs it, with your login environment, from your home folder. Its tools can read and
    change anything you can, and every call to them is judged.` When `sendsNoHeaders`, the modal adds: `It sends
    no headers. If it signs in with OAuth, it won't connect in 10db yet.` Its buttons are **Approve** and
    **Cancel**;
  - a `Switch` once approved;
  - for a plugin's server, `Comes with <pluginId>`;
  - `codexOnly` keys as `Codex only: enabled_tools`.
- **The project's Trust** has a `SegmentedControl` per approved server (`As app` / `On` / `Off`), as T2's plugins
  have.

**Per provider:** the per-provider note above. What each server does per provider is Tasks 5 to 7.

- [ ] **Step 1: Write the failing tests.**
  - `trust-api.test.ts`:
    - `lists a new server from ~/.claude.json with its hashed values and no secret`: the env holds
      `TOKEN=sk-canary` and `PATH=/usr/bin`; the DTO's JSON has `/usr/bin` and no `sk-canary` (Review Focus 2).
      Prove it red by putting every env entry in `shownEnv`, then revert.
    - `a server whose name has a space is listed left out, and the page loads` (Review Focus 5)
    - `an entry that can't be read is listed left out, and the page loads`: its `transport` is null.
    - `approves with the hash it showed, and the server is on`
    - `refuses a stale hash with 409 and stores nothing` (Review Focus 3): change the file between GET and POST.
    - `a server whose command is in a checkout is listed left out with its reason`
    - `a project's override turns one server off there only`
    - `names a CLAUDE_CONFIG_DIR the shell sets`
  - `your-mcp-servers.test.tsx` (msw, `renderApp('/settings/trust')`):
    - `shows a new server with Approve, and approving sends its key and hash`
    - `warns about OAuth when approving a server that sends no headers`
    - `a changed server shows Changed and Approve`
    - `a left-out server shows its reason and no switch`
  - `project-trust-section.test.tsx`: `Off for one server sends mcpServers with it false`.
- [ ] **Step 2: Run them to see them fail.**
  Run: `pnpm --filter @10db/daemon exec vitest run test/trust-api.test.ts && pnpm exec vitest run --project desktop apps/desktop/src/views/settings/your-mcp-servers.test.tsx apps/desktop/src/views/settings/project-trust-section.test.tsx`
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run them to see them pass, then typecheck, lint and knip.**
  Run: `pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/desktop typecheck && pnpm exec eslint --max-warnings=0 apps/daemon/src/api apps/daemon/src/daemon apps/desktop/src/views/settings && pnpm knip`
- [ ] **Step 5: Run it before review.** Run `pnpm dev`, and with `/browse` open Settings › Trust.
  - Approve one of the builder's real servers.
  - Start a task, and check the daemon log's `claude session mcp status` line: the server is `connected`.
  - Open a chat, and check that its tools list the server.
  - Turn it off for the project, and check that the next task's line doesn't list it.
  - Check there are no console errors.
- [ ] **Step 6: Commit** as `feat(desktop): settings › trust lists, approves and switches the builder's mcp servers`.
  Include the daemon route and services and the "Your plugins" text. Add value cards for the API contract and for
  the section.

---

### Task 11: The threat model, the rules and the decision

**Files:**

- Create, in `docs/architecture/decisions/`, a record named `<the date it lands>-the-builders-mcp-servers-run-outside-the-sandbox-from-home.md`,
  in the README's format. It records calls 1 to 15, the launch (Task 4), and why `npx` from the checkout is closed.
- Modify: `docs/architecture/03-trust-boundaries.md`:
  - §1's kernel-sandbox row: the builder's servers run outside it, by design;
  - a new §4.6.1 "Your MCP servers": the reading, the approval hash, the launch, `laneWritableRoots` and the
    refusal, what a lane can't reach, the policy line, and the Seatbelt and Codex measurements (Tasks 4, 6);
  - R1 and R2: the builder's servers are not processes whose code a lane can choose, which Task 4's refusal keeps
    true as far as 10db can see;
  - §7 "Known and accepted":
    - **the servers' tools act outside the sandbox.** A filesystem, shell, git or GitHub server can do anything the
      builder can. The judge weighs each call with the policy line; the sandbox doesn't bound them;
    - **the refusal is best effort.** A shim on PATH, an `sh -c` script, or a server that loads code from a
      checkout by its own logic passes it;
    - **coordination for MCP tools is told to the judge, not enforced** (call 13);
    - a builder server gets the builder's login environment, and its tool results reach the model, so an approved
      server can pass on what it holds;
    - literal arguments and URLs are visible to local processes, as in Claude Code;
    - a server that relied on the checkout as its folder sees the home;
    - a DNS name that resolves to loopback is not caught by call 10;
    - Claude ignores `config.toml`'s tool filters.
- Modify: `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` §11. The line "A judge's mistake is bounded
  by the sandbox" gains: `except for the builder's own MCP servers, whose tools act outside it with the builder's
  access (§6, call 16): a judge's mistake there is bounded only by what the server can do.`
- Modify: `apps/daemon/AGENTS.md`. The security rule names the builder's MCP servers as an exception, each one
  approved or installed by the builder. The `sandbox/` bullet names `lane-writable.ts` and `your-mcp-launch.ts`.
- Modify: `docs/superpowers/plans/2026-11-12-10db-sessions-roadmap.md`, "Follow-up tasks to file". Add:
  - `headersHelper`;
  - the local scope of `~/.claude.json`;
  - tool filters on Claude;
  - a `CLAUDE_CONFIG_DIR` or `CODEX_HOME` in the builder's shell;
  - stdio servers in Codex chats and Plan, if Task 6 left them out;
  - widen `SENSITIVE_NAME` to names ending `KEY` or `_PAT`, names holding `AUTH` or `DSN`, and any value that is a
    URL with userinfo, so fewer secrets are hashed and shown in Settings.
- Modify: `apps/daemon/test/lane-sandbox.live.test.ts`. A row: `a builder stdio server's tool answers in a Claude
  lane, and the lane's Bash can't read ~/.claude.json` (manual, never CI).

- [ ] **Step 1: Write the docs. Commit them** as `docs: the builder's mcp servers in the trust boundaries`.
- [ ] **Step 2: Run the live rows by hand.**
  Run: `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run test/lane-sandbox.live.test.ts -t "builder stdio server"`
  and Task 6's Codex rows. Expected: PASS. Record each in the PR body.

---

### Task 12: Adversarial review

- [ ] **Step 1: Dispatch the review.** Use the `code-reviewer` agent (opus). Give it this plan, Tasks 2 to 10, and
  the base commit, and tell it the round. It returns findings and doesn't edit. The attack list:
  1. **Lane-written code outside the sandbox:**
     - a launch from a folder a lane can link into;
     - a code-loading variable `LOADS_CODE` misses, or one split a way `prepareYourMcpRun` doesn't;
     - `npx` or `uvx` finding a project manifest above the home;
     - a `${VAR}` or `${CLAUDE_PLUGIN_ROOT}` that expands into a checkout path: the launch's refusal runs on the
       expanded server and Settings' listing on the declared one, so check the two can't disagree in the unsafe
       direction;
     - a link swapped after `realpath`;
     - a worktree base or temp root that `laneWritableRoots` misses.
  2. **The plugin path:** whether the wrapper still drops every plugin MCP declaration, and whether a plugin's
     servers now run with the checkout as their folder anywhere.
  3. **Secrets:**
     - a value in a log line, a DTO, an Inbox item, an error, a note, `ps` (argv or env, on Claude and Codex), the
       database, the Codex home's files or Claude Code's transcripts under the account config dir;
     - whether `setMcpServers` or Codex's thread config is written to disk anywhere a lane reads.
  4. **Approval:** a change that should ask again and doesn't (a value `SENSITIVE_NAME` hides that loads code, a
     `cwd`, a Codex key the hash leaves out); a race between GET and Approve.
  5. **Loopback:** a server whose headers reach a port a lane can bind, by a name call 10 misses.
  6. **Names:**
     - a builder server named so its tools match `mcp__10db__*`, or an allow rule;
     - a project `.mcp.json` that takes a builder server's name to replace it with a sandboxed look-alike
       (expected and accepted; confirm it gets no more than the project's own approval).
  7. **The sealed env file:** a lane that reads, writes or replaces it; the sweep removing a live daemon's.
  8. **Codex:** a `mcp_servers` key that lets Codex merge its own env back in, or run the server in the checkout;
     an explore thread that reads the files root.
  9. **Settings (Task 10):** a page that fails to load for one odd entry; a DTO that carries a secret; Approve for
     a key that isn't the one shown.
- [ ] **Step 2: Fix each blocking finding** (critical, data-loss, stuck-state, security, broken rule, or a
  user-visible spec finding) as its own red-first commit. The rest become follow-up tasks. A second round checks
  only those findings and what the fixes broke. There are at most two fix rounds.
- [ ] **Step 3: Gate.** The orchestrator runs `make gate` once on the final branch, then opens the PR
  `feat: the builder's mcp servers come along, approved once and judged`.
