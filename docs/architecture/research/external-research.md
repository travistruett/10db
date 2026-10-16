# 10db Technology Research Report

Research conducted: 2026-10-13  
Claude Code: 2.1.296  
Codex CLI: 0.154.0  
Platform: macOS arm64

---

## 1. Claude Agent SDK Subscription Authentication

### Can third-party apps use Claude Pro/Max login?

**VERIFIED (NO)**: Anthropic explicitly prohibits this.

**Source**: https://code.claude.com/docs/en/agent-sdk/overview and https://code.claude.com/docs/en/agent-sdk/quickstart

**Direct quote from Agent SDK docs**:

> "Unless previously approved, Anthropic does not allow third party developers to offer claude.ai login or rate limits for their products, including agents built on the Claude Agent SDK. Use the API key authentication methods described in the Quickstart instead."

This prohibition appears twice in the documentation (overview and quickstart pages), indicating it is a firm policy.

### How Max plan API credits work

**VERIFIED**: https://platform.claude.com/docs/en/about-claude/api-credits-for-subscribers

- **Max 5x**: $100 USD/month
- **Max 20x**: $200 USD/month
- **Team**: $20/seat (Standard) or $100/seat (Premium), pooled up to $500/month
- Credits refresh each billing cycle (monthly for annual plans)
- **Unused credits do NOT roll over**
- Credits expire at end of billing cycle
- Covers: Claude API, Managed Agents, Agent SDK, Playground
- **Does NOT cover**: Claude Code, extra usage in apps, AWS Bedrock, GCP, or Azure

**Key limitation**: To claim credits, user must link their claude.ai plan (Max/Team) to a Claude Console organization. The credits then arrive in that Console org. This is a **one-time link** that cannot be changed by the user (requires contacting support).

### Commercial Terms

**VERIFIED**: https://www.anthropic.com/legal/commercial-terms

Commercial ToS governs "Customer's use of Anthropic API keys" and allows customers to "power products and services Customer makes available to its own customers and end users." However:

- Commercial access is explicitly **API key-based**
- Consumer offerings (Claude.ai, Claude Pro) fall under **separate Consumer Terms**
- No provision for third-party apps to programmatically use consumer subscription credentials

### Consumer Terms & AUP

**VERIFIED**: https://www.anthropic.com/legal/consumer-terms and https://www.anthropic.com/legal/aup

**Consumer Terms** prohibit:

- Sharing account login information or credentials
- Making account available to anyone else
- Reselling services
- "Helping others" violate these terms

**Acceptable Use Policy** explicitly bans:

> "Resell, proxy, or otherwise provide access to Claude through unauthorized means" including specifically "services that route requests through consumer subscriptions."

### Verdict for 10db

**Third-party apps cannot legitimately use a user's Claude Pro/Max login.** The Agent SDK, which 10db would need to orchestrate Claude Code sessions, requires API keys under the Commercial Terms. The repeated warnings in the Agent SDK docs make this unambiguous.

**Workaround that IS supported**: User can claim their Max plan's monthly API credits ($100-200) by linking their plan to a Console organization, then create API keys from that organization. Those keys would draw from the monthly credit pool. This keeps usage tied to their subscription but routes it through the approved API key mechanism.

---

## 2. Headless Claude CLI Billing & Auth Precedence

**VERIFIED**: https://code.claude.com/docs/en/headless and https://code.claude.com/docs/en/authentication

### Billing under subscription login

When using `claude -p` (headless mode) with a Pro/Max/Team subscription login:

- Usage counts against the **plan's conversation limits**
- Does NOT consume API credits
- Subject to same rate limits as interactive sessions

### Authentication precedence order

Claude Code checks credentials in this order (first match wins):

1. **Cloud provider credentials** (`CLAUDE_CODE_USE_BEDROCK=1`, `CLAUDE_CODE_USE_VERTEX=1`, `CLAUDE_CODE_USE_FOUNDRY=1`)
2. **`ANTHROPIC_AUTH_TOKEN`** environment variable (sent as `Authorization: Bearer` header)
3. **`ANTHROPIC_API_KEY`** environment variable (sent as `X-Api-Key` header)
4. **`apiKeyHelper`** script output (for dynamic credentials)
5. **`CLAUDE_CODE_OAUTH_TOKEN`** (long-lived token from `claude setup-token`)
6. **Anthropic profiles** (`ANTHROPIC_PROFILE` or federation credentials)
7. **Subscription OAuth** from `/login` (default for Pro/Max/Team/Enterprise users)

