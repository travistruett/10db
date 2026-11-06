# A project can run on a ChatGPT plan

**Status: designed, not built.** Ampsio is the first project.

## Why

Travis wants each project's work billed where it belongs: a ChatGPT plan, a Claude plan, Bedrock, an OpenRouter
key. Ampsio has its own ChatGPT plan, so Ampsio joins 10db on ChatGPT rather than on Claude first. The rule is
about billing, not about where a project's code may go.

| Project  | Account      | Fallback |
| -------- | ------------ | -------- |
| 10db     | Claude plan  | Bedrock  |
| Orgtools | Claude plan  | Bedrock  |
| Ampsio   | ChatGPT plan | None     |

## Goals

- A project on a `codex_signin` account runs its lanes (plan, review, implement, QA) through `codex app-server`.
- A `codex_signin` account is one more account. Moves, the fallback, handoffs, cards, pauses, the way back and model
  configuration all work as they do today, between any two accounts, Claude or ChatGPT.
- A Codex lane meets the same bar as a Claude lane where it matters: agents don't reach credentials, a repository
  can't change how its lane is run, 10db's guard judges each action, and cards still reach the builder.
- The board, the gate, the watcher and delivery work unchanged.

## Non-goals

- Brainstorm chat (Shape) on a ChatGPT account. It depends on Claude subagents and hooks that know which subagent
  acted. The project's board and tasks still work.
- `openai_api_key` accounts, and Sign in with ChatGPT (see Later).
- Running 10db without `claude` installed. 10db and Orgtools still need it.
- `complete()` on Codex. Its one caller, area naming, uses the default account, which stays on Claude.

## What would make this a failure

- Work billed to the wrong account with nobody told.
- A lane reading a credential, or a repository's files changing the sandbox or running code outside it.
- 10db holding a ChatGPT credential itself.

## The bar

Travis, 2026-11-05: use reasonable best practices at the bar Claude Code and Codex set, without going overboard.
So 10db relies on Codex's own sandbox and hooks, closes the specific holes the spike found, and adds no layers of
its own. Left out on purpose: a sandbox self-test at runtime, a CI job on the real Codex binary, a replacement for
Claude's auto-mode classifier, and closing `write_stdin`.

## OpenAI's terms

Decided by Travis, 2026-11-05, and no longer a blocker: start with a login on this machine through `codex app-server`,
then move to Sign in with ChatGPT once this is stable. OpenAI's app-server page says app-server authentication was
never permitted for commercial or hosted services, and that a local or open-source app built on it can keep using it.
10db is local, Apache-2.0, public and not hosted, so it is on the allowed side. That page was read through a
summarising tool. Travis accepted OpenAI's Terms of Use on 2026-11-06 without a further reading.
`docs/architecture/open-questions.md` and its
older notes predate this decision; the last step under Order closes the row.

## What the spike showed

Run on Codex 0.154.0 against a local fake model: real hooks, sandbox, MCP and resume, no login and no plan spend.
Evidence: `scratch/spike-2026-11-05-codex-app-server/fake-model/FINDINGS.md`. A task moves it into
`docs/architecture/research/`.

Nothing here has run on a real model through the real account, so the first task proves that.

## Accepted as they are

Both already send project content past the project's account. Neither is plan spend, so both stay.

- Area naming sends file paths to the default account's model when a project is added.
- The judge sends task text and a capped diff to OpenRouter on the global key.

## Design

### Account and login

- `codex_signin` joins `SUPPORTED_ACCOUNT_KINDS`, with settings holding `modelChoice` only. Not metered: `costUsd`
  stays null and no monthly cap applies. That holds for Ampsio's plan, a `pro` plan with no purchased credits in the
  first step's real report.
- Sign-in asks which workspace to use, and that choice decides which plan pays. Codex keeps it in the home, so every
  session there bills it. One email can hold several workspaces, so the email alone can't tell them apart.
- Its home is `<dataDir>/accounts/<id>/codex`, mode 700, like a Claude account's directory.
- Settings shows the sign-in command, `CODEX_HOME='<dir>' codex login`, as it shows `claude /login` today. Codex
  writes its own login there. 10db never reads, copies or stores it.
