# Trust line research: what 10db restricts today, what other tools do, and what Claude and Codex offer

Gathered 2026-11-12 for `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md`. Four parts: an inventory
of 10db's restrictions read from the code and decisions, multi-provider harnesses, orchestrators, and the judges
Claude Code and Codex ship. External pages were read on 2026-11-12; doc pages are unversioned unless a version is
named.

## 1. What 10db restricts today

Read from the code and the decision records. Paths are relative to `apps/daemon/src/` unless they start with
`docs/`. About 130 restrictions in all; the rows below are the ones the design acts on.

### Config and context

| Restriction                                                                                                                                                 | Surface          | Source                                                                                            |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------------------------------- |
| No settings file loads in a sandboxed session (`settingSources: []`), so no user or project hooks, skills, commands, `CLAUDE.md` or rules                   | lane, pass, Plan | `sessions/claude-adapter.ts:310-317`, `sessions/claude-shape.ts:98-102`                           |
| Lanes and passes get only 10db's harness plugin (5 skills, 5 personas); Plan gets no plugin                                                                 | lane, pass, Plan | `sessions/claude-adapter.ts:323-326`; `packages/harness/plugin/`                                  |
| `~/.claude`, `~/.claude.json`, `~/.codex`, `~/.agents` are protected reads, so a skill there can't even be read                                             | all              | `sandbox/protected-reads.ts:17-25`                                                                |
| The project's `AGENTS.md` is not injected anywhere. A lane's briefing tells it to read the file; Plan isn't told                                            | lane, Plan       | `briefing/prompts.ts:243-249`; `shape/policy.ts`                                                  |
| Codex runs under a per-account `CODEX_HOME` and an empty `HOME`; skills instructions, memories, apps and plugins are off; the project is pinned `untrusted` | Codex lane       | `sessions/codex-home.ts:58-84`; `decisions/2026-11-05-codex-lanes-use-codex-sandbox-and-hooks.md` |
| No personal MCP servers; only the project's approved `.mcp.json` servers, over the control channel                                                          | all              | `sessions/claude-adapter.ts:315-317`                                                              |

### Web

| Restriction                                                                                                                                                           | Surface    | Source                                                                                                       |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------ |
| Plan's own session can't use `WebSearch` or `WebFetch`; only a `researcher` subagent can, with a 1,500-character question, `https` on port 443, no IPs or local names | Plan       | `shape/confinement.ts:41-46,254-313`; `decisions/2026-11-03-plan-researches-the-web-through-a-researcher.md` |
| Every `WebSearch` and `WebFetch` call is a card                                                                                                                       | lane, pass | `guard/pre-tool-use.ts:23-51`                                                                                |
| Codex `web_search` is disabled                                                                                                                                        | Codex lane | `sessions/codex-home.ts:58-84`                                                                               |
| Code an agent runs reaches only the project's listed hosts; on Codex a refused host fails with its output lost                                                        | lane, gate | `sandbox/project-access.ts:286`; `briefing/prompts.ts:240-256`                                               |

### Commands and tools

| Restriction                                                                                                                                                 | Surface    | Source                                                                                                                |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- | --------------------------------------------------------------------------------------------------------------------- |
| Lanes run in Claude's auto mode; 10db adds hard denies for the full gate and CPU load and a soft deny for paths outside the worktree, on top of `$defaults` | lane       | `sandbox/auto-mode-rules.ts:17-38`                                                                                    |
| Plan: every command that isn't read-only is a card; `cd`, `$(...)` and backticks card; background jobs, `nohup`, `Monitor` refused                          | Plan       | `shape/confinement.ts:104-169`                                                                                        |
| A lane's non-allow-listed Bash stops on an "Allow Bash?" card; the briefing warns "overnight can be hours"                                                  | lane, pass | `briefing/prompts.ts:197-205`                                                                                         |
| git: a read-only allowlist; commit, push, branch and every other write refused                                                                              | lane, pass | `guard/git-rules.ts:5-82`                                                                                             |
| gh: reads only                                                                                                                                              | lane, pass | `guard/gh-rules.ts:1-112`                                                                                             |
| Deploy and publish commands (`vercel deploy`, `terraform apply`, `kubectl apply`, `npm publish` and others) refused                                         | lane, pass | `guard/judge.ts:100-108`                                                                                              |
| Shell the guard can't read (ANSI-C escapes, decoded words, `env -S`, a pipe into a shell) refused                                                           | lane, pass | `guard/judge.ts:197-201,592-625`                                                                                      |
| Every project MCP tool call is a card unless a stored grant covers it                                                                                       | all        | `guard/pre-tool-use.ts:114-125`; `decisions/2026-11-05-one-answer-allows-every-tool-an-approved-mcp-server-listed.md` |
| Builder tools (`create_task`, `start_task` and the rest) are absent from Plan and lanes                                                                     | Plan, lane | `decisions/2026-10-29-builder-mcp-endpoint.md`                                                                        |