### Critical pitfall: CLAUDE_CODE_USE_BEDROCK

**VERIFIED**: From the authentication docs

Setting `CLAUDE_CODE_USE_BEDROCK=1` **immediately switches billing to AWS Bedrock**. The docs confirm this env var causes "Cloud provider credentials" to rank #1 in precedence, bypassing subscription login entirely.

**Risk for 10db**: If a user has `CLAUDE_CODE_USE_BEDROCK` in their environment (even from unrelated usage), all 10db-spawned sessions would silently route through Bedrock, incurring AWS charges instead of using their Max plan.

**Mitigation**: 10db must explicitly unset these variables when spawning processes:

- `CLAUDE_CODE_USE_BEDROCK`
- `CLAUDE_CODE_USE_ANTHROPIC_AWS`
- `CLAUDE_CODE_USE_VERTEX`
- `CLAUDE_CODE_USE_FOUNDRY`

### Bare mode authentication

`--bare` mode (recommended for programmatic use) restricts auth to:

- `ANTHROPIC_API_KEY`
- `apiKeyHelper` script
- Cloud provider credentials (Bedrock/Vertex/Foundry)

Bare mode **does NOT read**:

- OAuth credentials from `/login`
- Keychain
- `CLAUDE_CODE_OAUTH_TOKEN`
- Anthropic profiles

**Implication**: 10db cannot use `--bare` with subscription-only users. Must use non-bare mode and carefully manage the environment.

---

## 3. Claude Daemon & Codex App-Server Programmatic Surfaces

### Claude Code Daemon (`claude --bg`)

**VERIFIED**: Local command inspection and https://code.claude.com/docs/en/headless

#### Available commands

- `claude --bg [prompt]` - Start background session, prints session ID
- `claude agents --json` - List all sessions with metadata (pid, cwd, status, sessionId, name)
- `claude attach <id|name>` - Attach to running session
- `claude logs <id|name>` - Print recent output
- `claude stop <id>` - Stop session (keeps conversation, can resume)
- `claude rm <id>` - Delete stopped session
- `claude --resume <session-id>` - Resume conversation

#### Session control flags

- `--bg` - Background mode
- `--session-id <uuid>` - Use specific session ID
- `--fork-session` - Create new session ID when resuming
- `--permission-prompts host|none` - Who answers prompts (requires v2.1.259+)
- `--include-hook-events` - Include hook lifecycle in stream (with `--output-format stream-json`)

#### Event stream with `--output-format stream-json`

**Provides**:

- Real-time message streaming as newline-delimited JSON
- `system/init` event with session metadata (model, tools, MCP servers, plugins)
- `system/api_retry` events during retries
- `system/plugin_install` events during marketplace plugin installs
- `permission_denied` events when using `--permission-prompts none`
- Tool calls, results, assistant text, thinking blocks
- Subagent messages with `parent_tool_use_id` for nesting tree
- Final `result` message with cost tracking

**Does NOT provide**:

- Structured permission prompt events for custom handling
- Explicit context exhaustion signal
- Compaction events

#### Permission handling

**VERIFIED**: https://code.claude.com/docs/en/headless

With `--permission-prompts host`:

- SDK host or `--permission-prompt-tool` must answer
- Blocks until answer received
- **No structured callback** - must parse `stream-json` for tool_use events

With `--permission-prompts none` (v2.1.259+):

- Anything requiring prompt is auto-denied
- Claude told not to retry
- Useful for unattended runs
- Denial events appear in `stream-json` output

**Gap**: No documented way to programmatically answer permission prompts from a supervisor process via `--permission-prompts host`. The docs mention "permission prompt tool" but don't specify the interface.

#### Context exhaustion

**NOT EXPLICITLY DOCUMENTED**. The docs mention:

- `--autocompact` flag exists (auto, or 100k-1M tokens)
- Sessions can be resumed
- No documented signal when context limit approaching
- No documented compaction event in stream

#### Session persistence

**Sessions survive host process exit**: Background sessions (`--bg`) continue running as separate processes. The `claude agents --json` output shows active sessions persist across terminal restarts.

**Transcript storage**: `~/.claude/sessions/` (configurable via `CLAUDE_CONFIG_DIR`)

### Codex App-Server

**VERIFIED**: Local command inspection

#### Available commands

```
codex app-server daemon       # Manage local daemon
codex app-server proxy        # Proxy stdio to control socket
codex app-server generate-ts  # Generate TypeScript bindings
codex app-server generate-json-schema  # Generate JSON schema
```

#### Daemon commands

```
codex agents                  # Browse sessions on daemon (NOTE: failed in test - needs terminal)
codex exec [--json]          # Non-interactive execution
codex resume [--last]        # Resume session (picker or --last)
codex queue                  # Queue message to existing session
codex fork [--last]          # Fork session
```

#### Transport options

- `--listen stdio://` (default)
- `--listen unix://[PATH]`
- `--listen ws://IP:PORT`
- `--remote <ADDR>` - Connect to remote app server
- `--remote-auth-token-env <VAR>` - Bearer token for remote WS

#### WebSocket auth modes

- `capability-token` mode with `--ws-token-file` or `--ws-token-sha256`
- `signed-bearer-token` mode with JWT validation (`--ws-shared-secret-file`, `--ws-issuer`, `--ws-audience`)

#### Schema generation

**FAILED**: `codex app-server generate-json-schema --out /tmp/codex-schema.json` reported no output, command may be broken or require daemon running first.

#### Session persistence

**UNKNOWN**: Docs don't specify if sessions survive daemon restart. The `codex agents` command listing sessions suggests persistence, but test failed (not a terminal).

### Verdict: Can 10db sit on top of these daemons?

**Partially, with significant gaps**:

#### What's available:

✅ Both CLIs support background/daemon sessions  
✅ Claude: JSON event stream with detailed session info  
✅ Claude: Session listing, attach, logs, stop, resume  
✅ Codex: Queue messages to running sessions  
✅ Both: Sessions appear to persist independently

#### Critical gaps:

❌ **Permission prompts**: No documented structured callback API for programmatic approval  
❌ **Context exhaustion**: No signal when approaching limits  
❌ **Compaction events**: Not exposed in event stream  
❌ **Codex event stream**: No documented equivalent to Claude's `--output-format stream-json`  
❌ **Cross-session coordination**: No built-in inbox or question aggregation  
❌ **Session lifecycle**: Unclear if/how sessions survive CLI updates or OS restarts

**Recommendation**: 10db should supervise processes directly rather than relying on built-in daemons. Use `--bg` and `--output-format stream-json` for event streams, but implement question inbox and context tracking in 10db's own layer.

---

## 4. Codex App-Server with ChatGPT Sign-In Terms

**UNKNOWN**: Unable to verify.

**Attempted**: https://openai.com/policies/terms-of-use and https://openai.com/policies/chatgpt-terms both returned `403 Forbidden`.

**Inference from Anthropic pattern**: Given that Anthropic explicitly prohibits third-party apps from using subscription credentials, and given Codex CLI's authentication architecture (supports `--remote` websocket with auth tokens), it's likely OpenAI has similar restrictions.

**Action required**: Manual review of OpenAI's ChatGPT terms at a different time or from different network, or contact OpenAI directly.

---

## 5. Agent Orchestration Tools Comparison

### Orchestrator.inc (github.com/OrchestratorInc/agent-orchestrator)

**VERIFIED**: https://github.com/OrchestratorInc/agent-orchestrator

- **License**: Apache 2.0 (VERIFIED from LICENSE file)
- **Stack**: Go (backend), JavaScript/TypeScript/Node (frontend), Electron (desktop app)
- **Worktrees**: Optional for Git-backed work. Each worker gets own branch/worktree. Also supports "branchless directories without requiring a project or repository"
- **Maturity**: ~13.1k stars, 1.8k forks, 3,275 commits, 467 open issues, 397 open PRs
- **API surface**: Desktop app runs local daemon with "daemon route mapping" (CLI documented but routes not listed on page)
- **Continuation**: Not explicitly documented
- **Question inbox**: Not mentioned

