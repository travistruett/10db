# 03 Trust boundaries

- **Status:** Draft
- **Scope:** What each process in a 10db run may read, write, run and reach: lanes, the daemon, the desktop
  app and GitHub, all on one macOS user. Which layer enforces each limit, today and in the design. What the
  daemon reads, runs or sends on a lane's behalf. What is known and accepted.
- **Summary:** 10db treats a lane as possibly steered by what it reads. Four layers are boundaries:
  - the kernel sandbox, for every process whose code a lane can choose;
  - Claude Code's permission rules, for the file tools;
  - the daemon's handling of repo content;
  - the daemon's tokens.

  Cards and the guard are policy. They are the builder's decisions and a cooperative agent's guide rails, never
  the only thing between a lane and an asset.

  Every lane runs under the lane sandbox (**built**, always on, with no switch): the kernel sandbox holds for a
  lane's Bash and its children. Claude Code's permission rules, the broker and the guard's resolved-path check
  hold for the file tools. Every lane runs in Claude Code's `default` permission mode; there is no auto mode. Every
  gate runs under the same kernel sandbox (**built**): srt, with the lanes' read policy, its own temp dir, no
  credentials and only the project's network (§4.7). Every approved repo stdio MCP server runs under it too
  (**built**): srt, one sandbox per server and session, with the lanes' reads, writes only to its own temp dir,
  only the hosts its approval names, no loopback and no credentials (§4.6). Still **designed** only: the claude process's own environment, the safe
  reader, the secret scan and the CI card. The daemon's own git runs nothing from the
  checkout: no hook, filter, attribute-selected driver, fsmonitor or submodule git, because every call reads no
  attributes and turns hooks and fsmonitor off. It commits only on the workstream's pinned branch, in the
  checkout pinned for the project, and pushes only to the URL pinned with it (D13, **built**).

  Every row below says whether its enforcement is **built** or only **designed**. The research behind it is
  `research/spike-13-sandbox.md`.

## 1. Who 10db defends against

In scope:

- **A mistaken agent.** It is cooperative but wrong: it edits the wrong file, runs a destructive command, or
  reads a credential while looking for configuration.
- **A steered agent.** A lane takes instructions from what it reads. That can be a repo file, dependency
  source, an issue, a web page, tool or test output, or another lane's handoff. It then uses every tool and
  channel it has, as an attacker would. **This is the design target: every boundary in §3 must hold against
  it.**
- **Hostile project code.** An install script, a test, a Makefile target, a git hook or a CI workflow. A lane,
  a contributor or a package author wrote it. It runs wherever 10db or GitHub runs the project's commands.

Out of scope:

- Malware, or another person, already running as the builder's macOS user. Everything 10db protects is
  readable by that user.
- Bugs in macOS's sandbox, Claude Code, the Agent SDK or the daemon. The daemon's code is trusted and reviewed;
  the job here is that nothing a lane controls can steer it.
- The builder's takeover terminal, which runs as the builder. What it loads from the lane's checkout is in scope
  (§4.2).
- A separate macOS user per account (accounts spec §1).
- Code after it merges. Merged code runs on the builder's machine and in CI outside 10db. Review before merge
  is that boundary: the review step, CI and the builder's merge.

## 2. What is protected

| Asset                           | Where it lives                                                                                                                                                                                                                                             | Lost when                                                                                                                                 |
| ------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| Account credentials             | Claude Code's sign-in for each config directory (login Keychain); keyed secrets as Keychain items `10db` / `account:<acc_id>`; `~/.claude`, `~/.claude.json`, `<data>/accounts/<acc_id>/claude`; a keyed account's secret in its own session's environment | a lane reads a credential it wasn't started with, or anything sends one off the machine                                                   |
| The builder's other secrets     | `~/.ssh`, `~/.aws`, `gh`'s token (Keychain), `~/.npmrc`, `~/.netrc`, `~/.docker`, `~/.config`, tokens the login shell exports (`GH_TOKEN`), the SSH agent socket                                                                                           | a lane or project code reads one                                                                                                          |
| Control of 10db                 | `<data>/ui-token`, `<data>/10db.sqlite`, each session's MCP token, stored permission rules, each project's gate command                                                                                                                                    | a lane gets the UI token or writes the database. It can then answer its own cards, change the gate command, or approve its own MCP server |
| Other projects                  | other checkouts on the machine and their `.env` files                                                                                                                                                                                                      | a lane reads another project. The accounts spec asks for practical isolation between projects                                             |
| GitHub                          | the daemon's `gh` login and git credentials; CI secrets in GitHub environments                                                                                                                                                                             | they are used for anything but the batch's push and pull request                                                                          |
| The machine outside the project | shell startup files, LaunchAgents, `~/.gitconfig`, other repos' hooks                                                                                                                                                                                      | a lane writes code that runs later, outside 10db                                                                                          |

## 3. Layers

| Layer                                                                                                                                                                                                                                                                             | Holds against a steered agent | Covers                                                                                                                                                                                                              | Built                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| **Kernel sandbox**: Seatbelt, through the Agent SDK's `sandbox` option or `@anthropic-ai/sandbox-runtime`                                                                                                                                                                         | yes                           | every process whose code a lane can choose: Bash and its children; the gate, the hooks of the daemon's git commands, repo MCP servers                                                                               | built, for a lane's Bash and its children, the gate and repo stdio MCP servers; the daemon's git runs no hook (D13) |
| **Permission rules and the resolved-path check**: Claude Code's `Read(...)` deny rules and its `ask` rules before an Edit or Write of a path it protects, the broker's decision on reads outside the checkout, and the guard's check of each file-tool path after resolving links | yes, for the file tools       | Read, Grep, Glob, Edit, Write and NotebookEdit, which run inside the claude process where the kernel sandbox doesn't reach. A link the lane made in the checkout must not carry a read past the rules (§8 check 12) | built                                                                                                               |
| **Daemon input handling**                                                                                                                                                                                                                                                         | yes                           | every repo file the daemon reads, every git command it runs in the checkout, every file it writes in its data directory                                                                                             | partly: `.mcp.json` and `.claude/settings.json` (§5)                                                                |
| **Daemon tokens**                                                                                                                                                                                                                                                                 | yes                           | the HTTP API (the UI token) and the MCP endpoint (a token per session)                                                                                                                                              | the tokens are; keeping the UI token out of lanes' reach is not                                                     |
| **Cards and allow rules** (the broker)                                                                                                                                                                                                                                            | no, it is policy              | what runs without asking the builder: built-in allow rules, the project's allowed commands, stored rules; network hosts and file reads outside the checkout under the sandbox                                       | yes                                                                                                                 |
| **The rest of the guard** (`PreToolUse`)                                                                                                                                                                                                                                          | no, it is policy              | claims, commits only through `commit`, the delivery and `gh` rules, hazard claims, clear refusal reasons                                                                                                            | yes                                                                                                                 |

A policy layer may refuse more than the boundaries, never less. Whatever a card or an allow rule lets through
still runs inside the boundaries. The guard's shell-text parsing reduces prompts and explains refusals. A way
past it is a bug in a convenience, not a breach. The parked findings in §9 are judged by that rule. Claims,
commits only through `commit` and hazard cards are workflow policy too. A lane can run git from an interpreter.
What a batch carries to GitHub rests on review and the daemon's checks at ship (R12), not on how the commits
were made.

## 4. Processes

### 4.1 The daemon

- A Node process, run as the builder with no sandbox. The Tauri shell spawns it in the packaged app; from
  source it runs in a terminal. It is the only database writer.
- Its code is trusted. It holds the UI token, the captured login environment and `gh`'s login. It holds each
  keyed account's secret briefly, read through `/usr/bin/security` when a session starts.
- It spawns lanes' `claude` processes, the gate, `git`, `gh`, `security`, `caffeinate` and `ps`.
- It listens on `127.0.0.1` only. Every route needs the UI token except `/health` and `/mcp`, and `/mcp` needs
  a session's token. CORS limits browsers only, so a local process with the token is a full client.
- Its risk is being a confused deputy for a lane (§5).

### 4.2 The desktop app

- A Tauri shell and its webview:
  - its CSP allows only loopback;
  - it registers no filesystem, shell or HTTP plugin;
  - its opener is limited to `https://github.com/*`;
  - its dialog plugin is registered with `dialog:allow-open` only, and the call site opens the folder panel; the picked path goes to the
    daemon, which inspects it ([the decision](decisions/2026-10-28-folder-inspection.md)).
- It reads `ui-token` and `daemon.json` from the data directory and hands them to the webview.
- It shows text lanes wrote: cards, handoffs, evidence and proposals. The factory spec (§7) renders untrusted
  text as data, never as instructions.
- The takeover PTY runs the builder's own `claude`, unsandboxed, in the lane's checkout. If it loaded the repo's
  settings, a hook a lane wrote would run as the builder. The takeover plan isn't built; R13 binds it.

### 4.3 A lane's claude process

- The builder's installed `claude`, driven through the Agent SDK. Its working directory is the project's shared
  checkout (decision 13), and it runs as the builder.
- **No sandbox, today or in the design.** It must read its own config directory and, on a subscription, its
  sign-in in the Keychain. Whole-process wrapping is weighed in the amendment (§8 check 2).
- **Environment:**
  - today, the login environment minus the billing switches, plus the account's secret on keyed kinds. So
    `GH_TOKEN`, AWS keys and `SSH_AUTH_SOCK` reach it and every child;
  - in the design, its own account's variables only.
- **Settings:** `settingSources: ['project']`. The repo's `.claude/settings.json` loads: its hooks, permission
  rules and `env` (billing-checked), plus project skills, agents and commands. 10db's plugin holds skills and
  personas only. `strictMcpConfig` keeps user and global MCP servers out. Under the lane sandbox it is
  `settingSources: []` (below).
- **Hooks:** 10db's guard and billing re-checks are SDK callbacks inside the daemon, not processes (§4.5 covers
  repo hooks).
- **MCP:** 10db's server over HTTP with a token per session, and approved repo servers (§4.6).

**Built, for every lane** (`apps/daemon/src/sandbox/`, `sessions/claude-adapter.ts`; only fake sessions run
without it):

- **No repo settings.** `settingSources: []`. A repo's `.claude/settings.json` never loads, so a hook, allow rule,
  `env` or `sandbox` block a lane wrote can't reach the next session. This closes §8 check 3 for sandboxed
  sessions, and R7 holds for them. The live test's widening row (a repo settings file that allows `Read` and
  `/Users`) holds for that reason.
- **Default permission mode.** Every lane runs in `default` mode. Auto mode's classifier would approve calls
  that never reach the broker, so hazards and new hosts would skip their cards.