### Sandbox and secrets (kept)

| Restriction                                                                                                | Source                                                                     |
| ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------- |
| Writes only in the checkout and the session's temp dir; reads denied from `/` with an allowlist            | `sandbox/profile.ts:344-356`                                               |
| `.env*` and toolchain secret files denied; env names matching `TOKEN`, `SECRET`, `KEY` and similar dropped | `sandbox/profile.ts:346-352`; `sandbox/env-allowlist.ts:1-63`              |
| Writes to `.claude/settings*.json`, `.mcp.json`, `.claude/hooks`, shell rc files ask                       | `sandbox/file-access.ts:75-93`                                             |
| Docker off until the project turns it on                                                                   | `decisions/2026-11-08-a-project-turns-docker-on-for-its-gate-and-lanes.md` |
| Pinned, checksummed Claude Code and Codex                                                                  | `decisions/2026-11-08-10db-runs-pinned-copies-of-codex-and-claude-code.md` |

### Coordination (not security)

Claims and hazards (`guard/judge.ts:141-166`), page areas and the folder hold (`pass/folder.ts`,
`decisions/2026-11-09-a-page-file-is-the-pages-alone-in-a-pass.md`), "only 10db commits and pushes" and "the gate
is 10db's" (`decisions/2026-10-29-lanes-leave-the-gate-to-10db.md`), and installs through the daemon. They keep
parallel writers from colliding.

## 2. Multi-provider harnesses

**Pi** (badlogic/pi-mono, `@mariozechner/pi-coding-agent`):

- "Runs in full YOLO mode and assumes you know what you're doing": no permission prompts for files or commands.
  Its author calls other agents' measures "mostly security theater". There is no sandbox: "run pi inside a
  container" if you want one. (https://mariozechner.at/posts/2025-11-30-pi-coding-agent/)