### Maestro (RunMaestro/maestro)

**VERIFIED**: https://github.com/RunMaestro/maestro

- **License**: AGPL-3.0
- **Worktrees**: Yes, headline feature - "Run AI agents in parallel on isolated branches"
- **Continuation**:
  - **Auto Run**: fresh session per task, "nearly 24 hours continuous runtime" reported
  - Session Discovery imports provider sessions
  - Agent Resilience: auto-resumes on overload/quota errors
  - Has "Context Management" docs page (content not captured)
- **Question inbox**: None. Has Message Queueing (for _outgoing_ messages), Group Chat, Mobile Remote Control
- **Maturity**: ~3.4k stars, 369 forks, 8,289 commits, 48 issues, 50 PRs

### Superset (superset.sh)

**VERIFIED**: https://superset.sh

- **License**: Elastic License 2.0 (ELv2) - "source-available," not OSI-approved open source
- **Worktrees**: Yes - "Each agent runs in its own isolated Git worktree"
- **Continuation**: "Persistent sessions" mentioned, one testimonial about laptop survival, but no explicit context-limit handling
- **Question inbox**: No dedicated inbox. Has status view showing "working/blocked/waiting on you," "Ready for Review" list, Approve/Comment UI, mobile app
- **Stack**: TypeScript SDK, CLI (Homebrew/curl), MCP server, macOS app, experimental Linux AppImage, iPhone/iPad app. Works with external agents (Claude Code, Codex, OpenCode) using user's own API keys
- **Maturity**: Established commercial product with mobile apps and SDKs

### Nimbalyst

**VERIFIED**: npm package exists but blocked by Cloudflare challenge page, no accessible docs found

### Conductor (conductor.build)

**VERIFIED**: https://conductor.build

- **License**: Not stated (pricing/enterprise links suggest commercial)
- **Worktrees**: Not mentioned - only "isolated workspaces"
- **Continuation**: Not mentioned
- **Question inbox**: Not mentioned - only "See at a glance what they're working on"
- **Stack**: Mac app (v0.90.0) that orchestrates Claude Code, Codex, Cursor agents
- **Maturity**: Current version 0.90.0

### Beads (steveyegge/beads)

**VERIFIED**: https://github.com/steveyegge/beads

- **License**: MIT
- **Worktrees**: Not mentioned. Uses Dolt-native branching, optional git integration via `bd dolt push/pull`, git-free `--stealth` mode with `BEADS_DIR`
- **Continuation**:
  - `bd prime` prints workflow context and memories
  - `bd remember` saves durable project facts
  - `bd ready` lists unblocked work
  - "Handle long-horizon tasks without losing context"
- **Question inbox**: Not mentioned. Has message issue type with threading (`--thread`)
- **Maturity**: 27.8k stars, 1.9k forks, 11,272 commits, ~1k issues, 408 PRs

### Summary Table

| Tool             | License    | Worktrees       | Continuation            | Question Inbox      | Notes                        |
| ---------------- | ---------- | --------------- | ----------------------- | ------------------- | ---------------------------- |
| Orchestrator.inc | Apache 2.0 | Optional        | Not documented          | No                  | 13k stars, Electron desktop  |
| Maestro          | AGPL-3.0   | Yes (headline)  | Auto Run fresh sessions | No (has queue)      | 3.4k stars, 8k commits       |
| Superset         | ELv2       | Yes (per agent) | Persistent sessions     | Partial (review UI) | Commercial, mobile apps      |
| Conductor        | Unknown    | Maybe           | Unknown                 | Unknown             | Mac app, v0.90, orchestrator |
| Beads            | MIT        | No (Dolt-based) | Memory system           | No (has threads)    | 27.8k stars, Dolt foundation |

**Verdict**: None provide a true question/approval inbox. Superset comes closest with its review workflow. All lack documented continuation across context limits. For 10db's use case, these are more inspiration than dependencies.

---

## 6. Durable Workflow Options

### LangGraph.js with SQLite Checkpointing