- `~/.codex` isn't used for lanes: it would load Travis's MCP servers, and `thread/start` writes trust entries into
  the `config.toml` of the home it runs on.
- The probe is `account/read` and `account/rateLimits/read`. It must report `type: chatgpt`. The identity is the email
  and the workspace together, `<email> · <accountId>`, where `accountId` is the workspace ID from the usage read. The
  existing card confirms it and the existing mismatch card catches a change, so a sign-in to another workspace on the
  same email is refused rather than billed. The plan's name is never compared. `codex login status` answers the
  signed-out question, as `claude auth status` does.
- At a session start the usage read is asked up to three times, 2 s apart on the injected clock, after no answer or a
  server error. An account still unread fails the start with `error`, which the runner recovers from, and pauses the
  account only when `codex login status` says the home is signed out. A usage read that names no workspace matches
  nothing: Confirm can't record it, so the account shows a sign-in card, and a start refuses it.
- `OPENAI_API_KEY`, `CODEX_API_KEY`, `OPENAI_BASE_URL`, `CODEX_ACCESS_TOKEN` and `CODEX_HOME` are stripped from a
  Codex launch only, in `launch.ts`. The shared `projectEnv()` keeps them, so no existing project's gate changes.
- `forced_login_method = "chatgpt"` in the home keeps an API key from billing instead.

### The Codex home

10db writes `config.toml` in the account's home when the account is prepared, and rewrites it when the template
changes. Codex may add `projects` entries; 10db keeps them. Writes are atomic and go through one queue per home.

| Key                                                 | Why                                                      |
| --------------------------------------------------- | -------------------------------------------------------- |
| `forced_login_method = "chatgpt"`                   | Billing stays on the plan                                |
| `default_permissions = "lane"`, closed by default   | A failed per-lane override leaves nothing open           |
| `allow_login_shell = false`                         | The user's shell profile doesn't run in a lane           |
| `features.network_proxy = true`                     | Without it the host allowlist is silently not enforced   |
| `web_search = "disabled"`                           | It runs at OpenAI, where the guard can't see it          |
| `agents.enabled = false`, `features.goals = false`  | 10db owns steps, review and retries                      |
| memories, apps and plugins off                      | Nothing a lane needs; less to reason about               |
| Image generation, browser use and computer use off  | On by default in 0.154; each runs where the guard can't see it |
| `features.skill_mcp_dependency_install = false`     | On by default in 0.154; a skill would install an MCP server |
| `skills.include_instructions = false`               | 10db puts its skills in the briefing                     |
| `hooks.PreToolUse` and `hooks.state`                | The guard (below); a hook runs only with its trust hash  |
| `shell_environment_policy.inherit = "none"`         | Commands get only what 10db sets                         |