- **Environment.** The sandbox sets, for lane commands, per-lane package caches (`CARGO_HOME` among them), the
  lane's own mise config (`MISE_CONFIG_DIR`, `MISE_GLOBAL_CONFIG_FILE`, `MISE_SYSTEM_DIR`,
  `MISE_SYSTEM_CONFIG_FILE`), `MISE_LOG_LEVEL=error`, `xcrun_db` (Apple's xcrun cache file), an empty
  `XDG_CONFIG_HOME` in its temp dir and `TENDB_SANDBOX=1`, and for Claude Code `CLAUDE_CODE_TMPDIR` (the
  lane's own temp directory), `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` and `CLAUDE_ENV_FILE`. **The session env,
  which the unsandboxed Claude Code and the git it runs use, holds no variable whose value is the temp dir or a
  path in it, except `CLAUDE_CODE_TMPDIR`** (`withoutTempDirPaths`). A lane can write its temp dir, so a tool
  outside the sandbox that followed such a variable would read or run what the lane wrote (reproduced: a mise
  `config.toml` with `[env] _.source = "<script>"` run through `MISE_GLOBAL_CONFIG_FILE`; xcrun execs what
  `xcrun_db`'s file names; git reads `$XDG_CONFIG_HOME/git/{ignore,attributes}` and Claude Code
  `$XDG_CONFIG_HOME/anthropic/{active_config,configs/*.json}`; cargo reads `rustc-wrapper` from
  `$CARGO_HOME/config.toml`). The sandboxed shell has every one of them, from `CLAUDE_ENV_FILE`. Bash children
  keep only an allowlist of names
  (`PATH`, `HOME`, locale, toolchain and package-cache variables) and nothing that looks like a secret: the
  profile lists every other name in the session's env under `sandbox.credentials.envVars` with `mode: deny`,
  an account's own variables included.
  The claude process itself keeps the login environment until the accounts launcher builds its own (R1).
- **`GIT_CONFIG_GLOBAL=/dev/null`** is the sandbox env's exception to the daemon's rule that git config variables
  are kept. Allow-reading `~/.gitconfig` was rejected (lane sandbox spec D2): it would hand lanes the builder's
  identity and `insteadOf` tokens.
- **`CLAUDE_ENV_FILE`.** Claude Code strips variables that point a tool at its config or credentials from a
  sandboxed command's env, `GIT_CONFIG_GLOBAL` and `CARGO_HOME` among them. Without them git dies reading the denied
  `~/.gitconfig` and cargo falls back to the denied `~/.cargo`. So every variable the sandbox sets for lane commands
  (the package caches, the mise variables, `xcrun_db`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, the empty
  `XDG_CONFIG_HOME` and `TENDB_SANDBOX=1`) is written to a per-session file that the shell sources before each command: one `export` per variable, its value
  in POSIX single quotes, and a name that isn't a shell identifier or a value with a control character refuses
  the session. The file is created with `wx`, mode 0400, at `<tmp root>/10db-env-<hex>.sh`, outside every
  writable path, with its exact path in `allowRead`. Claude Code's own `CLAUDE_*` settings stay out of it. The
  live test checks that each variable reaches a sandboxed command with the daemon's value and that npm, pnpm and
  cargo use the lane's caches.

Its file tools run inside this process:

| Tool                                 | Today                                                                                                                                                                                                                                                                                                                                                 | Design                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Read, Grep, Glob                     | Any path. Bare `Read`, `Grep` and `Glob` allow rules let them run without a card. Whether that holds outside the working directory is §8 check 1. On `feat/accounts` the guard refuses the data directory and `~/.claude*` by text.                                                                                                                   | `Read(...)` deny rules matching the sandbox's read policy. Spike 13 check 6 showed that a Read rule stops the tool and also reaches the Bash sandbox. The broker decides reads outside the checkout on the real path. Claude Code's own deny rules apply first; the guard resolves links for the calls that reach it, so a link in the checkout can't carry a read past the rules (§8 check 12). |
| Edit, Write, MultiEdit, NotebookEdit | Inside the checkout, within the lane's claims; the guard resolves links. `.git/config`, `.git/hooks/*`, `lefthook.yml` and `Makefile` are writable when an area covers them. The stray watcher flags `.git/hooks`, `.git/config`, `.claude` and `.mcp.json` only after the write, but not Claude Code's write staging directory `.claude/.cc-writes`. | `Edit(...)` deny rules for `.git/` internals. Claims stay policy.                                                                                                                                                                                                                                                                                                                                |
| WebFetch, WebSearch                  | a card per call (no allow rule)                                                                                                                                                                                                                                                                                                                       | the same; the sandbox's domain list doesn't limit them                                                                                                                                                                                                                                                                                                                                           |

Under the lane sandbox (**built**), the design column holds for the file tools:

- `disallowedTools` carries a `Read(...)` rule for each protected read the session doesn't need, and for each
  secret file. `ask` rules make Claude Code ask before an Edit or Write of a path it protects from sandboxed Bash.
- The broker decides reads outside the checkout on the real path. It refuses protected reads with no card and
  asks about the rest, naming every real path that needs asking. Read, Grep and Glob run without a card only
  inside the checkout and the project's read list. The sandbox temp root (`/private/tmp`), all but the
  session's own temp dir, is a protected read: it holds every other session's temp dir and sealed files, an MCP
  server's approved variables among them.
- Claude Code applies its own `disallowedTools` deny rules first (live: a Read of a space-named protected
  directory was denied by a rule, and the guard never saw it). For the calls that reach the guard's `PreToolUse`
  hook, it resolves every file-tool path through links, and refuses `.git/` internals and protected real paths. A path it can't resolve exactly is refused: a link loop, `..` past a missing
  part, a part it can't examine (`WriteAccess` is `ok`, `git-internal`, `claude-protected` or `unresolvable`).
- **A Grep, Glob or LS of a directory that holds a protected root is refused with no card.** This narrows lane
  sandbox spec D8, which sent every read outside the checkout to the broker: a tree search of an ancestor would
  read the protected root, so no approval can make it safe. A data directory or account config directory inside the
  checkout therefore makes every Grep, Glob or LS of the checkout root refused as containing protected paths.
- **Stored rules.** A main-era "always allow" rule with no pattern for Read, Edit or `SandboxNetworkAccess`
  matches nothing under the sandbox; with the switch off it allows the tool, as on main. A path rule matches one
  exact real path for edits, and a real path and everything under it for reads. A Read or Edit whose path the
  broker can't judge (none given, or judging failed) is refused with no card.
- **Secret files.** `.env*` at any depth (case-folded; `node_modules` and `.git` aren't walked) is kernel-denied,
  listed in `disallowedTools` and judged by exact real path. A `.env*` link is denied by its own path and by the
  real path it leads to, wherever that is; a link that can't be resolved (dangling, or a loop) reads nothing and
  is skipped. The walk is asynchronous. A secret file whose path
  holds `*`, `?`, `[`, `]`, `{`, `}`, `\` or a newline refuses the lane: Claude Code drops the whole sandbox,
  without an error, on a value it can't parse (spike 14 check 11).

### 4.4 A lane's Bash and its children

|         | Today                                           | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read    | everything the builder can                      | Every user-data root is denied (`/Users`, `/Volumes`, the shared temp roots), then the checkout, the toolchains and caches and the lane's own temp directory are allowed again. The protected reads stay denied whatever the project lists: the data directory, every config directory, `~/.claude.json`, `~/Library/Keychains`, `/usr/bin/security` and the checkout's `.env*` files. Under srt (the gate) `security` still runs; the barrier is the denied `~/Library/Keychains`, and inside the gate `security` sees only the System keychain (measured). Spike 13 checks 2–4 showed that `denyRead` holds against 25 read routes, including links, archives, interpreters and alternate path spellings. |
| Write   | everything the builder can                      | Only the checkout and the lane's own temp directory. Inside the checkout, Claude Code protects `.git/hooks`, `.git/config`, the `.claude` settings files, `.claude/hooks` and `.mcp.json`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Env     | the login environment plus the account's secret | No credentials (R1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Network | anything                                        | Through the sandbox's proxy. The project's allowed domains open directly; any other host raises a `SandboxNetworkAccess` request that the broker answers (spike 13 check 9). Loopback is reachable only in a project that turns it on (D15). Whether name lookups can carry data out is §8 check 8.                                                                                                                                                                                                                                                                                                                                                                                                         |
| Run     | anything; a card for what no rule allows        | The same, inside the sandbox. A setuid binary such as `ps` can't run (spike 13 check 10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

Under the lane sandbox (**built**), the design column holds for a lane's Bash:

- **Read.** The profile denies `/`, then allows back the system locations, the checkout, the toolchain reads, the
  lane's temp directory (which holds its package caches), and the project's read list (spike 14 check 5, the strongest form).
  The protected reads and the checkout's `.env*` files stay denied. A `.env*` link to a directory denies the
  directory; one that holds the checkout, a system location, a toolchain or the lane's own directories, or lies
  inside a system location or a toolchain, refuses the session, naming the link's target, rather than start a
  lane whose commands fail with no reason given. The checkout, toolchains and lane paths compare by their real
  paths as well as their spelling, so a toolchain reached through a link is caught too. A link to a file
  anywhere just denies the file. `/tmp`, `/var`
  and `/etc` are in the allowed system locations, and they reopen only the links to `/private/tmp`,
  `/private/var` and `/private/etc`: a canary under `/private/tmp` or `/private/var/folders` stays denied.
- **Write.** The checkout (Claude Code's own default) and the lane's temp directory, and nothing shared with
  another lane or the builder's own tools. In a linked worktree Claude Code also opens the worktree's own git dir for writing (`HEAD`, `index`, new files), except `commondir`, `config.worktree` and `gitdir`; see the linked-worktree bullet below.
- **Temp directory.** Each session gets its own, under `/private/tmp`, through `CLAUDE_CODE_TMPDIR`. Claude Code
  falls back to the shared `/tmp/claude-<uid>` without a word when the path is over 44 bytes, so the daemon refuses
  to start a session whose path is longer (spike 14 check 10). Unix sockets are allowed only there.
- **Package caches are per lane.** No writable cache that can hold code a later install or build runs is shared
  between lanes. npm's cache, node-gyp's headers, corepack's downloads, pnpm's store, state and cache, and
  cargo's `CARGO_HOME` live in `<lane temp dir>/cache` and go with the lane. A shared writable cargo home would
  let one lane write `config.toml` (a `rustc-wrapper`, a runner, an alias or `[env]`) or edit an unpacked
  crate's `build.rs`, which cargo doesn't recheck once `.cargo-ok` exists. The cost is measured: cargo's
  fingerprints include the registry's path, so a lane's `cargo check` of the Tauri crate downloads its crates
  and rebuilds all 239 of them every session, 30 to 37 s here, where an unchanged cargo home makes it a no-op.
  A read-only per-project cargo home that the daemon prefetched would remove that cost, but the prefetch would
  be a process outside the sandbox acting on a lane-written manifest, lockfile and `PATH` (a manifest's git
  source or alternate registry, a `rustc` on `PATH`, a lockfile swapped after a check), and Seatbelt can't
  limit its network to crates.io's hosts. The lane sandbox adds no unsandboxed process that acts on
  lane-writable input, so there is no prefetch. The gate runs under the sandbox too, with caches of its own
  (§4.7). Approved repo stdio MCP servers run under srt too, with only the hosts their approval names and caches of their own (§4.6). npm's cacache index lines carry only a hash of themselves (from the format, not measured),
  and pnpm 12.13.0 replaced a tampered stored file on reuse (measured), but neither cache is shared.
- **Toolchains.** A lane reads mise's state and cache dirs, `~/.cargo/bin`,
  rustup's home, each version manager's installs by its own layout, and the own files of each `PATH`
  entry under home; all read-only. It can also list mise's `installs` dir and its tool dirs, by name only.
  - **mise's config dir is never opened.** It can hold the age key (`age.txt`) and a global `config.toml`
    whose `[env]` often holds tokens, and mise's shims would apply that `[env]` to lane commands. Each lane
    gets its own global mise config in its temp dir (`MISE_CONFIG_DIR`, `MISE_GLOBAL_CONFIG_FILE`), holding
    the builder's global tool versions and nothing else, merged in mise's own order, measured with mise:
    `conf.d/*.toml` alphabetically, `config.toml`, `config.<MISE_ENV>.toml`, `config.local.toml`, then
    `~/.tool-versions`, the later winning. A tool key with inline backend options (`aqua:x[exe=y]`) is
    dropped. mise's system config is closed too: `/etc/mise` and `/private/etc/mise` are denied, and
    `MISE_SYSTEM_DIR` and `MISE_SYSTEM_CONFIG_FILE` point into the lane's own mise dir. No toolchain read
    equals, holds or lies under mise's config dir or global config file, whatever `MISE_STATE_DIR` or
    `MISE_CACHE_DIR` names. It holds no `[env]`, `[vars]`, `[tasks]`, `[hooks]`,
    `[settings]` or tool options such as `postinstall`. It is parsed with `smol-toml` and checked with zod.
    mise's age key and any file a `MISE_*AGE_KEY_FILE` names are denied by exact path. Measured under a
    Seatbelt profile built from the reads: `node`, `npm` and `pnpm` resolve through mise's shims with the lane
    config, and an `[env]` token in the builder's global config doesn't reach the command.
  - **mise's `installs` dir and its tool dirs can be listed, by name; no version opens whole, and its data
    dir stays closed.** mise lists `installs` and each `installs/<tool>` on every command, shims included.
    Without the listing every mise call prints `failed to scan installs/<tool>: Operation not permitted` per
    tool and exits (measured with mise 2026.10.11: `mise ls`, and a `cargo` or `pnpm` shim). Seatbelt allows a
    listing for an exact match of the directory, but srt renders a plain path as a subtree and only a pattern
    as an exact match, so the listing is granted as two patterns: the dir with its last character as a
    one-character set (`.../install[s]`) and its children (`.../installs/*`). Neither reaches into a tool
    dir's versions. Each version's contents open entry by entry (below), from what is installed when the
    profile is built, so a version installed later, its `etc/npmrc` and `lib/node_modules/npm/npmrc` included,
    stays closed; the profile writes no deny inside a tree it opened. The patterns are the only ones the
    profile holds, and only from `toolchainAccess`'s `listings`. Claude Code's sandbox takes them too
    (measured with Claude Code 2.1.312: the listings worked, a version dir and its `etc/npmrc` stayed denied,
    and the sandbox stayed on). `downloads`, `plugins` and the rest of the data dir stay closed and nothing
    under it is writable. The state dir stays read-only: mise's write of a `tracked-configs` link for the
    lane's config fails, which is only a warning, and `MISE_LOG_LEVEL=error` keeps it, and mise's other
    warnings, off every command (mise has no setting that mutes one warning; errors still print). Pointing
    `MISE_STATE_DIR` into the temp dir instead would also hide the builder's `trusted-configs`, so a project's
    own `mise.toml` would stop being trusted, and let a lane trust its own config.
  - **Other version managers' trees are not opened whole.** For nvm
    (`versions/node/<version>`) and volta (`tools/image/<tool>/<version>`) the daemon lists the installs by the
    manager's own layout, two levels down, and opens every entry of each version except `etc`, by its written
    path, and by its real path only when that stays inside the manager's home or another toolchain read (a
    version linked elsewhere opens by its written path, which the kernel refuses). It opens every entry rather
    than only `bin`, `lib`, `include` and `share` because some tools keep their binary at the install root
    (mise's pnpm and actionlint, measured). It also opens what each manager's shims read: mise's `shims` and
    each tool's `.mise.backend.toml`, nvm's `nvm.sh` and `alias`, volta's `bin`, `tools/user` and layout file.
    What is not listed stays closed: volta's `inventory`. rustup's home opens whole: its
    toolchains hold no registry config.
  - **A version that is a link** (mise adopts a rustup-managed rust as `installs/rust/<version>` linked to
    `~/.cargo/bin`) also opens by its written path when its real path is a granted read: the kernel checks the
    link itself before it follows it, and mise stats it. Because mise counts such an install as present only
    when the link leads to `$CARGO_HOME/bin`, the sandbox makes `<temp dir>/cache/cargo/bin` a link to
    `~/.cargo/bin`: mise then finds the install, and cargo still reads no config or credentials and keeps its
    registry and target caches in the temp dir. `~/.cargo/bin` stays read-only, so a `cargo install` fails.
  - **A manager's home** is the one its variable names (`MISE_DATA_DIR` or `XDG_DATA_HOME`, `NVM_DIR`,
    `VOLTA_HOME`, `RUSTUP_HOME`; mise's state and cache follow `MISE_STATE_DIR`, `MISE_CACHE_DIR` and the XDG
    dirs too), else its default. It needs no marker file, since Homebrew's nvm and volta leave none in it, but
    it must lie under home and be neither a broad dir (`~/.config`, `~/.local`, `~/.cache`, `~/Library`,
    `~/Documents` and the like) nor a protected read, under one or holding one.
  - **A `PATH` entry under home never opens whole.** Anything below it could hide a node install. Its own
    files open, and so do pnpm's own installs by layout, never their `etc`: its node installs
    (`nodejs/<version>`) and its self-updates (`.tools/<package>/<version>`). Its other subdirectories stay
    closed, pnpm's global CLIs under `PNPM_HOME` among them, and an entry that can't be listed opens nothing.
    A `PATH` entry inside any project's checkout or the lane temp root is dropped before anything is read or
    denied, so no lane can change another lane's profile or refuse its session.
  - The builder's own pnpm dirs (`~/Library/pnpm`'s store, its cache, and `~/Library/Preferences/pnpm`, whose
    `rc` can hold a token) are not opened: each lane has its own pnpm store and cache.
  - Measured under a Seatbelt profile built from the reads, run from a checkout outside home: `node`, `npm`,
    `npx`, corepack (from the registry, since Node 26 dropped it), pnpm through corepack, and a node-gyp native
    build that loads all work. nvm and volta are tested against their documented layouts only.
  - **Apple's `/usr/bin/git` and `make` are xcrun shims.** Each call looks its tool up through a cache file
    named `xcrun_db-<random>` in the per-user Darwin temp dir (`getconf DARWIN_USER_TEMP_DIR`, under
    `/var/folders`), which no sandbox can write and `TMPDIR` doesn't move. Without a cache every call prints
    `couldn't create cache file ... (errno=Operation not permitted)` and repeats the lookup, which made a
    git-heavy test run past its timeout. xcrun reads the variable `xcrun_db` for the file's path (measured: with
    it set, the cache is created there), so the sandbox points it at `<temp dir>/xcrun_db`, inside the temp dir
    every sandbox already writes. No write is opened anywhere else, and the cache goes with the temp dir. xcrun
    execs the tool the cache names, so only the sandboxed shell gets the variable (the env file and a gate's
    inner env); a lane's session env, which Claude Code and its git run with outside the sandbox, never does
    (see Environment).
- **Registry tokens and keys.** A node install's global `etc/npmrc` is never opened. Denied by exact path, with
  no walk: each version's `etc/npmrc` and npm's builtin `lib/node_modules/npm/npmrc`, by both spellings (a
  version linked into a Homebrew keg keeps its `etc` there); the npmrc files of each `node` on the lane's
  `PATH`, under the prefix `PATH` names and its real prefix; those of each install prefix (`/usr`,
  `/usr/local`, `/opt/homebrew`, `/opt/local`) and each direct child that holds `bin/node`, never a temp or
  other lane-writable dir; cargo's `credentials`, `credentials.toml`, `config` and `config.toml` in `~/.cargo`
  and in the login's `CARGO_HOME`; and mise's age keys. A missing file is denied, since it may appear later; a
  link is denied by its path and, when it leads to a regular file, by that file's real path; a directory there
  is left out, so lane-made junk can't refuse a session; a name the profile can't hold refuses the session,
  naming it. No toolchain read equals or lies under one of these files, and a toolchain secret that holds the
  checkout, the temp dir or an extra read refuses the session with its own message, apart from the `.env*`
  one.
- **Network.** `allowedDomains` holds the hosts the project's stored rules allow. An unlisted host raises a
  `SandboxNetworkAccess` request: the broker denies it at once, raises one card per host per session, and the lane
  retries after the answer. Allow once reaches only a session that is still running. Allow for the project stores
  a rule that the next session's profile lists. A host the profile can't list, a name with an underscore or an
  IPv6 address, is stored too, and the broker allows each request for it without a card. The card stays open
  after the session ends. The host arrives bare, with no port and no trailing dot (measured live). Loopback is off unless the project turns on "Let lane
  commands use localhost" (Settings › General, D15), read when each session starts.
  The builder can also allow a host ahead of a card (Settings › Network hosts, `GET/POST/DELETE
/projects/:id/network-hosts`). It stores the same project-wide `SandboxNetworkAccess` rule an Allow for the project
  card stores, so it has the same trust, and a gate's profile lists it too, which is how a gate that reaches a host
  (cargo: `index.crates.io`, `static.crates.io`) can pass: a gate's denied host raises no card. It refuses what the
  profile can't list, loopback, `*` and a whole top-level domain
  (`decisions/2026-10-29-project-network-hosts.md`).
- **Run.** `autoAllowBashIfSandboxed` is off, so every command Claude Code doesn't treat as read-only reaches the
  broker. It allows the command without a card unless it is a hazard or something unread could make it one
  (`decisions/2026-10-28-broker-unread-arguments.md`): a program it can't name (`$CMD`, a substitution, a glob, a
  wrapper such as `sudo` or `noglob`), a script it can't read (`eval`, a shell's `-c` text or piped input), a
  structure the parser isn't sure of (an open quote, a case, a function), a process substitution, or an argument
  that could select a hazard form of a program that has one (`pnpm $x` could be `pnpm add`, `pnpm exec $x` could be
  `pnpm exec drizzle-kit generate`; the forms come from the project's hazards). An unread argument to any other
  program (`cd $d`, `eslint $f`) does not earn a card. This is a best-effort scan of the command's text, not a
  proof: a hazard run through a runner the scan does not look through (it reads through `env`, `mise x --`, `corepack`, `arch` and `script`), a flag value in a program with no flag table, and a program
  that runs a hazard on its own are known gaps (the decision names them), and the sandbox bounds what they can
  do. An approved pnpm 12 install still fails in the sandbox: pnpm takes its store operation lock in a fixed
  `/private/tmp/pnpm-store-operation-locks-<uid>` and ignores `TMPDIR` and its store settings for it (measured:
  pnpm 12.13.0 under a Seatbelt profile fails with `ERR_PNPM_STORE_DIR_OPEN_OPERATION_LOCK` without that
  directory and installs with it). That directory is shared with every lane and the builder's own pnpm, so the
  profile keeps it closed, and the pnpm hazard card says to run the install outside the lane or use npm.
- **The git dirs are read-only to lanes.** Only the daemon writes git state. Claude Code opens the checkout,
  `.git` included, and a linked worktree's own git dir for writing; the profile denies writes to the checkout's
  git dir, its common dir and `<checkout>/.git`, file or directory, wherever the git dir lies, and to those of
  every other registered checkout, so a project nested inside this checkout keeps its git state too. Every
  other registered checkout that isn't this one's ancestor is read-only as a whole, for lanes and gates alike,
  so a lane can't edit the files of a project nested in its checkout either. A lane can't move HEAD or a
  ref, stage, or plant config, hooks, alternates or attributes. Its read-only git still works: the env sets
  `GIT_OPTIONAL_LOCKS=0`, so `git status` doesn't try to refresh the index, and the live test runs `git status`,
  `git diff` and `git log` with the dirs read-only. Re-run it after each Claude Code or SDK upgrade.
- **The profile is validated.** An invalid value drops the sandbox without an error (spike 14 check 11), so the
  daemon builds the profile from paths, host names and variable names only, checks it against a strict schema
  before the session starts, and `apps/daemon/test/lane-sandbox.live.test.ts` (run with `TENDB_LIVE_CLAUDE=1`,
  not in `make gate`) proves the built profile against the real Claude Code with canaries.

### 4.5 Repo settings and hooks

- **Today:** the repo's `.claude/settings.json` loads. The billing check refuses three things:
  - `env` families that change billing;
  - credential helpers;
  - `disableAllHooks`.

  It doesn't refuse `hooks`, `permissions` or `sandbox`. So a lane holding the `harness` claim can edit the file
  and give the next session in that checkout either of these:
  - a hook that runs outside every sandbox;
  - allow rules that skip cards.

- **Design:** no setting from the repo may run a command outside the sandbox, widen the sandbox or the
  permission rules, or turn off a check (R7). **Built**: a lane loads no repo setting at all (§4.3).

### 4.6 Repo MCP servers

- **Approval:** a stdio server runs only after the builder approves its config, keyed by a hash of its command,
  args, env, URL and headers, and of the hosts `.10db/mcp-hosts.json` names for it
  (`decisions/2026-10-27-mcp-approval-hosts.md`). Its tools go to cards. The hash doesn't cover the code the command runs: an
  approved `node scripts/mcp.js` runs whatever the lane last wrote to that file. So the server runs under srt.
- **Built** (decision 133, `sandbox/mcp-sandbox.ts`): each approved stdio server runs under srt like the gate
  (§4.7), one sandbox per server and session, made with the lane's own (`LaneSession.mcpServers`) and removed
  with it. An http or sse server is a connection Claude Code makes, not a process, so it needs none.
  - **Launch.** Claude Code runs `/usr/bin/env -i PATH=<system> HOME=… CLAUDE_CODE_TMPDIR=<its temp dir>
<node> <srt.mjs> --settings <sealed file> -c <inner>`, so the session env Claude Code merges into a
    server's never reaches srt's host. srt and node are the daemon's own (`sandboxRuntimeFor`), refused when
    they lie where a project writes. Inside the sandbox, `/usr/bin/env -i <srt's proxy variables> /bin/sh -c '. <env file> && exec "$@"'`
    keeps srt's proxy variables by name and sets the rest of the server's env from a sealed file (mode 0400, beside the temp dirs and outside every one), and execs
    the command, so srt's TERM reaches it when Claude Code stops it. No approved value is on a command line: a stdio
    server whose command or args hold `${` is ignored when the config is read, with a card saying values reach
    it only through its env block. The gate's signal wrapper isn't used: it exists so a killed gate fails its
    verdict, and no verdict reads a server's exit status.
  - **By type.** A session takes a stdio server only as a `SandboxedMcpServer`, an object whose launch is a
    private field and whose constructor takes a key only `mcp-sandbox.ts` holds, so a copy or a look-alike
    neither typechecks nor carries a launch. With no lane sandbox (fake sessions, tests) an approved stdio
    server is left out and named in the prompt. A server whose sandbox can't be built (an approved value with
    a control character) is left out, named in the prompt and on a card, and the session starts.
  - **Profile.** The lanes' reads and protected reads, the session's account config dir included, with the
    `.env*` and toolchain secrets denied. It writes only its own temp dir, not the checkout: a server has no
    reason to write the repo. Every registered checkout's git state and srt's `/tmp/claude` are denied, and
    Unix sockets work only in its temp dir, so Docker's and the SSH agent's stay closed. It reaches the hosts its
    approval names and no others, not the project's: `allowedDomains` is the approval's list under
    `strictAllowlist`, empty when it names none. A host is a DNS name or `*.` and a domain (every subdomain,
    not the domain itself); IP addresses, ports and `localhost` names are refused when the file is read, and
    srt refuses an allowed name that resolves to loopback, link-local, metadata or this Mac's own addresses,
    dialing the address it checked. A name that resolves to a private range is let through, as for lanes. It
    never gets loopback, whatever the project's switch: other sandboxes' proxies listen on localhost, and
    through them it could reach hosts its approval doesn't name.
  - **Env.** The lanes' allowlist of the session env (no credentials), the sandbox's own variables
    (`prepareCommandEnv`: package caches in its temp dir, mise, `xcrun_db`, `GIT_CONFIG_GLOBAL=/dev/null`,
    `TENDB_SANDBOX=1`), `NODE_USE_ENV_PROXY=1`, `TMPDIR`, `PATH`, `HOME` and the approved variables, and srt's
    proxy variables (`HTTP_PROXY`, `HTTPS_PROXY`, `ALL_PROXY`, `NO_PROXY`, `GRPC_PROXY` and their lower-case
    forms). Their URLs carry srt's proxy token, which srt itself passes to `env` on a command line for the
    instant before it execs; the inner `env -i` passes them the same way, for no longer. The token stays in the
    server's env for its life (Residuals).
  - **Package fetching.** A server that downloads its package when it starts (`npx -y <package>`, `uvx`,
    `pnpm dlx`) reaches the registry only when `.10db/mcp-hosts.json` names it (`registry.npmjs.org` for
    `npx`); otherwise it fails to connect unless the repo installs the package. 10db doesn't recognise such
    commands: a person writes the registry in the file and the builder approves it on the card. The session's
    prompt and log name a server that failed to connect. A client that ignores the proxy variables and dials
    out itself is refused by Seatbelt.
  - **Measured** (`test/mcp-sandbox.seatbelt.test.ts`, macOS, in `make gate` and CI's macOS job): srt adds
    nothing to a server's stdout, whose JSON-RPC `initialize` answer is its only line. Reading a canary in home,
    home itself and `~/.ssh`, another server's sealed env file and the lane's `CLAUDE_ENV_FILE`, writing home,
    the checkout, `.git` and outside the temp dir, a direct connection to `1.1.1.1` and one to localhost with the
    project's switch on are refused; `GH_TOKEN` and an AWS key don't arrive; reading the checkout and its own
    env file, writing its temp dir and its approved variable work, and the TERM sent to srt reaches it. A `CONNECT`
    through srt's proxy to an approved `.invalid` name and to a subdomain of an approved wildcard passes the
    allowlist; one to the wildcard's own domain, to an unapproved name, and every one from a server approved
    with no host, gets srt's `blocked-by-allowlist` refusal.
  - **After a crash.** A daemon that starts sweeps the sandbox temp root before any session or gate starts
    (`claimSandboxTempRoot`): it removes this user's lane temp dirs (`10db-` and six characters) and sealed
    files (`10db-env-`, `10db-gate-`, `10db-mcp-`), each by its exact name and its own kind, never following
    or removing a link. It then marks the root with its pid (`10db-daemon-<pid>`), and a daemon with another
    data dir that finds a live mark sweeps nothing, since that daemon's sessions may be running.
- **Residuals:** an approved variable reaches the server and can leave through its tool results (§7) or to
  the hosts its approval names; a wildcard over a public suffix (`*.github.io`) opens every site under it; srt's
  proxy token is in the server's env, so a lane that rewrites the server's code can have a tool return it and,
  with the project's loopback switch on, reach the server's approved hosts through its proxy; a server that
  needs a host its approval doesn't name fails (§7); a server that
  ignores both a closed stdin and TERM after claude dies keeps running, sandboxed, while its temp dir is
  removed; and a daemon run from source inside a project's checkout refuses that project's sessions that have
  an approved stdio server, as srt then lies where a lane writes.

### 4.7 The gate and the git hooks the daemon runs

- **The gate, built (decision 132):** a task's gate at its green run and a batch's at ship run
  `/bin/sh -c <gateCommand>` in the checkout under srt (`@anthropic-ai/sandbox-runtime`, Seatbelt), in its own
  process group, from `sandbox/gate-sandbox.ts`. `createGateRunner` takes its sandbox, or an explicit `null`
  that only tests pass; the daemon's `sandbox` option builds the lane and the gate sandbox together and is null
  only for fake sessions (`TENDB_FAKE_SCRIPTS`, development and e2e only), whose gates then run unsandboxed
  (§7).
  - **The engine.** srt's own command line, which the app carries beside the daemon (`srt.mjs`), runs once per
    gate with a sealed settings file (mode 0400, beside the temp dirs and outside every one of them), so each
    run has its own proxy and allow list. srt in-process would share one proxy and one set of settings across
    every project's gates. srt's host, the shell it starts the sandbox from and `/usr/bin/env` run outside the
    sandbox with only a system `PATH`, `HOME` and srt's temp variable; the gate's env is set inside it.
    Because they run outside it, a gate run refuses an srt or node that lies, as written or through a link, at
    or under a registered checkout or the sandbox temp root, and the bundle runs only its own `srt.mjs`, never
    one found in a `node_modules`. The bundle also carries srt's Java proxy agent beside it, where srt looks
    first; without it srt runs `npm root -g`, unsandboxed, from the gate's checkout.
  - **The verdict.** srt exits 0 when its own child dies by SIGTERM or SIGINT, so the command is never that
    child: a shell that traps both waits for it and exits 143 or 130, and a gate killed by a signal fails. When
    srt closes, the runner kills the gate's process group, so nothing the gate left running outlives its
    verdict. The run's temp dir is then removed by child processes, off the daemon's event loop.
  - **Reads** are the lane profile's, built by the same code (`buildLaneProfile` over `projectAccess`): deny
    `/`, allow back the system locations, the checkout, the toolchains by layout and the run's temp dir, and the
    project's stored read paths. The protected reads, the checkout's `.env*` files and the toolchain secrets stay
    denied. No home path opens but the toolchains: not `~/.ssh`, `~/.config` or the data directory.
  - **Writes** are the checkout and the run's own temp dir, made under `/private/tmp` for the run and removed
    after it, holding its package caches (`CARGO_HOME` included, so cargo builds from scratch each run). Every
    registered checkout's git dir, common dir and `.git` are denied, every other registered checkout that isn't
    this one's ancestor is denied as a whole, and so is srt's shared `/tmp/claude`.
    Inside the checkout srt itself refuses writes to `.git/hooks`, `.git/config` and shell startup files at any
    depth, so a gate can't create a repository there.
  - **Env** is the lanes' allowlist of the project env, plus the sandbox's own variables (the package caches,
    the mise config, `MISE_LOG_LEVEL=error`, `xcrun_db`, `GIT_CONFIG_GLOBAL=/dev/null`, `GIT_OPTIONAL_LOCKS=0`, an empty `XDG_CONFIG_HOME`,
    `TENDB_SANDBOX=1` and `TMPDIR`). No `GH_TOKEN`, `SSH_AUTH_SOCK`, cloud key or account variable. srt scrubs
    nothing, so every variable arrives (measured).
  - **Network** goes through srt's proxy, with `strictAllowlist`: only the project's stored hosts, the same list
    its lanes get. Loopback only when the project turns it on. Unix sockets only in the run's temp dir, so never
    Docker's socket or the SSH agent's. A `docker` that refuses leads the gate's `PATH`: when the gate runs it,
    the evidence ends by saying Docker isn't available to sandboxed gates. A library that opens the socket
    itself gets the kernel's refusal and says so in its own words.
  - A profile the sandbox refuses (a `.env*` link to a toolchain, a variable with a control character) fails
    the gate with exit 126 and the reason in its evidence; nothing runs.
  - `apps/daemon/test/gate-sandbox.seatbelt.test.ts` runs the real srt on macOS in `make gate` (skipped on
    Linux and inside a sandbox, where Seatbelt can't nest): a canary in home, `~/.ssh`, `~/.config`, writes
    outside the checkout and to its git state, `GH_TOKEN`, an AWS key, the SSH agent's variable and socket,
    Docker's socket, a host off the list, a direct address and loopback with the switch off all fail, while a
    normal test command passes. A gate that kills its own group with SIGTERM or itself with SIGINT, and one
    whose srt is sent SIGTERM, all fail. CI's macOS job runs it, with the sandbox's unit tests. `apps/daemon/scripts/sandboxed-gate.ts` runs a project's gate this way by
    hand.
- **The daemon's git, built (D13):** it runs no hook, filter, attribute-selected driver, fsmonitor or submodule
  git. The surface is switched off, not checked for, and git itself handles every path:
  - every call reads no attributes (`GIT_ATTR_SOURCE` at the empty tree, `core.attributesFile=/dev/null`), so
    no filter, driver or line-ending conversion is selected whatever config names. It passes
    `core.hooksPath=/dev/null`, `core.fsmonitor=false`, `submodule.recurse=false`, `core.protectHFS` and
    `core.protectNTFS`, drops every `GIT_*` variable but the global and system config selectors (and, for
    fetch and push, the builder's ssh and askpass ones), and is killed after 60 s. `gh` gets the hook and
    fsmonitor config through `GIT_CONFIG_COUNT`. Every call, local and network, runs the one git resolved at
    startup from fixed install prefixes, in order `/opt/homebrew/bin`, `/usr/local/bin` and `/usr/bin`, never
    the login `PATH`, which can name a directory a lane writes (under `pnpm dev`, a checkout's
    `node_modules/.bin` leads it). It is the first that passes a behaviour probe, kept by the path it was found at, which a `brew upgrade` and its
    cleanup leave in place (the Cellar file a prefix link points to is deleted, the link isn't), and which no lane
    can write: in a
    scratch repository whose `.gitattributes` selects a filter, `check-attr` under `GIT_ATTR_SOURCE` at the
    empty tree must say `unspecified`. The global `--attr-source`, and `GIT_ATTR_SOURCE` with it, arrived in
    git 2.41; Xcode's git 2.39 fails the probe, and with no git that passes the daemon refuses to start, naming
    the gits it found and how to install one. `DEVELOPER_DIR`, `SDKROOT` and `TOOLCHAINS` are dropped from every
    git call, the probe's included, and from gh: they steer Xcode's `/usr/bin/git` shim to another git per
    spawn. `runGit` takes the binary as a required argument, gh runs with that git's directory first on its
    `PATH`, and the system check reports the git and gh the daemon resolved, so no daemon process runs a git
    found on the login `PATH`. claude and docker are looked for the same way: the install prefixes, then
    their own install directories in home (`~/.local/bin` and `~/.claude/local` for claude, `~/.docker/bin`
    for docker), which no lane writes; `TENDB_CLAUDE_PATH` overrides claude's;
  - once a checkout is pinned, every call runs with `GIT_DIR` at the pinned git dir and `GIT_WORK_TREE` at the
    checkout, so git never reads the `.git` gitfile again and a linked worktree's `commondir` comes from the
    read-only git dir; a lane can't swap the gitfile between two calls, and the profile denies writes to it.
    The pin is read once per operation and every call in it uses that one. `check-attr` for the filter refusal,
    the one call that reads attributes, runs the same git in the same git dir;
  - an attributes file in the git dir (`info/attributes`) is the one source that setting can't switch off, so
    a non-empty one refuses every call with a card;
  - a commit stages with `git add -A` on a private `GIT_INDEX_FILE` seeded from the branch tip (git writes
    nothing through a link and checks every path), refuses a changed gitlink or `.git`-like name, then runs
    `write-tree`, `commit-tree` and `update-ref --no-deref <branch> <new> <old>`. HEAD is never touched;
  - changes are found with `status --ignore-submodules=all` against a private index seeded from HEAD, so
    finding them never refreshes the checkout's own index. The daemon writes that index in three places
    only: a commit's `reset` of the paths it committed, so the builder's `git status` agrees, and a base
    merge's `update-index --refresh` and `read-tree -m -u` (below), all under the hook and fsmonitor config;
  - a batch's new branch is made with `update-ref` and checked out with `read-tree -m -u`, which runs no hook;
  - before each gate of a worktree batch, its base is merged into its branch (`mergeIntoBranch`,
    `decisions/2026-10-29-gate-with-base.md`): `merge-tree --write-tree`, which writes objects only and, with no
    attributes, runs no merge driver; `commit-tree` with the branch as first parent, signed only as the
    builder's own config says; `read-tree -m -u` from the old tip to the merge, after refusing when an
    uncommitted, untracked or git-ignored file lies where it would write; then the compare-and-swap `update-ref`.
    It writes the worktree's files and its own index. A task's start on the merged base is a commit
    `mergedCommit` keeps at `refs/10db/starts/<workstream id>`, unsigned and never pushed, touching no file,
    index or branch. A base whose tree asks for a filter is refused, as its push would be. The fetch before it
    runs one at a time per checkout;
  - a gitlink, a directory that holds `.git`, or a path whose attributes name a filter is refused with a card,
    never committed. The pre-push hook never runs; the shipping gate checks a batch before its push.
- **10db's own gate passes under it** (measured; `make gate` with loopback on and crates.io's two hosts
  allowed). Changes it took: e2e skips under `TENDB_SANDBOX=1` (§7); tests that need a setuid `ps`, the shared
  `/tmp`, the builder's real home, Seatbelt itself or gitleaks with Apple's git skip there and still run in CI;
  test daemons get the test's `TMPDIR` and no global git config; the e2e fixture repository lives in the temp
  dir; Babel is given its targets, so browserslist never looks above the checkout; Prettier skips
  `.env.example`, which the sandbox denies.

### 4.8 The daemon's network git and `gh`

- `gh` runs with the login environment, and its token is in the Keychain. Arguments are arrays and flags are
  fixed. Output is zod-parsed, and a PR URL must name the batch's repository.
- Lanes never push, in any delivery mode: the guard refuses `git push`. The daemon pushes, and only when a batch
  ships.
- gh runs in an empty directory of its own and always names the repository with `-R`, taken from origin's
  pinned push URL, so it runs no git in a checkout. A batch start checks origin's push URL against the pin
  first, so an origin added or changed since registration raises the Origin card, which offers it for trust.
  gh itself comes from the same fixed prefixes as the daemon's git, in the same order, resolved at startup by the
  path it was found at; every call runs that path, and the resolved git's directory leads gh's `PATH`, so any git
  gh runs is the daemon's one git. With no gh in those prefixes, each gh call fails as not installed and the
  system check reports gh missing.
- Fetch and push take the builder's credential helpers from its own config (system, global and the login
  environment's `GIT_CONFIG_COUNT` and `GIT_CONFIG_PARAMETERS`), URL-scoped ones such as `gh auth setup-git`'s
  included, read with the login environment the call runs in. They are re-emitted through `GIT_CONFIG_COUNT`,
  after an empty helper that resets the list, so a URL holding `=` stays whole, and `--` goes before the URL.
  A local or `file:` origin inside any registered checkout or a lane's temp root, read as written or through
  a link, is refused: its receive-pack hooks would run unsandboxed.
- Push and fetch go only to origin's fetch and push URLs as the daemon recorded them with the project's pin, in
  the form a strict parser printed, named explicitly; the config string itself never reaches the network call.
  A URL with userinfo (a user, password or token), or one that doesn't parse cleanly (`@`, `?`, `#`, a backslash,
  whitespace or a control character in a scheme URL), is refused with a card pointing at `gh auth`, a credential
  helper or ssh; an scp-style `git@host:path` is fine. If origin's URL changes, fetch and push refuse with a card
  until the builder re-trusts the checkout (D13, built). URL userinfo is also masked in every git error and log
  line, after the whole text is read and before it is cut short.
- They run with the builder's own transport programs pinned (`credential.helper` reset to the builder's own,
  `core.sshCommand`, `core.askPass`) and `protocol.ext.allow=never`. Before each, the config a
  lane could have written is checked against an allowlist, which refuses `insteadOf`, `pushInsteadOf`,
  `credential.*`, `http.proxy` and every include. A file counts as lane-writable when git read it at local or
  worktree scope, or it lies in the git dirs, any registered checkout or a lane temp root, read as written or
  through a link: a global include into another project's checkout is refused, and no program it names runs. The allowlist is defense in depth, not the boundary: it reads
  config in a process before the one that uses it.
- A branch whose tree selects a filter isn't pushed: Git LFS needs its pre-push upload, which reads lane-writable
  `.lfsconfig` for where to send objects. 10db refuses with a card and the builder pushes such a branch
  themselves; a batch can't start in such a repository either.

### 4.9 GitHub

- **It receives** the batch branch (every lane commit), the PR title and the PR body.
- **It runs** Actions workflows on the pushed branch, including workflow files a lane changed. A branch in the
  same repository gets the repository's secrets.
  - 10db's repository keeps none at repository level.
  - `release-bot`'s secrets are limited to `main` by a deployment-branch policy.
  - `release`, which holds the Apple signing secrets, deploys only from `v*` tags, and every run waits for
    the builder's approval.
  - `.github/repo-settings.json` declares both environments and `make github-settings` applies them.
  - A project 10db works on must keep its CI secrets in environments limited to protected branches. That is
    the builder's setup; 10db can't enforce it.
- **In the design**, a batch that changes `.github/workflows/**` or `.github/actions/**` stops for a card before the
  push, and every batch is scanned for secrets first (R12).
- **The boundary** for what reaches `main` is pull request review and the builder's merge.

### 4.10 A worktree is one more checkout

**Built.** In a worktree-mode project (`decisions/2026-10-27-worktree-lane-sandbox.md`) a batch's lanes, gate and MCP servers run in a git worktree under the daemon's worktree root. No rule above changes; the worktree is a checkout the existing rules already describe.

- **Its pin is made at creation and keyed by batch.** The daemon makes the worktree, so nothing is pinned on first use: the new worktree's git dir must lie under the project's pinned common dir and its common dir must be the project's, by device and inode, before any lane exists. The pin is stored as `checkout_pin.<batch id>` and found by the batch's `worktree_path`. A path at or under the root with no pin is refused with `GitTrustFailure.Unpinned`, so a directory someone else put there never gets a git call.
- **The root is lane-writable for config trust.** The hashed worktree root is among the lane-writable roots, so a config file or local origin inside a worktree counts as one a lane could have written (`laneWritableRoots`). A worktree's `.git` is a file, so no exemption for a `.git` directory applies to it.
- **The profile a worktree lane gets** is the one a lane of any checkout gets with the worktree as its checkout: the main checkout and every sibling worktree are other registered checkouts, read-only as a whole; the worktree's own git dir, its gitfile and the common dir are read-only (decisions 130 and 131). Every live worktree (a batch with `worktree_path` set) joins the checkouts handed to the lane, gate and MCP sandboxes.
- **The seed copy** (`delivery/worktree-seed.ts`) reads the main checkout, which no worktree lane can write, copies links as links without following them, skips FIFOs, sockets and devices, refuses to leave the worktree through a link, and runs nothing. A seed name is a directory name, checked when saved.
- **The dependency install** (`delivery/worktree-dependencies.ts`) runs after the seed, through the gate runner, so under srt with the project's allowed hosts: `pnpm install --frozen-lockfile --ignore-scripts --ignore-pnpmfile`, which runs no repository code. The run (`packageInstall`) alone gets pnpm's lock directory (`<system temp dir>/pnpm-store-operation-locks-<uid>`, which pnpm picks regardless of `TMPDIR`) open for reading and writing; the daemon refuses a lock directory that is a link or not private, and removes whatever a run left there that is not a regular file (`decisions/2026-10-28-worktree-dependency-install.md`).
- **Removal** touches only a directory under the root that git lists as the project's worktree and that carries a `10db ` lock reason (`decisions/2026-10-27-worktree-removal-and-sweep.md`). Abandon and the startup sweep check for uncommitted changes themselves and keep a worktree that has any, or that git can't read, with a card. `SHIPPED` and `CLOSED` run `git worktree remove --force --force` with no check of their own: they rely on ship step 0's clean check, and so does recovery when it re-runs a removal whose clear did not land. A worktree's changes are read with the git dir checked to be a direct child of the pinned common dir's `worktrees` and its `commondir` file naming that common dir.
- **The pull request template** is read from the shipped commit through git, not from the checkout (`decisions/2026-10-27-pr-template-from-commit.md`).

## 5. What the daemon reads, runs or sends for a lane

| Surface                                                                                                            | Worst outcome today                                                                                                                                                                                                                                                           | Protection today                                                                                                      | Design        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | ------------- |
| The data directory: `ui-token`, `daemon.json`, `10db.sqlite`, `logs/`, `delivery/`                                 | **A lane reads `ui-token` and calls the API:** it answers its own cards, sets a gate command (unsandboxed code), or approves its own MCP server. **A link planted at `delivery/<batch>-pr-body.md` or a gate log path** makes the daemon overwrite a file the link points to. | `feat/accounts`: the guard's text rules                                                                               | R3, R5, R8    |
| `.github/pull_request_template.md` (`delivery/pr-template.ts`)                                                     | Links are followed, with no size cap and no check for a regular file. A lane commits the template as a link to a credential file, and its text goes into the PR body on GitHub. A FIFO blocks the daemon.                                                                     | none                                                                                                                  | R8            |
| `.mcp.json`, `.10db/mcp-hosts.json`, `.claude/settings.json` (`sessions/repo-config-file.ts`)                      | `O_NOFOLLOW` covers the last path component only, so a linked `.claude/` directory is followed; a linked `.10db/` is refused, checked before the open, so a swap in between is not caught. The text is only parsed, never forwarded.                                          | regular file, 256 KiB cap, no link on the last component, zod                                                         | R8            |
| `git add` and `git commit` through the MCP `commit` tool; `git switch` when a batch starts and back when it ends   | No hook, filter or submodule git runs. A commit lands only on its workstream's pinned branch, in the pinned checkout.                                                                                                                                                         | plumbing commit over a private index; compare and swap on the branch; persisted pins (D13)                            | R9            |
| Git config keys that name programs: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, filter and diff drivers | None run in the daemon's git. A filter in the builder's global config can still run in the builder's own git.                                                                                                                                                                 | plumbing that reads no such key; transport programs pinned from global config for fetch and push; the allowlist (D13) | R9            |
| `git push` (`git/git.ts`)                                                                                          | The push goes to origin's URL as pinned with the project. A branch that needs Git LFS is refused.                                                                                                                                                                             | never forced; fixed refspec; prompts off; no pre-push hook; pinned URL (D13)                                          | R9            |
| The gate (`verify/gate-runner.ts`)                                                                                 | Lane-written tests and Makefile targets run in the sandbox: they read what lanes read, write the checkout and their own temp dir, and reach the project's hosts.                                                                                                              | srt (Seatbelt) with the lane profile, allowlisted env, own process group, timeout (decision 132)                      | built         |
| MCP tool inputs (`mcp/tools.ts`)                                                                                   | All are zod-parsed. Only `commit` names paths, and they are checked as writes within claims, links resolved. No tool makes the daemon read a path.                                                                                                                            | as described                                                                                                          | as is         |
| Text a lane writes: handoffs, evidence, proposals, decisions                                                       | It reaches later lanes' prompts and the builder's screen. An accepted proposal's text becomes a task, and then a PR body.                                                                                                                                                     | rendered as data; a builder's accept                                                                                  | accepted (§7) |
| The PR body (`delivery/pr-text.ts`)                                                                                | It is built from records, never from logs or diffs; the template row above is the exception.                                                                                                                                                                                  | as described                                                                                                          | R8            |

## 6. Requirements

These are the properties the design must have. The spec amendment chooses the mechanisms, and the re-scoped
guard task tests each one.

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | **No credential reaches a process a lane can make run.** That covers Bash and its children, the gate, the hooks of the daemon's git commands and repo MCP servers. None gets an account's secret or a login-shell credential (`GH_TOKEN`, AWS keys, the SSH agent, registry tokens). A lane's claude process holds its own account's credential and no other.                                                                                               | partly: Bash children and the gate, whose env is the lanes' allowlist, set inside its sandbox. The claude process still holds the login environment until D5 lands with accounts; the daemon's git runs no hook (D13); repo stdio MCP servers get the lanes' allowlist and their approved variables, inside their sandbox (§4.6)                                                                                                                                                                                                                                                     |
| R2  | **Every process whose code a lane can choose runs inside a kernel sandbox that denies the protected reads.** That covers Bash and its children, the gate, the hooks of the daemon's git commands and stdio repo MCP servers. A repo hook in settings is refused (R7).                                                                                                                                                                                       | built: Bash and its children, the gate (srt, decision 132) and repo stdio MCP servers (srt, decision 133, §4.6). The daemon's git runs no hook at all (D13)                                                                                                                                                                                                                                                                                                                                                                                                                          |
| R3  | **The sandbox reads only what the project needs.** Every user-data root is denied (`/Users`, `/Volumes`, the shared temp roots), then the checkout, the toolchains, the caches and the lane's own temp directory are allowed again. The protected reads are always denied, including the checkout's `.env*` files unless the project names an exception. A deny list can't name every secret on a machine; an allow list can protect secrets nobody listed. | partly: lanes and the gate, which share one read policy. The project's `.env*` exceptions are designed                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R4  | **The file tools follow the same read policy**, and never write `.git/` internals. Claude Code's permission deny rules enforce it, along with the broker for reads outside the checkout and the guard's check of the path after resolving links, so a link in the checkout can't point a read elsewhere.                                                                                                                                                    | built. Claude Code's file-tool `Read(...)` deny rules leave out the session's own config directory and its ancestors (every account 10db creates has `<data>/accounts/<id>/claude`, so its config directory is under the data directory; only the seeded default account uses the login's config directory, `~/.claude` unless `CLAUDE_CONFIG_DIR` says otherwise), so the session's own saved tool results stay readable; the guard, the broker and the kernel still hold them. The config directory is computed once per session and shared by the guard and the file-access judge |
| R5  | **A lane can't reach 10db's controls.** The UI token, the database and the logs sit in the denied data directory, and no token is in any lane's environment. A session's MCP token already dies with the session (built).                                                                                                                                                                                                                                   | partly: the data directory is a protected read for Bash, the file tools and the gate, whose sandbox opens no home path but the toolchains. Repo stdio MCP servers get the same protected reads (§4.6). The daemon's git runs no hook, filter or submodule git (D13)                                                                                                                                                                                                                                                                                                                  |
| R6  | **Lane network goes through the sandbox's proxy.** The project's allowed domains open directly; every other host is a card or a refusal. Loopback is off unless the project turns it on. The gate gets the project's stored hosts and loopback, when on, and nothing else.                                                                                                                                                                                  | partly: lanes, the gate and repo stdio MCP servers. The gate's proxy allows only the project's stored hosts (`strictAllowlist`) and loopback only with the project's switch. A repo stdio MCP server reaches only the hosts its approval names (`strictAllowlist`) and never gets loopback (§4.6)                                                                                                                                                                                                                                                                                    |
| R7  | **Repo settings can't widen a lane.** Nothing from the repo's Claude Code settings reaches a lane: no hook, allow rule, `env` or sandbox block.                                                                                                                                                                                                                                                                                                             | built                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| R8  | **The daemon reads repo files only through the safe reader.** That means a regular file, under a size cap, with no link on any path component. Files it writes in its data directory never follow a link.                                                                                                                                                                                                                                                   | partly                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| R9  | **No git command the daemon runs executes code from the checkout outside the sandbox.** Lanes can't write `.git/config` or `.git/hooks`. Hooks run inside the sandbox or not at all. Config keys that name programs or rewrite URLs are turned off or refused. A push goes to the remote URL recorded when the batch started.                                                                                                                               | partly: the daemon's own git (D13). Its commits and change checks are plumbing that runs no hook, filter or submodule git; the checkout's git dirs and origin's URLs are pinned per project in the database, and a commit moves only its workstream's branch by compare and swap. Fetch and push go to the pinned URLs, never one with credentials in it; lanes never push, and the git dirs are read-only to them                                                                                                                                                                   |
| R10 | **The sandbox never replaces a card the project's policy asks for.** Hazard commands, such as a dependency change, and commands that could hide one still reach the builder. With `autoAllowBashIfSandboxed` on, no Bash call reaches `canUseTool` (spike 13 check 8), so the amendment settles how hazards get their cards.                                                                                                                                | built. Every lane runs in `default` permission mode, so hazards reach the broker                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| R11 | **Each lane and each gate run has its own temp directory**, and no profile can read or write another's.                                                                                                                                                                                                                                                                                                                                                     | built: lanes, the gate and repo stdio MCP servers. Each gate run, and each repo stdio MCP server in each session, gets its own temp dir, removed after it, and srt's shared `/tmp/claude` is closed to both                                                                                                                                                                                                                                                                                                                                                                          |
| R12 | **What leaves for GitHub is checked by the daemon.** It scans every batch for secrets with its own configuration before the push, and stops with a card when a batch changes CI workflows.                                                                                                                                                                                                                                                                  | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| R13 | **The builder's takeover terminal loads nothing from the lane's checkout settings.** A hook or allow rule a lane wrote never runs as the builder.                                                                                                                                                                                                                                                                                                           | no                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |

## 7. Known and accepted

- **Its own account.** A lane's claude process holds its own account's credential. A steered lane can spend
  its account's quota, up to the monthly cap on a metered account.
- **Its own checkout.** A lane reads and changes everything there except the project's secret files, including
  other lanes' uncommitted work. Lanes of one project share a checkout by decision 13 and trust each other. The
  boundary is between projects.
- **Secrets a project gives its lanes.** A value in a lane's environment, or a secret file the project
  excepted, can leave in a commit. The daemon's scan catches known formats only (R12).
- **Allowed hosts.** Approving a host approves sending anything there, not only fetching from it. The project's
  code can leave through any allowed host, such as a package registry. Choosing hosts is the builder's call.
- **Loopback, where a project turns it on.** A sandboxed command, a lane's or the gate's, can then connect to
  every port on localhost (a repo MCP server never can):
  dev servers, databases, Docker's API when it listens on TCP, a local proxy that bypasses network cards, and
  the daemon (locked by its token). Only unix sockets in the lane's own temp directory are allowed, so Docker's
  socket stays closed. Moving the daemon off loopback is a later hardening. The switch also lets a sandboxed
  command bind and accept on every interface, not only loopback: srt grants binding and inbound as
  `(local ip "*:*")`, since Seatbelt's only other host token, `localhost`, misses the IPv4-mapped address of a
  dual-stack socket, so srt can't limit them to loopback. A server it starts on `0.0.0.0` accepts connections
  from the network, subject to the macOS firewall.
- **Lane-to-lane text.** Handoffs, evidence, proposals and decisions reach later lanes. A steered lane can steer
  the next one, and the boundaries hold for both.
- **One macOS user.** The daemon, every claude process and the builder share a uid. An escape from the sandbox
  or from Claude Code's permission checks is a full compromise. Separate users per account stay out of scope
  (accounts spec §1).
- **The file tools' boundary is software.** The claude process is unsandboxed, so R4 rests on Claude Code's
  permission checks, the broker and the guard's resolved-path check, not on the kernel. A flaw in any of them
  is a flaw in R4. Wrapping the whole process would make it the kernel's, and lane sandbox spec D10 says when
  that is possible.
- **The guard's shell-text checks are a tripwire; the sandbox is the boundary.** A text-level guard can't be
  complete against bash and zsh. The kernel bounds what a lane's command reads and writes; these gaps stay open
  wherever lane-written code runs outside it:
  - shell indirection: `xargs`, `$(...)`, `$x`, `find -delete` and other `rm` binaries;
  - programs that run a string as shell: `watch`, `script`, `fish`, `ssh`, `su`, `flock`, `trap`, `tmux` and
    `screen`;
  - a script written to a file and then run, fifos, and `sqlite3`'s `.shell`;
  - same-command filesystem changes: `ln -s ~ h && cat h/.claude.json`, or `rm -rf dist && ln -s . dist &&
rm -rf dist/*`. The guard judges a command before it runs.
- **The guard refuses what it doesn't model.** Stepped and zero-padded brace sequences (`{1..5..2}`, `{01..10}`),
  brace bodies with an unmodelled `..`, and here-doc brace groups on any line that also uses process
  substitution, `exec` redirection or `coproc` are refused. A brace-heavy data here-doc may be refused too, and
  inside a `$(…)` it always is (`curl -d "$(cat <<'EOF' …)"`): a substitution's output may reach a shell the
  guard does not see, such as `watch` or a here-document a shell reads. The
  Glob allowlist refuses non-ASCII names (`src/café/*`) and `! # ( $ '` after a pattern's literal prefix.
  `rm -r` takes only plain paths or one wildcard in the last segment, so `**/node_modules`, `dist/**` and any
  `rm -r` with a redirection (`rm -rf build 2>/dev/null`) are refused, and the lane must name its paths.
- **One link check per call.** The guard's `PreToolUse` check of a file-tool path runs once, before the call. A
  live Bash loop can swap a link after it. The kernel profile and Claude Code's own link resolution still apply.
- **`mv` of `.git/objects`.** The guard doesn't judge `mv` or redirect paths. A lane can destroy `.git/objects`
  that way. It destroys data rather than escalating, and the gap predates the sandbox.
- **A registry token in another global npmrc under a system location stays readable.** System locations
  stay readable, and only the install prefixes', their direct children's and the `PATH` node's npmrc files
  are denied. A token put in the npmrc of a node prefix that is not on `PATH` and lies deeper than one level
  under an install prefix (a Homebrew keg's own `etc` under `Cellar/<formula>/<version>`) is readable to the
  lane. `npm login` writes `~/.npmrc`, which the home deny already covers.
- **File-tool searches can match inside a secret file.** Grep and Glob over a directory that holds a `.env*` file
  can match inside it: ripgrep's exclusion isn't modelled. `.env*` denial is not a boundary (lane sandbox spec
  D16).
- **pnpm 12 can't install in a lane.** Its store lock lives in a fixed directory shared with every lane and
  the builder's own pnpm (§4.4). Opening it would let one lane hold, replace or break the locks another lane or
  the builder relies on, so it stays closed until pnpm can be told where to lock. npm installs in a lane.
- **A commit's branch never comes from HEAD.** It is the batch's, or the one pinned in the database when the
  workstream's first session started, and `update-ref` moves only that ref, by compare and swap, without following
  a symbolic ref. A commit while HEAD is elsewhere is refused; HEAD moved during one (by the builder, since a lane
  can't write it) is reported on a card, and the commit stays on its branch.
- **The checkout pin persists.** When a project is registered, the daemon records its checkout's git dir and
  common dir (device and inode) and origin's URLs in the database, keyed by real path. A `.git` moved aside and
  replaced, or a changed origin, refuses every call with a card. The card holds the state it found; Trust the
  checkout as it is now pins exactly that state, and only if the checkout still matches it, otherwise 10db
  refuses again with a new card. Each found state gets its own card. Restarting the daemon re-trusts nothing.
  A git dir inside any registered checkout (other than this checkout's own `.git`) or in a lane temp root is refused
  with a card that offers nothing to trust, when it is offered for trust and when a checkout is first pinned. A
  dir at or under a registered checkout's own `.git` directory is exempt, as every lane profile of that
  checkout denies it (a linked worktree's common dir often lies there), and a re-trust checks only dirs that
  differ from the current pin, so a changed origin never leaves a checkout on a card that offers nothing. A
  commit or a branch switch reads the pin inside the checkout's lock, after any operation it waited on. A non-empty `objects/info/alternates` is refused too.
- **The builder's own config is trusted.** Signing follows the global `commit.gpgsign`, with the signing
  programs pinned from global config or git's defaults. Local config still sets identity, which names no program.
- **Files that need a filter are left to the builder.** The daemon commits bytes as they are, so it refuses a
  path whose attributes name a filter, and a batch in a repository that uses one (Git LFS). Files whose
  attributes ask for line-ending conversion are committed unconverted.
- **Sandboxed `git` prints two cache errors per call** when it is Apple's `/usr/bin/git`: its xcrun shim can't
  write its cache in the user's temp dir, and `xcrun_nocache` doesn't stop it (measured). That cache names the
  binary each shim runs, so it stays closed. Most tools ignore the errors; gitleaks takes any output from git
  on stderr as a failed scan and reports no leaks, so a lane or gate can't rely on gitleaks with that git.
  10db's gitleaks tests skip in a sandbox and run in CI; the daemon's own scan (D16) runs outside any sandbox.
- **WebKit can't run in a sandboxed gate.** Playwright's WebKit runs its page, network and GPU processes as XPC
  services that launchd starts outside the caller's sandbox, with their own network stack, and its UI process
  needs the window server, the GPU and Mach registrations srt can't grant (measured). Opening them would let
  lane-written pages and URLs drive processes outside any sandbox, around the proxy. So `scripts/gate.sh`
  reports e2e as skipped under `TENDB_SANDBOX=1`, and CI runs it on every pull request. Chromium is
  unmeasured.
- **A gate that needs Docker fails.** It never gets Docker's socket; its evidence says why.
- **What a repo MCP server is given, it can pass on.** Its approved variables are in its env and, for the
  session, in its sealed env file, which the next daemon start removes if the daemon crashed. It reads what lanes read, the checkout included, and its tool results reach
  the lane's model, so an approved token can leave through the model and a commit. Approving a variable approves
  that.
- **A repo MCP server that needs a host fails.** Its sandbox reaches no host until approvals can name hosts, so
  one that downloads its package when it starts (`npx -y`, `uvx`, `pnpm dlx`) fails to connect unless the repo
  installs the package. The approval card says so; the session's prompt names a server that failed to connect.
- **Fake sessions run the gate unsandboxed.** With `TENDB_FAKE_SCRIPTS` (development and e2e only, never a
  real lane) the daemon builds no sandbox, and its gates run `/bin/sh -c` with the project env. The scripted
  sessions write only what their scripts say, never lane code.
- **Tests that need what no sandbox gives skip in one.** A setuid `ps`, a short path under the shared `/tmp`
  (for the 44-byte lane temp dir), the builder's real home, Seatbelt itself, which can't nest, or gitleaks with
  Apple's git (above). 10db's tests mark these with `SANDBOXED` (`TENDB_SANDBOX=1`); CI and an unsandboxed
  `make gate` run them.
- **Tools that look above the checkout get `EPERM`, not "not found".** Most treat that as missing;
  browserslist doesn't, so a project that builds with Babel names its targets. The checkout's `.env*` files
  are denied, templates included, so a formatter that reads every file skips them.
- **The gate builds from scratch.** Its package caches, cargo's included, go with its temp dir, so each run
  downloads its crates and rebuilds them (§4.4).
- **Merged code.** Review is the boundary (§1).

## 8. Open checks

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | Decides                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Does a bare `Read` allow rule let a read outside the working directory run without a card?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | how exposed the UI token is today; not the design, which denies it                       |
| 2   | Can Claude Code's per-command Bash sandbox apply inside a claude process that `srt` already wraps, on macOS? The claude process needs its Keychain sign-in, and Seatbelt profiles pass to children.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | whether whole-process wrapping can keep the Keychain from Bash                           |
| 3   | Can a repo's `permissions.allow`, `sandbox.enabled` or `sandbox.filesystem.allowRead` widen a session started with `Options.sandbox`? **Closed for sandboxed sessions by lane sandbox spec D4:** `settingSources: []` loads no repo settings, so no repo key can widen them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | whether R7 must refuse those keys or stop loading repo settings                          |
| 4   | Does Claude Code's own safety check make an Edit of `.claude/settings.json`, `.git/config` or `.git/hooks/*` ask, even under an `Edit` allow rule?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | how many deny rules R4 needs                                                             |
| 5   | Does a narrower `allowRead` reopen a child of a denied `~/`, in `Options.sandbox` and in `srt`? Claude Code's docs say yes for its sandbox; nothing has measured either. Does the stronger form work: deny `/` and allow the system paths back? Does `permissions.blockReadsOutsideWorkingDirectories` add anything? Canaries go in home, a sibling repository, `/Users/Shared`, another lane's temp directory and a mounted volume. Whichever form holds, what must be allowed again for pnpm, mise, cargo, git and the gate to work? **Answered (spike 14 check 5):** yes, and deny `/` with the system paths allowed back works; node, pnpm, mise and git run under it. Built. A denied directory under an allowed ancestor is unmeasured; the live test's space-named canary covers one. | whether R3 can be built as designed, and its allow list                                  |
| 6   | Can the gate pass in a sandbox? The setuid `ps` tests and the e2e repository under the checkout fail today (spike 13 check 10). **Answered (decision 132):** yes, under srt, with those tests skipped in a sandbox and the e2e repository in the temp dir; WebKit's e2e can't run there (§7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | R2 for the gate                                                                          |
| 7   | Does `security dump-keychain` under the lane config list any login-keychain item? `grep -c` for the spike's canary settles it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | whether denying `/usr/bin/security` is needed or only tidy                               |
| 8   | Can a sandboxed command send data out through DNS lookups, with no allowed domain?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | whether R6 covers name resolution                                                        |
| 9   | Does a real `pnpm add <package>` reach `canUseTool` with auto-allow off? Spike 13 ran only `pnpm add --help`. Do `ask` rules and hooks that return `ask` reach it with the sandbox on? **Answered (spike 14 check 9):** yes, with auto-allow off a real `pnpm add` and `npm install` reach `canUseTool`, and an `ask` rule or a hook's `ask` also reaches it under auto-allow. An approved pnpm 12 install then fails on its store lock, which pnpm takes in `/private/tmp/pnpm-store-operation-locks-<uid>` whatever its settings say. That directory is shared, so it stays closed (§4.4, §7), and the pnpm hazard card says so.                                                                                                                                                           | R10's mechanism                                                                          |
| 10  | Can each lane's `Options.sandbox` get its own temp directory instead of the shared `/tmp/claude-<uid>`? (`srt` takes whatever 10db writes.) **Answered (spike 14 check 10):** yes, through `CLAUDE_CODE_TMPDIR`, if the path is 44 bytes or less. A longer path falls back to the shared directory without a word, so the daemon refuses to start such a session. Built.                                                                                                                                                                                                                                                                                                                                                                                                                     | R11 for lanes                                                                            |
| 11  | How does the SDK report a sandbox that `failIfUnavailable` stops: an init error, or a failure at the first Bash call? **Partly answered (spike 14 check 11):** a startup refusal arrives as a process exit whose stderr a card can quote. No setting made the sandbox unavailable on macOS, and an invalid sandbox value drops the sandbox without an error, so the daemon validates the profile and the live test proves it.                                                                                                                                                                                                                                                                                                                                                                | the card that says why a session didn't start                                            |
| 12  | Does a `Read(...)` deny rule match through a link inside the working directory? Do Grep and Glob follow links out of it? **Answered (spike 14 check 12):** yes, Claude Code resolves links before its rules apply, and Grep follows a link only as `path`. The guard's resolved-path check is the second layer. Built.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | whether the guard's resolved-path check is the only thing stopping a read through a link |
| 13  | Under `srt` itself, not `Options.sandbox`: are mach lookup, local binding and unix sockets configurable the same way? Can `git commit` write `.git/index` and refs while `.git/config` stays protected? Does a wrapped stdio MCP server keep its stdout clean? **Partly answered (decision 132):** the same fields, the same engine; the gate profile is the lane profile. No sandboxed process writes git state, since only the daemon commits. Answered for repo MCP servers (decision 133): srt adds nothing to a stdio server's stdout (measured).                                                                                                                                                                                                                                       | the gate profile, D6 and D7                                                              |
| 14  | Can a sandboxed program read the canary Keychain item through Security.framework directly (`SecItemCopyMatching` from a compiled or `ctypes` caller), not through `security`? Do Apple Events and `launchctl` stay refused with `allowAppleEvents: false`?                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | whether the Keychain deny holds beyond the `security` binary                             |
| 15  | Does the whole 10db gate pass under the `srt` gate profile, with D9's changes and D14's temp directory? **Answered (decision 132):** yes, with e2e skipped (§7).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | the exit criterion of the pre-plan spike                                                 |

## 9. The guard findings parked by accounts Task 7

Accounts Task 7 parked these findings for the re-scoped guard task. Each closes in one of two ways:

- **moot:** the kernel denies the read, whatever the shell text says;
- **fix:** policy correctness, because the guard and the permission matcher share one scanner.

| Finding                                                                                                                                                                                                           | Closes as                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd ~ \|\| cd /tmp && cat .claude.json` and the other conditional or piped `cd` shapes judged from the `cd` target alone                                                                                          | moot (R3)                                                                                                                                                                                                                                                                       |
| `cd` narrowing after a conditional or piped `cd`                                                                                                                                                                  | moot (R3)                                                                                                                                                                                                                                                                       |
| `${x:-a <<EOF}` opening a here-document bash never opens, hiding a `cd`                                                                                                                                           | Moot (R3) as a credential guard. The permission matcher already rejects these shapes, because `$` or `<` makes a segment non-literal; Task 7R keeps rows that prove it. Its fail-closed fix covers parses the scanner marks uncertain, such as an unclosed quote or a stray `)` |
| Here-document detection off for words that contain `$`, a backtick, `{` or `[`                                                                                                                                    | the same                                                                                                                                                                                                                                                                        |
| Here-strings attached to a word (`cat<<<…`)                                                                                                                                                                       | the same                                                                                                                                                                                                                                                                        |
| `${…}` split on `;`, `&&` and spaces                                                                                                                                                                              | the same                                                                                                                                                                                                                                                                        |
| `tar` long-option abbreviations misleading mode detection                                                                                                                                                         | moot (R3)                                                                                                                                                                                                                                                                       |
| An escaped space joins words, so `git\ status` matches a `git status` rule                                                                                                                                        | fix: a stored rule skips a card the builder would have seen. Inside the sandbox it is a policy bug, not a breach                                                                                                                                                                |
| Keychain commands (`security`)                                                                                                                                                                                    | moot once `~/Library/Keychains` and `/usr/bin/security` are denied (spike 13 check 4)                                                                                                                                                                                           |
| A Keychain command behind an escape (`s\ecurity …`)                                                                                                                                                               | moot (R3) once `~/Library/Keychains` and `/usr/bin/security` are denied                                                                                                                                                                                                         |
| Paths the guard can't read from the text: `H=~; cat $H/.claude.json`, `~/../$USER/…`, `$(echo ~)/…`                                                                                                               | moot (R3)                                                                                                                                                                                                                                                                       |
| Interpreter code that builds a protected path, such as `node -e` or `python3 -c` joining `$HOME`                                                                                                                  | moot (R3)                                                                                                                                                                                                                                                                       |
| The `$(` scanner ignores quotes, so a crafted `echo "$(echo '(')"; cd ~; …` hides a `cd`                                                                                                                          | moot (R3)                                                                                                                                                                                                                                                                       |
| `ditto` and `zip -r` walk a protected directory, as does a walker with no path after `cd ~`                                                                                                                       | moot (R3)                                                                                                                                                                                                                                                                       |
| zsh glob alternation names a protected path: `cat ~/.cl(aude.json\|)`                                                                                                                                             | moot (R3)                                                                                                                                                                                                                                                                       |
| `( cd ~ ) )` and other parentheses that don't pair                                                                                                                                                                | moot (R3)                                                                                                                                                                                                                                                                       |
| False denies: an unresolved `cd "$(git rev-parse --show-toplevel)"` refuses what follows with a misleading reason, `${!arr[@]}` loops are refused, and Bash readers of the session's own tool results are refused | moot (R3): the re-scoped guard drops the text rules behind them                                                                                                                                                                                                                 |
| Wrapper flags the guard reads loosely: abbreviated or unknown long options of `nice`, `timeout` and `stdbuf` (`--adj`, `--sig`, `--out`), `env` short flags outside its set, flag clusters                        | moot (R3). The guard refuses only `env` with a split string or an `env` long option not spelled in full; the permission matcher fails closed on every flag outside a wrapper's exact flags (decision 119)                                                                       |