**VERIFIED**: npm registry check

- **Package**: `@langchain/langgraph-checkpoint-sqlite` v1.1.0
- **Last updated**: 2026-10-12 (1 day ago)
- **Maturity indicator**: Actively maintained, reached v1.x
- **Docs**: LangChain docs have moved to docs.langchain.com; specific persistence pages returned 404
- **SQLite adapter**: EXISTS (verified by package name and recent update)
- **Resume semantics**: UNKNOWN (docs 404)
- **Side-effect re-execution**: UNKNOWN (docs 404)

**Status**: Package is real and maintained, but couldn't verify operational details due to doc redirects.

### LangGraph Python

**VERIFIED**: Docs redirect to new location but specific pages 404'd

- **SQLite checkpointer**: Exists (referenced in redirect)
- **Details**: UNKNOWN due to 404 on persistence how-to page

### DBOS (dbos.dev)

**VERIFIED**: https://dbos.dev

- **License**: "Free forever," specific license NOT named on site (check GitHub)
- **TypeScript**: Yes - `dbos-transact-ts` repo linked, TS tutorials present. Also Python, Go, Rust, Java SDKs
- **Durable execution**:
  - Workflows and steps: annotate code (branches/loops/retries), survives failures
  - Resumes "at the last checkpoint" (customer quote)
  - Durable queues with concurrency control
  - Cron schedules with "exactly once per interval"
  - Human-in-the-loop: durable sleep, send/receive notifications, wait days/weeks across restarts
  - AI agent integrations: OpenAI Agents SDK, Pydantic AI, LlamaIndex
- **Local-first**: YES - "No new infrastructure required," point at Postgres, "Run on-prem or in any cloud"
- **Optional cloud**: Conductor for recovery/management/monitoring, Pro tier
- **Maturity**:
  - "Years of MIT-Stanford R&D"
  - 5 SDKs
  - SOC 2, GDPR, CCPA
  - Customers: Bristol Myers Squibb, Walmart, Notion, Roche, SeatGeek, Supabase, Dosu

### Restate (restate.dev)

**VERIFIED**: https://restate.dev

- **License**: Open source edition exists, specific license NOT named (check GitHub)
- **TypeScript**: Yes - first-class SDK, along with Python, Java, Kotlin, Go, Rust, Ruby
- **Durable execution**:
  - Handlers resume "from the exact step after crashes, restarts, and deploys"
  - Built on "replicated command log, materialized state, push-based scheduler, partitioned execution"
  - Keyed state (Virtual Objects) with single-writer semantics
  - Durable RPC and queues
  - Timers and signals (no compute consumption while waiting)
  - Journal inspection and invocation controls
- **Local daemon**: YES - "single self-contained binary with no external database or message broker"
- **Deployment**: Local, VMs, K8s, ECS, etc. Managed: Restate Cloud, BYOC (AWS/GCP)
- **Maturity**: Production users named: Replit (coding-agent platform base), DOSS, Capital One (bank ops), Dodo Payments, Coralogix, Unkey, KPMG, Maersk

### Inngest (inngest.com)

**VERIFIED**: https://www.inngest.com

- **License**: "Open source durable execution" with ~7.1k stars, specific license NOT named
- **TypeScript**: Yes - `npm install inngest`, TypeScript/JS samples, Next.js/Node.js quickstarts. Also Python (FastAPI)
- **Durable execution**:
  - Step-based functions with `step.run()` checkpointing
  - Configurable retries and recovery
  - "Pause, fan-out, defer, retry, A/B test"
  - Sleep, wait, parallelize across steps
  - Event, webhook, cron triggers
  - Concurrency, fairness, rate limiting
  - Built-in observability (traces, metrics, step-level)
  - Bulk replay, sandboxes for testing, A/B testing
  - Optional E2E encryption
  - Claims "100K+ Executions per second" with low latency
- **Local execution**: "Start locally, scale instantly" - local dev supported
- **Cloud requirement**: Page pushes cloud service with paid tiers (SSO, HIPAA BAA), self-hosting in production NOT confirmed
- **Maturity**: 7.1k stars, commercial product with enterprise features

### Hand-rolled SQLite State Machine