The hook's `trusted_hash` comes from `hooks/list`'s `currentHash` when the home is prepared. A hook passed with
`-c` is never trusted, so the hook must live in this file. The live test pins the tools the model is offered (code
mode's `exec`, `wait` and `request_user_input`, and the tools `exec` names for its scripts), so a tool a later Codex
turns on shows there first.

### The adapter

`createCodexAdapter` implements `SessionAdapter` in `apps/daemon/src/sessions/codex-*.ts`, one job per file. It runs
one `codex app-server --stdio --strict-config` per session, with `CODEX_HOME` set and `HOME` set to an empty folder
in the account's directory, which keeps personal skills in `~/.agents` out. Commands still get the lane's own
`HOME`. zod validates every message from the child.

A session starts like this. Any failure ends it with `sandbox_refused` or `account_refused`, and no prompt is sent.

1. Pin `[projects."<real checkout path>"] trust_level = "untrusted"` in the home's `config.toml`.
2. Start the process, `initialize`, and warn if the version isn't the verified one.
3. `account/read` and `account/rateLimits/read`: the expected account and workspace.
4. `config/read` with `includeLayers`: the project layer is absent or has a `disabledReason`.
5. `hooks/list`: the guard hook is `trusted` and enabled.
6. `thread/start` or `thread/resume` with `cwd`, `model`, `approvalPolicy: "never"` and per-lane `config`.
7. The response names the `lane` profile and the requested model.
8. Emit `started` with the thread ID and the process ID, then `turn/start` with the prompt and effort.

Step 1 must come before step 6, and a session flag can't replace it. `thread/start` otherwise writes `trusted` for the
checkout, and a repository's `.codex/config.toml` then replaces the sandbox and starts its own MCP server outside it,
during `thread/start`. A `-c` flag doesn't beat that entry; an `untrusted` entry in the file held across a first
session, a second session and a resume, and on a linked worktree. Step 4 sees a mistake before anything has started.
So a Codex lane ignores a repository's `.codex/`, Ampsio's included.

Per-lane values travel in `thread/start`'s `config`, over stdin, never on a command line: `permissions.lane`,
`shell_environment_policy.set` and `mcp_servers`. The 10db server's token is `bearer_token_env_var`, set on the child
and out of commands' reach (`inherit = "none"`).

Mapping to `SessionEvent`:

| Codex                                | 10db                                                          |
| ------------------------------------ | ------------------------------------------------------------- |
| `item/completed`, anything else | `activity`, text or tool |
| `thread/tokenUsage/updated`          | `context`, from `last` and `modelContextWindow`               |
| `turn/completed`, completed          | `turn_complete` with `costUsd: 0`                             |
| `turn/completed`, failed             | `turn_complete` with `result: 'error'`, unless named below    |
| `item/completed`, `contextCompaction` | `compacted`, trigger `auto` |
| `account/rateLimits/updated`         | `rate_limit`, one per window                                  |
| `usageLimitExceeded`                 | `rate_limit` with `rejected`, then `ended: rate_limited`      |
| `unauthorized`                       | `ended: account_refused`, signed out                          |
| Process exits unasked                | `ended: error`                                                |

- `send` is `turn/steer` during a turn and `turn/start` between turns.
- `stop` is `turn/interrupt`, then ending the process, then one `ended`.
- `approvalPolicy: "never"` means no approval requests are expected. Any server request is refused. Unknown
  notifications are ignored.
- `background_tasks` isn't emitted; a turn that ends with a background command isn't held.
- `startShape` is refused and `complete` rejects with `CompletionError`, which area naming already handles.

### Choosing the adapter

- `Provider` gains `Codex`, and a `providerOf(kind)` function in contracts is the one mapping.
- A small routing adapter implements `SessionAdapter` and delegates on `spec.account.kind`, so the runner and the
  account services keep calling one adapter, and each session runs on whatever its project's account is at that moment.
- A session row records the provider of the account it ran on (`runner.ts:1575`, `shape/service.ts:821`).
- `projects.provider` and routing don't change.
- Moves don't change. `nextActionOnAnotherAccount` already starts a lane fresh from its handoff when its conversation
  ran on another account, so a move between a Claude account and a ChatGPT account works the way any move does.

### The guard

10db's guard runs from a `PreToolUse` hook. The spike saw it fire for each shell, patch and MCP call, inside code mode
and inside a subagent, with `tool_name: "Bash"` and `tool_input.command`, close to what `judgePreToolUse` reads.

Codex lanes use `approvalPolicy: "never"`, not approvals, because the hook reaches every action and approvals would
card ordinary commands.

Codex hooks fail open. A crash, a timeout, garbage or an `ask` all let the call run. Only `deny` and exit 2 block.
So:

- The hook is a short script in the account's home: `/bin/sh` and `/usr/bin/curl`, sending the hook's input to a Unix
  socket the adapter opens for that session in `~/.10db/run/`, because a socket path under the data directory is past
  macOS's 104-byte limit. A lane couldn't reach it in the spike, so the socket needs no token.
- The answer is empty to allow, or `deny` JSON. If `curl` fails for any reason, the script exits 2.
- `ask` is the socket holding the request open while `spec.canUseTool` raises its card. A hook held for 8 s then
  answered both ways in the spike; a real card can take much longer, which the plan tests.
- The hook's `timeout` is a constant above the longest wait (`humanWaitMinutes` is at most 240), and `curl`'s
  `--max-time` comes from the session's tool timeout, so `curl` gives up first and refuses. A stopped session closes
  its socket, which refuses the call. Codex's binary can clamp a hook's timeout, so the start checks read the one it
  reports (`timeoutSec` in `hooks/list`) and refuse the session when it is missing or shorter.

The adapter translates calls at this boundary, so the guard, the broker and the watcher see the shapes they know:

| Hook `tool_name` | Goes to the guard as                                                                        |
| ---------------- | ------------------------------------------------------------------------------------------- |
| `Bash`           | `Bash`, unchanged                                                                           |
| `apply_patch`    | One `Edit` per path named in the patch (add, update, delete, move); any refusal refuses all |
| `mcp__*`         | Unchanged                                                                                   |
| Anything else    | Refused                                                                                     |

The verdicts: `deny` refuses, `ask` goes to `canUseTool`, `allow` runs. That is the auto-mode flow without the
classifier, so what the guard allows runs in the sandbox without another check. The app-wide auto-mode setting
doesn't apply to these lanes.

### The sandbox

`laneSandbox.forSession` runs as it does today. One small translator turns its `LaneSandboxSettings` into
`permissions.lane`:

| 10db                                  | Codex                                                 |
| ------------------------------------- | ----------------------------------------------------- |
| `denyRead: ['/']`                     | `":minimal" = "read"`, nothing else granted           |
| `allowRead`                           | `"<path>" = "read"`                                   |
| Checkout, `allowWrite`                | `"<path>" = "write"`                                  |
| Other entries of `denyRead`           | `"<path>" = "deny"`                                   |
| `denyWrite`, under a writable path    | `"<path>" = "read"`                                   |
| `denyWrite`, anywhere else            | No entry, so it stays closed                          |
| `allowedDomains`                      | `network.domains`, `mode = "full"`                    |
| `allowLocalBinding`, `allowUnixSockets` | The matching `network` keys                         |
| Session's command env                 | `shell_environment_policy.set`                        |

- `":root" = "deny"` plus a written list crashed every command, so `:minimal` is the base.
- `denyWrite` holds every other project's checkout. A `read` entry there would open those checkouts to this lane, so
  it gets one only where it narrows a write. A Claude lane can't read them either.
- `mode = "limited"` limits allowed hosts to read-only methods and kills a command that POSTs. `full` with the same
  allowlist let a POST through to a listed host and still blocked an unlisted one. Claude lanes have no method limit.
- `.git` and `.codex` in the checkout are read-only under Codex's own protection, with no rule.
- `LaneSandboxSpec` gains `commandEnv`, so `TMPDIR` and the rest reach commands. Without `TMPDIR`, `xcrun` fails.
- `~/.codex` and `~/.agents` join `homeProtectedReads`. The account's home is already covered by the data directory.
  A login shell whose `CODEX_HOME` moves a personal ChatGPT login elsewhere gets that directory protected too, as its
  `CLAUDE_CONFIG_DIR` is (`Launcher.loginCodexHome`).
- Listing patterns (`allowRead`'s `dir[x]`, `dir/*`) and `allowMachLookup` have no direct match. The plan tries a
  real toolchain and grants a plain read where one is needed. File watchers may not work in a lane; that's accepted.
- `runner.ts:1511` takes the config directory from the launch, not from `CLAUDE_CONFIG_DIR`.
- `trackProcesses` and `endProcesses` watch the app-server's process. A command outlived both `turn/interrupt` and the
  app-server in the spike, so this watch is the only cleanup.

#### Temp files

Codex's base Seatbelt policy lets every command read and write all of `/private/tmp` (and `/tmp`, `/var/tmp`), and no
profile entry closes it: with denies on both a folder there and `/private/tmp`, a command still read and wrote that
folder. 10db kept all its temp files there, so Travis decided, 2026-11-05:

| What                                                                 | Where it goes            | Why                                                    |
| -------------------------------------------------------------------- | ------------------------ | ------------------------------------------------------ |
| Other software's temp files, including Claude Code's own              | Stays; Codex's own bar    | Nothing short of a second sandbox closes it             |
| 10db's control files: process ledgers, srt settings files, env files  | `~/.10db/run/`            | A forged or swapped one escapes a sandbox or reads a token |
| A ChatGPT lane's temp dir                                             | `~/.10db/lanes/`          | Keeps ChatGPT lanes apart, as Claude lanes are          |
| Claude lanes', gates' and MCP servers' temp dirs                      | `/Users/Shared/10db-<uid>/` | Keeps ChatGPT lanes out of them; fits the 44-byte limit |
| pnpm's store lock directory, which a package-install gate opens        | Stays; pnpm names it       | Walked only once renamed under the lane temp root, never in place |

- Claude Code takes `CLAUDE_CODE_TMPDIR` only when its own dir there, the path plus `/claude-<uid>`, fits 44 bytes
  (`MAX_SANDBOX_TMP_BYTES`), and otherwise falls back to the shared `/tmp/claude-<uid>` without a word. A temp dir in
  the root is named by six random characters alone: `/Users/Shared/10db-501/xxxxxx/claude-501` is 40 bytes for this
  Mac's user. The uid is in it twice, so it fits for a uid of up to five digits, and a longer path is refused
  (`SandboxTempDirError`), never handed to Claude Code. The uid keeps two macOS users apart, since `/Users/Shared` is
  writable by all of them. The root is made 0700 and refused when it is a link or another user's.
- At start, before any lane session or gate, the daemon unlinks its sealed files and ledgers from `/private/tmp` and
  `/private/var/tmp`, so one a crashed daemon left there isn't left for a ChatGPT lane to read. Once it listens, it
  removes its lane temp dirs there in the background, which `stop()` ends between entries. A mark there counts only
  while its pid's command line names `daemon.mjs` or `src/main.ts`. Both dirs count as lane-writable wherever the temp
  root does.
- Codex's base policy closes both `~/.10db` and `/Users/Shared`; a command there got `Operation not permitted`.
- Each of the three roots holds every lane's package caches, so at start it gets a `.metadata_never_index` file, which
  keeps Spotlight out, and `tmutil addexclusion`, which keeps Time Machine out; a failure of the second is logged, not
  fatal. No sweep or claim matches the marker's name.
- A lane is granted only its own temp dir, as before. The control files are read only through the grants that already
  name them: a Claude lane's env file, an MCP server's env file.

### Models

A Codex account uses the Model map every account already has. Routing, role defaults, persona pins and the account's
offered aliases don't change.

- `launcher.session` turns a step's alias into the account's model ID, as it does on Bedrock or a gateway. The builder
  fills in the Model map in Settings with IDs that `model/list` reports.
- That is also what makes a move work: a step on `sonnet` runs Sonnet on a Claude account and whatever the map names on
  a ChatGPT account, with nothing rewritten.
- `Effort` passes through unchanged: the catalog supports `low` to `max`.
- `modelMatches` already requires a mapped ID to come back unchanged.

### Limits

- Each window in `account/rateLimits/updated` becomes a `rate_limit`: `utilization` is `usedPercent / 100`, `resetsAt`
  is converted from seconds, `limitType` comes from `windowDurationMins` (`seven_day`, `five_hour`, else the minutes).
- `usageLimitExceeded` becomes a `rate_limit` with `rejected`, with `resetsAt` from the last window seen or
  `account/rateLimits/read`.
- Everything after that is the existing code, unchanged. At `usageHandoffAt` a project with a fallback hands off and
  switches on its own; one with no fallback gets the card offering the accounts it could move to; at the hard limit it
  moves at once or pauses; and the way back is offered when the limit resets. `handle.send` carries the handoff nudge
  as `turn/steer`.
- The window values came from the fake model, in Codex's real parsing. The real plan's windows are checked in the
  first task.

### The briefing

`briefing/prompts.ts` follows the kind of the account each session runs on, since these lanes don't have what Claude
lanes have:

- Change files with `apply_patch`.
- Ask the builder with `mcp__10db__ask_human`, for example about a host that was refused. A refused host fails the
  whole command, so its output is lost. The builder adds the host in Settings, which applies from the lane's next
  session, because `permissions.lane` is fixed when the thread starts. No per-host card, as with a Claude lane in
  auto mode.
- The lines about auto mode, `AskUserQuestion` and `WebFetch` are left out.
- Skill bodies go in the briefing, not by name: each is under 2 KiB and a lane can't read the account's home.
- A line after the persona says "the Edit or Write tool" means `apply_patch`, since seeded personas stay as they are.

`AGENTS.md` isn't loaded in an untrusted project. The briefing already tells a lane to read it.

### Brainstorm chat

`launch` in `daemon/start.ts` throws an `InvalidError` while a project's account is a ChatGPT account, saying brainstorm
chat isn't available there. The builder MCP's `start_shape` returns the same error, and the desktop shows it.

### Version

`codex` is the machine's install, as `claude` is (decision 5). A constant names the verified version, and a different
one warns in the system check, as Claude Code's does. The start checks fail closed on what matters, so updating
Codex for other work doesn't stop Ampsio.

### Desktop

- `codex_signin` in the kind label, the add-account modal and the account fields, with the sign-in command and the
  identity check.
- Usage shows tokens and limit percent. Dollars already stay hidden for a null `costUsd`.
- Brainstorm copy while a project is on a ChatGPT account.
- The account fields, Model map included, as they are for other kinds.

## Known gaps, accepted

- `write_stdin` is not seen by the hook: text can reach a running process unguarded. The kernel sandbox still bounds
  it, and the guard is a filter, not the boundary (`decisions/2026-10-29-sandbox-is-the-boundary.md`).
- The guard judges a command's relative paths from the thread's cwd, the hook's `cwd`. It never sees the `workdir`
  an `exec_command` call names, so a command run in another directory has its relative paths judged from the wrong
  one. The kernel sandbox still bounds what it touches.
- The process ledgers a daemon kept in `/private/tmp`, as 10db did before its files moved to `~/.10db/run`, are
  removed unread by the start sweep, since a ChatGPT lane can write there, so the orphans they name aren't stopped.
- No classifier. What the guard allows runs inside the sandbox.
- A ChatGPT lane can read and write `/private/tmp`, as any Codex command can. 10db keeps nothing there, but other
  software's temp files, Claude Code's own included, stay readable to it (see Temp files).
- A lane spends a read on `AGENTS.md`, and Ampsio's `.codex/` doesn't apply to its lanes.
- A malformed start can still leave a lane unable to run; it refuses rather than runs open.

## Testing

- **Adapter:** a scripted fake `app-server` child, the boundary we don't own, with table-driven tests of the mapping
  and of each start check refusing.
- **Translator and `apply_patch` parsing:** table-driven.
- **Guard socket:** real socket and the real script, with each failure proving exit 2.
- **Moves:** the existing move and fallback tests gain a Claude account to ChatGPT account case, each way.
- **One live file, `TENDB_LIVE_CODEX=1`,** on the real binary and a fake Responses server, in a checkout outside
  `/tmp` (a `/tmp` path gave false results in the spike). It covers a planted `.codex/`, a refusal, credentials, `.git`,
  another project's checkout, a blocked host, and a POST to a listed host. Never in CI; run when bumping the verified
  version.
- **By hand:** one small task on Ampsio.

Fake adapter tests are unchanged: `FakeAdapter` stays Claude-shaped.

## Order

1. **Real-account proof.** Travis runs `codex login` in a test home. One real turn proves the login, the hook on a real
   model, and the real limit windows and `credits`. Stop and rethink if this fails.
2. Contracts: provider, account kind, `providerOf`.
3. Account, home and Settings, through to a confirmed identity.
4. Adapter, routing and event mapping.
5. Guard and sandbox, with the live file, and 10db's temp files moved out of `/private/tmp`.
6. Limits and the briefing.
7. First Ampsio lane, then the docs: a decision for terms and login (amending decision 4, closing the row in
   `docs/architecture/open-questions.md`), one for how Codex lanes meet the guard and sandbox bar, and updates to
   `04-accounts.md`, `03-trust-boundaries.md`, `docs/open-items.md` and the spike record.

## Later

Sign in with ChatGPT replaces `codex login` once this is stable, as Travis decided. The login touches only the home's
setup and the account probe, so the swap stays small. A paid 10db tier would reopen the terms question.

## Left to the builder

File layout within `sessions/`, how Settings shows the IDs from `model/list`, the exact `limitType` labels, how the
home's template is versioned, and how `apply_patch` paths resolve against the hook's `cwd`.