- It reads Agent Skills (`SKILL.md`) from `~/.agents/skills` and `.agents/skills`
  (https://github.com/badlogic/pi-mono/blob/main/packages/coding-agent/docs/skills.md).
- It has no web tool (the agent uses `curl`) and no MCP ("does not and will not support MCP").
- It signs into Claude Pro and Max plans directly. A third-party page reports account lockouts; unread.

**OpenCode** (https://opencode.ai/docs/):

- Permissions are `allow`, `ask` or `deny`. The default allows everything except `.env` reads, which ask. Any
  `deny` wins, then any `ask`. A saved `always` never overrides a deny. (/permissions)
- There is no OS sandbox: the shell runs with "the host user's filesystem, process, and network authority".
  (/tools)
- It loads skills from `~/.claude/skills`, `.claude/skills`, `~/.agents/skills` and its own paths, and prefers
  `AGENTS.md`, falling back to `CLAUDE.md`. `OPENCODE_DISABLE_CLAUDE_CODE` turns the Claude-compatible loading
  off. (/skills, /rules)
- `webfetch` and `websearch` are built in, asking per URL and query by default. MCP servers connect once
  configured, and rules govern their tools by name. (/tools, /mcp-servers)
- It signs in with ChatGPT Plus and Pro. (/providers)

## 3. Orchestrators

- **Factory (Droid):**
  - Autonomy is a dial: Off, Low, Medium or High. A command with no rule runs when its fixed risk rating is at
    or below the level; block beats ask beats allow.
  - "Command rules are not operating-system isolation": the docs recommend a sandbox.
  - `droid exec` (headless) stops at the first action above its level, exits non-zero and keeps the partial
    edits.
  - User and project skills load.
  - Sources: https://docs.factory.com/cli/user-guides/auto-run, /cli/droid-exec/overview.
- **Conductor** runs Claude Code, Codex, Cursor and OpenCode in parallel worktrees, billed through the user's own
  provider account. Claude Code skills work in it. Its permission and sandbox model is not documented on the
  pages read. (https://www.conductor.build/docs)
- **Cursor cloud agents** run in isolated cloud VMs with an outbound domain allowlist and team-scoped secrets
  injected at start. (https://cursor.com/docs/cloud-agent)
- **emdash** runs each task in its own worktree, detects installed agent CLIs and adds hooks to their user
  config. It documents no sandbox. (https://github.com/generalaction/emdash)
- No product reviewed uses a model to judge calls, other than Claude's auto mode and Codex's Auto-review. No
  product found skips an action and continues; headless runs fail-stop.

## 4. The judges Claude Code and Codex ship

### Claude Code auto mode

(https://code.claude.com/docs/en/permission-modes, /auto-mode-config, /agent-sdk/typescript)

- **Availability:**
  - All plans; Team and Enterprise have it on by default.
  - The Anthropic API, Bedrock, Vertex, Foundry and the signed-in Claude apps gateway.
  - Models on the API: Opus 4.6 and later, Sonnet 4.6 and later, Haiku 5.5 and Fable. On Bedrock, Vertex and
    Foundry: Sonnet 5 and later, Opus 4.7 and later, Haiku 5.5 and Fable.
  - A plain `ANTHROPIC_BASE_URL` gateway is not listed.
  - `setModel()` to an unsupported model drops the session to `default` mode.
  - Admins can disable it with `permissions.disableAutoMode`.
- **Blocked by default:**
  - `curl | bash`
  - sending sensitive data to external endpoints
  - production deploys and migrations
  - force push
  - irreversibly destroying files that existed before the session
  - merging an unapproved PR, disabling CI

  The environment defaults treat hosts named `prod` or `production` as sensitive. Local file operations,
  lockfile installs, read-only HTTP and pushes to non-deploy branches are allowed.

- **Configuration:** `autoMode` takes `environment`, `allow`, `soft_deny`, `hard_deny` and `classifyAllShell`, in
  prose. A list without `"$defaults"` replaces the built-ins. It is read from user and managed settings and from
  inline SDK `settings`, never from a project's `.claude/settings*.json`. `permissions.deny` runs before the
  classifier and can't be overridden.
- **Headless:** "When repeated blocks reach a threshold, the action doesn't run and Claude keeps working. Claude
  Code doesn't stop the run." The SDK with no mode set starts in Manual mode, so `permissionMode: 'auto'` must be
  set explicitly.
- **Cost:** the classifier runs on Sonnet 5 by default (`CLAUDE_CODE_AUTO_MODE_MODEL` overrides it). Its calls
  count toward usage on Enterprise and API-billed accounts. Reads and in-directory edits skip it.

### Codex Auto-review

(https://learn.chatgpt.com/docs/sandboxing/auto-review, /agent-approvals-security, /config-file/config-reference)

- `approvals_reviewer = "auto_review"` hands approvals to a model reviewer. It applies only when approvals are
  interactive (`on-request` or `granular`); with `never` "there is nothing to review".
- Its policy checks data exfiltration, credential probing, persistent security weakening and destructive actions.
  It can be replaced with a Markdown file (`[auto_review].policy`). It fails closed.
- On a denial the model is told, must not work around it, and may continue with a materially safer alternative.
  The CLI interrupts a turn after 3 consecutive denials or 10 in the last 50. Reviewer calls count toward usage.
- A policy template is tagged at `rust-v0.167.0`, the version 10db pins. Whether app-server exposes the
  reviewer setting per thread is unverified.
- Other settings: `approval_policy` takes `on-request`, `never` or `granular` (`untrusted` is unsupported in
  the current reference). `sandbox_mode` takes `read-only`, `workspace-write` or `danger-full-access`. Skills
  are configured as `skills.config` entries by name or path. `tools.web_search` takes a boolean or an object
  with `allowed_domains`. `mcp_servers.<id>` takes `default_tools_approval_mode`.

### Loading the builder's setup through the Agent SDK

(https://code.claude.com/docs/en/agent-sdk/claude-code-features, /agent-sdk/plugins)

- `settingSources: ["user"]` loads user settings, user `CLAUDE.md`, rules, skills, commands and agents together;
  there is no skills-only switch. `"project"` loads the project's settings and hooks, `CLAUDE.md`, rules and
  skills.
- `plugins: [{ type: 'local', path }]` loads a plugin's skills, agents, hooks and MCP servers whatever
  `settingSources` says. The path must be absolute; a missing path is skipped silently (`plugin_errors` in the
  init message). `skills: 'all' | string[]` chooses the enabled skills.
- With `settingSources: []`, neither `CLAUDE.md` nor `AGENTS.md` loads; instructions must go in `systemPrompt`.
  Managed settings, `~/.claude.json` and auto memory are still read.

## Unverified

- Whether app-server lets a client set `approvals_reviewer` per thread, and what the model sees on a denial
  under `never`.
- Auto mode on a gateway account, and in a headless SDK session on a subscription plan.
- Whether Codex reads `SKILL.md` from a Claude skills folder named in `skills.config`, and how it loads
  `AGENTS.md` when the project is pinned `untrusted`.
- Amp, Conductor and emdash permission models.

### L3b: plugin hooks against 10db's guard, and plugin MCP servers: hooks fail, MCP holds

What ran: the pinned Claude Code `2.1.302` through the pinned Agent SDK `0.3.316` `query()`, model `haiku`, on the
Claude plan's default config dir, with `settingSources: []`, `strictMcpConfig: true`, `permissionMode: 'default'`,
an environment cleared to the login basics, and scratch projects in a temp folder. 10db's guard was an SDK
`PreToolUse` callback, as `buildQueryOptions` passes it, and its broker a `canUseTool` that denies. The scratch
plugin, loaded with `plugins: [{ type: 'local', path }]`, had a `PreToolUse` command hook on `Bash` that answers
`{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"allow"}}` for every call.

- **A4 (a), 10db's guard answers `deny` for `touch denied`: pass.** The file was not made; the call is in
  `permission_denials`.
- **A4 (b), the guard answers `ask`: pass.** `canUseTool` was called, and its deny held.
- **A4 (c), the guard allows `touch a`, the plugin answers `allow` with `updatedInput` rewriting it to `touch b`:
  fail.** `b` was made. The guard saw only `touch a`; it was never asked about `touch b`.
- **A4 (d), the guard passes the call on (`{}`, as it does for any call its broker decides) and the plugin
  answers `allow`: fail.** `touch passed` ran and `canUseTool` was never called: a plugin's allow skips 10db's
  broker, so a call that would wait on a card runs without one.
- **M1, a plugin's `.mcp.json` stdio server:** loaded by its own install path under `strictMcpConfig: true`, the
  server did not start (no marker; `mcp_servers: []` in the init message). Through 10db's wrapper it did not start
  either. `strictMcpConfig` alone would have kept it out on this version; 10db relies on the wrapper, which carries
  no `.mcp.json`, either way.
- **Hook working directory:** a `SessionStart` command hook `npx --no tendb-l3b-cwd-probe`, with the checkout as
  the session's `cwd` and the checkout holding `node_modules/.bin/tendb-l3b-cwd-probe`. Loaded by install path,
  the hook ran the checkout's bin (its marker was written): a plugin hook runs outside the sandbox with the
  checkout as its working directory. Through the wrapper (`cd '<wrapper>' && npx …`) the checkout's bin did not
  run; npx looked the name up in the registry (404) and the hook failed. `--no` did not stop npx asking the
  registry, only installing; a bare `npx <name>` with no TTY would install and run a published package of that
  name.

Meaning for the design: (a) and (b) hold, but (c) and (d) mean a plugin's `PreToolUse` hook can run a call 10db
never judged or carded. Fallback F2 applies: plugins come along without their hooks until 10db can order or
judge them. The wrapper's MCP and working-directory rows hold against the real CLI.