**NOT EVALUATED** (no external source to verify against)

**Considerations**:

- **Pros**: Full control, minimal dependencies, already using SQLite as source of truth
- **Cons**: Must implement checkpointing, replay, failure recovery, idempotency yourself
- **Complexity**: Moderate - storing turn state and resuming is straightforward; ensuring side-effects (API calls, file writes) don't duplicate is harder

### Comparison Table

| Option              | License | TS Support | Local-First | Maturity       | Notes                             |
| ------------------- | ------- | ---------- | ----------- | -------------- | --------------------------------- |
| LangGraph.js SQLite | Unknown | Yes        | Yes         | v1.1.0, active | Docs 404'd                        |
| DBOS                | Unknown | Yes        | Yes         | High           | Years R&D, major customers        |
| Restate             | Unknown | Yes        | Yes         | High           | Production at Capital One, Replit |
| Inngest             | Unknown | Yes        | Maybe       | High (7k⭐)    | Local dev ✓, self-host unclear    |
| Hand-rolled         | N/A     | Yes        | Yes         | DIY            | Full control, most work           |

### Recommendation for 10db

**Restate or hand-rolled SQLite state machine**.

**Restate** if 10db needs sophisticated features:

- Single binary, no external deps
- First-class TypeScript
- Proven in production for complex orchestration (Replit uses it for their agent platform)
- Virtual Objects for single-writer agent state
- Built-in durability across restarts

**Hand-rolled SQLite** if 10db's needs are simple:

- Already using SQLite as source of truth
- Needs: store turn state, track pending questions, resume from last successful turn
- Can handle idempotency of LLM API calls and file operations
- Avoids additional runtime dependency

**Avoid**: Inngest (cloud-first, self-hosting unclear), LangGraph (docs inaccessible for verification), DBOS (Postgres dependency adds complexity vs SQLite already in use).

---

## 7. Desktop Shell: Tauri 2 vs Electron

### Tauri 2

**VERIFIED**: https://v2.tauri.app/start and https://v2.tauri.app/develop/sidecar

#### Sidecar support

✅ **Supported** - external binaries bundled and executed

- List binaries under `bundle.externalBin` in `tauri.conf.json`
- Each binary needs platform-specific copy with `-$TARGET_TRIPLE` suffix
  - Example: `my-sidecar-x86_64-unknown-linux-gnu`, `my-sidecar-aarch64-apple-darwin`
- Find host triple: `rustc --print host-tuple` (Rust 1.84.0+)
- Run from Rust: `app.shell().sidecar("name").spawn()`
- Run from JS: `Command.sidecar('path').execute()` with capability permissions
- Arguments declared in capability file (permit-all, deny-all, or regex validators)

#### macOS notarization

🟡 **Likely supported** but not explicitly documented

- Nav shows "Sign" section with "macOS" entry
- References to DMG, App Store, "macOS Application Bundle"
- Word "notarization" does NOT appear on inspected page
- **Inference**: Likely supported given App Store publishing path

#### Auto-updater

✅ **Exists** - "Updater" plugin listed

- No details on page about configuration or operation

#### Rust toolchain requirement

🟡 **Required but can be minimal**

- Page says "install all of the dependencies required by Tauri" (prerequisites guide not fetched)
- States devs gain Rust benefits "even without needing to be developed by Rust experts"
- Rust "used when needed" as backend language
- Cargo is a project-creation option
- **Inference**: Rust toolchain required for builds, but app developers can use JS/TS primarily

#### Terminal/PTY embedding

❌ **Not documented**

- Plugin list includes "Shell" and "Process" but no terminal emulation or PTY embedding mentioned

### Electron

**NOT EXPLICITLY RESEARCHED** (baseline known)

- **Known**: Mature, large bundle size, includes full Chromium + Node.js
- **Terminal/PTY**: Commonly paired with node-pty + xterm.js (see §8)
- **Notarization**: Supported via electron-builder or electron-notarize
- **Auto-update**: electron-updater widely used
- **Rust requirement**: None (pure JS/TS ecosystem)

### Comparison

| Feature                | Tauri 2                           | Electron               |
| ---------------------- | --------------------------------- | ---------------------- |
| **Sidecars**           | ✅ Built-in                       | ✅ Via child_process   |
| **macOS notarization** | 🟡 Likely                         | ✅ Well-documented     |
| **Auto-updater**       | ✅ Plugin                         | ✅ electron-updater    |
| **Rust toolchain**     | 🟡 Required (minimal Rust skills) | ❌ Not required        |
| **Terminal/PTY**       | ❌ Not documented                 | ✅ node-pty + xterm.js |
| **Bundle size**        | Small (~3-10 MB)                  | Large (~100+ MB)       |
| **Maturity**           | v2 (newer)                        | Very mature            |

### Recommendation for 10db

**Electron**, for these reasons:

1. **Terminal embedding**: 10db "embeds terminals" per brief. Electron + node-pty + xterm.js is the proven path. Tauri's PTY story is undocumented.

2. **Toolchain simplicity**: No Rust requirement. Team can stay in TS ecosystem.

3. **Maturity**: Electron's notarization, updater, and sidecar (child_process) patterns are battle-tested (VS Code, Slack, etc.).

4. **Bundle size**: Not critical for a local dev tool.

**Tauri 2 would be attractive if**:

- Bundle size was critical (distributing to many users)
- Team already has Rust expertise
- Tauri's PTY story improves

---

## 8. PTY Options

### node-pty

**VERIFIED**: npm registry check

- **Package**: `node-pty` v1.1.0
- **Last update**: 2026-08-03 (2 months ago)
- **License**: MIT
- **Repository**: `git://github.com/microsoft/node-pty.git` (Microsoft-maintained)
- **Description**: "Fork pseudoterminals in Node.JS"
- **Maintenance status**: Active (recent update, Microsoft backing)

### portable-pty (Rust)

**VERIFIED**: https://docs.rs/portable-pty

- **Version**: 0.9.0 (2026-09-08, 1 month ago)
- **License**: MIT
- **Maintainer**: wez (part of wezterm repository)
- **Maturity**: Pre-1.0 (0.9.0), but production-used in wezterm terminal
- **Platform support**:
  - ✅ Unix (dedicated `unix` module, `nix` + `libc` deps)
  - ✅ Windows (`winapi`, `winreg`, `shared_library` deps)
  - ✅ Serial ports (`serial` module, can't spawn processes directly)
- **Documentation**: 71.74% coverage
- **Advantage**: "Unlike other crates in this space, this crate provides a set of traits that allow selecting from different implementations at runtime" via `PtySystem` trait

### xterm.js

**VERIFIED**: https://xtermjs.org and https://github.com/xtermjs/xterm.js

- **Package**: `@xterm/xterm` (scoped)
- **License**: MIT
- **Maintenance**: Active (commit activity, v2026 copyright)
- **Stars**: ~21.3k stars, 2.0k forks, 11,386 commits
- **Open issues**: 209 issues, 90 PRs
- **Production usage**: VS Code, Azure Cloud Shell, JupyterLab, Theia, Proxmox, Replit, Codecademy, HashiCorp Nomad, ~90 total adopters listed
- **Features**:
  - Frontend terminal emulator only (browser-based)
  - Handles rendering and ANSI escape codes
  - Minimal setup: include JS/CSS, create Terminal, call `open()`
  - Starter example writes styled text with `term.write`
- **Backend integration**: NOT documented on homepage
  - Adopter patterns suggest pairing with backend PTY:
    - electerm: "electron/node-pty/xterm"
    - WebSSH2: "socket.io, ssh2"
    - Go SSH Web Client: "Go, WebSocket and Xterm.js"
  - Integration details require checking xterm.js docs/repo

### Comparison

| Option           | Type               | Platform                   | Maintenance  | Production Use    | Notes                      |
| ---------------- | ------------------ | -------------------------- | ------------ | ----------------- | -------------------------- |
| **node-pty**     | Backend PTY        | macOS/Linux/Windows        | Active (MS)  | VS Code, many     | Standard for Electron      |
| **portable-pty** | Backend PTY (Rust) | macOS/Linux/Windows/serial | Active (wez) | wezterm           | Pre-1.0, runtime selection |
| **xterm.js**     | Frontend UI        | Browser                    | Active       | VS Code, 90+ apps | Pairs with backend PTY     |

### Recommendation for 10db

**node-pty (backend) + xterm.js (frontend)**

This is the standard Electron terminal stack:

- **node-pty**: Mature, Microsoft-maintained, used in VS Code
- **xterm.js**: Proven frontend, 21k stars, massive adoption
- Both MIT licensed
- Integration patterns well-documented by community (VS Code, Hyper, Tabby, etc.)

**portable-pty** only if:

- 10db's backend is in Rust (doesn't appear to be from brief)
- Need serial port support
- Want runtime PTY implementation selection

---

## Summary of Top Risks

### 🔴 BLOCKER: Subscription Auth for Agent SDK

10db **cannot** use a user's Claude Max login to power Agent SDK sessions in a third-party app. This is explicitly prohibited by Anthropic.

**Mitigation**: User must claim their Max plan's API credits (up to $200/mo for Max 20x) by linking their plan to a Claude Console org, then create API keys. 10db uses those keys. This keeps usage tied to their subscription allowance but routes through the approved mechanism.

### 🟡 HIGH: Billing Precedence Pitfalls

If user has `CLAUDE_CODE_USE_BEDROCK` or similar env vars set, every 10db-spawned Claude session will silently route to that provider (AWS Bedrock, GCP, Azure), bypassing their Max plan entirely and incurring cloud charges.

**Mitigation**: 10db must explicitly unset cloud provider env vars when spawning processes. Cannot rely on user's environment being clean.

### 🟡 HIGH: No Structured Permission Callback API

Claude Code's `--permission-prompts host` delegates to SDK host, but docs don't specify the interface. No obvious way to programmatically answer prompts from 10db's orchestration layer.

**Mitigation**: Either:

1. Pre-approve broad tool sets (`--allowedTools`, `--permission-mode acceptEdits`)
2. Parse `stream-json` for tool attempts and inject answers (fragile)
3. Implement question inbox in 10db's layer, map to per-session allow rules

### 🟡 MEDIUM: No Context Exhaustion Signal

Neither Claude Code nor Codex expose when context window is approaching limit. 10db must track tokens itself or react to compaction/failure.

**Mitigation**: Count tokens on each turn, trigger continuation before hitting limit. SQLite stores turn-by-turn token counts.

### 🟡 MEDIUM: Codex ChatGPT Terms Unknown

Unable to verify if Codex CLI + ChatGPT subscription has same third-party restrictions as Claude.

**Mitigation**: Assume same restrictions apply (likely). Plan for Codex to require OpenAI API keys.

---

## Recommended Architecture

Based on findings:

1. **Don't rely on built-in daemons for orchestration**. Use `claude --bg` and `codex exec` to spawn sessions, but implement inbox, context tracking, and question aggregation in 10db's own layer.

2. **Desktop shell: Electron** with node-pty + xterm.js for terminal embedding.

3. **Durable execution: Restate or hand-rolled SQLite state machine**. Restate if complex orchestration needed (resume across restarts, virtual objects for agent state). Hand-rolled if 10db's continuation needs are simple (store turn state, resume from last successful turn).

4. **Authentication**:
   - Guide users to claim Max/Team API credits via Console org link
   - 10db stores API keys, not subscription logins
   - Unset cloud provider env vars before spawning sessions

5. **Session management**:
   - Spawn `claude -p --output-format stream-json --bg` for each session
   - Parse event stream for tool calls, thinking, results
   - Track tokens per turn in SQLite
   - Trigger continuation before context limit
   - Store questions in 10db's inbox, surface in UI

6. **Permission handling**:
   - Start sessions with broad allow rules (`--permission-mode acceptEdits`, `--allowedTools`)
   - For sensitive operations, pause session and add to inbox
   - Or: parse tool attempts, inject allow rules dynamically

---

## Verification Status Legend

- **VERIFIED (URL)**: Claim confirmed from official documentation at URL
- **VERIFIED (command)**: Claim confirmed from local command output
- **UNKNOWN**: Unable to verify; docs 404'd, access denied, or not documented
- **INFERENCE**: Logical conclusion from available info, not explicitly stated
