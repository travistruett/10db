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
  the only thing between a lane and an asset. Today none of the four boundaries holds:
  - a lane runs unsandboxed with the builder's login environment;
  - it can read the daemon's API token;
  - the daemon runs code a lane wrote with no sandbox.

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

| Layer                                                                                                                                                                                                                           | Holds against a steered agent | Covers                                                                                                                                                                                                                                       | Built                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| **Kernel sandbox**: Seatbelt, through the Agent SDK's `sandbox` option or `@anthropic-ai/sandbox-runtime`                                                                                                                       | yes                           | every process whose code a lane can choose: Bash and its children; the gate, the hooks of the daemon's git commands, repo MCP servers                                                                                                        | no                                                                      |
| **Permission rules and the resolved-path check**: Claude Code's `Read(...)` and `Edit(...)` deny rules, the broker's decision on reads outside the checkout, and the guard's check of each file-tool path after resolving links | yes, for the file tools       | Read, Grep, Glob, Edit, Write and NotebookEdit, which run inside the claude process where the kernel sandbox doesn't reach. A link the lane made in the checkout must not carry a read past the rules (§8 check 12)                          | no (on `feat/accounts` the guard resolves links for its own path rules) |
| **Daemon input handling**                                                                                                                                                                                                       | yes                           | every repo file the daemon reads, every git command it runs in the checkout, every file it writes in its data directory                                                                                                                      | partly: `.mcp.json` and `.claude/settings.json` (§5)                    |
| **Daemon tokens**                                                                                                                                                                                                               | yes                           | the HTTP API (the UI token) and the MCP endpoint (a token per session)                                                                                                                                                                       | the tokens are; keeping the UI token out of lanes' reach is not         |
| **Cards and allow rules** (the broker)                                                                                                                                                                                          | no, it is policy              | what runs without asking the builder: built-in allow rules, the project's allowed commands, stored rules; network hosts in the design; with auto mode on (`TENDB_LANE_PERMISSION_MODE=auto`), Claude Code's classifier, another policy layer | yes                                                                     |
| **The rest of the guard** (`PreToolUse`)                                                                                                                                                                                        | no, it is policy              | claims, commits only through `commit`, the delivery and `gh` rules, hazard claims, clear refusal reasons                                                                                                                                     | yes                                                                     |

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
  - it has no filesystem, shell or HTTP plugin;
  - its opener is limited to `https://github.com/*`.
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
  personas only. `strictMcpConfig` keeps user and global MCP servers out.
- **Hooks:** 10db's guard and billing re-checks are SDK callbacks inside the daemon, not processes (§4.5 covers
  repo hooks).
- **MCP:** 10db's server over HTTP with a token per session, and approved repo servers (§4.6).

Its file tools run inside this process:

| Tool                                 | Today                                                                                                                                                                                                                                                                             | Design                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read, Grep, Glob                     | Any path. Bare `Read`, `Grep` and `Glob` allow rules let them run without a card. Whether that holds outside the working directory is §8 check 1. On `feat/accounts` the guard refuses the data directory and `~/.claude*` by text.                                               | `Read(...)` deny rules matching the sandbox's read policy. Spike 13 check 6 showed that a Read rule stops the tool and also reaches the Bash sandbox. The broker decides reads outside the checkout on the real path. The guard resolves links first, so a link in the checkout can't carry a read past the rules (§8 check 12). |
| Edit, Write, MultiEdit, NotebookEdit | Inside the checkout, within the lane's claims; the guard resolves links. `.git/config`, `.git/hooks/*`, `lefthook.yml` and `Makefile` are writable when an area covers them. The stray watcher flags `.git/hooks`, `.git/config`, `.claude` and `.mcp.json` only after the write. | `Edit(...)` deny rules for `.git/` internals. Claims stay policy.                                                                                                                                                                                                                                                                |
| WebFetch, WebSearch                  | a card per call (no allow rule); in auto mode the classifier, not a card, decides most calls                                                                                                                                                                                      | the same; the sandbox's domain list doesn't limit them                                                                                                                                                                                                                                                                           |

### 4.4 A lane's Bash and its children

|         | Today                                                                                                  | Design                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Read    | everything the builder can                                                                             | Every user-data root is denied (`/Users`, `/Volumes`, the shared temp roots), then the checkout, the toolchains and caches and the lane's own temp directory are allowed again. The protected reads stay denied whatever the project lists: the data directory, every config directory, `~/.claude.json`, `~/Library/Keychains`, `/usr/bin/security` and the checkout's `.env*` files. Spike 13 checks 2–4 showed that `denyRead` holds against 25 read routes, including links, archives, interpreters and alternate path spellings. |
| Write   | everything the builder can                                                                             | Only the checkout and the lane's own temp directory. Inside the checkout, Claude Code protects `.git/hooks`, `.git/config`, the `.claude` settings files, `.claude/hooks` and `.mcp.json`.                                                                                                                                                                                                                                                                                                                                            |
| Env     | the login environment plus the account's secret                                                        | No credentials (R1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Network | anything                                                                                               | Through the sandbox's proxy. The project's allowed domains open directly; any other host raises a `SandboxNetworkAccess` request that the broker answers (spike 13 check 9). Loopback is reachable only in a project that turns it on (D15). Whether name lookups can carry data out is §8 check 8.                                                                                                                                                                                                                                   |
| Run     | anything; a card for what no rule allows (in auto mode the classifier, not a card, decides most calls) | The same, inside the sandbox. A setuid binary such as `ps` can't run (spike 13 check 10).                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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
  permission rules, or turn off a check (R7).

### 4.6 Repo MCP servers

- **Today:** a stdio server runs only after the builder approves its config, keyed by a hash of its command,
  args, env, URL and headers. It runs as a child of claude, outside every sandbox, with only `PATH`, `HOME` and
  its declared variables. Its tools go to cards.
- **The gap:** the hash doesn't cover the code the command runs. An approved `node scripts/mcp.js` runs whatever
  the lane last wrote to that file.
- **Design:** a stdio repo server runs inside the lane's kernel sandbox (R2).

### 4.7 The gate and the git hooks the daemon runs

- **Today, the gate:** `/bin/sh -c <gateCommand>` in the checkout, in its own process group. It gets the login
  environment:
  - on `main` that includes the API key in `api_key` billing mode;
  - `feat/accounts` drops account credentials but keeps `GH_TOKEN`, AWS keys and the SSH agent.
- **Today, the hooks:**
  - the daemon's `git add`, `commit` and `switch` run the checkout's hooks with the daemon's own environment.
    Here that is lefthook, which reads `lefthook.yml`;
  - its `git push` runs the pre-push hook (`make check`) with the login environment.
- **All of this is code a lane can write, run with no sandbox.** A lane that edits `lefthook.yml` and then calls
  `commit` runs code as the builder.
- **Design:** R2, R6 and R9:
  - all of it runs inside a kernel sandbox with the lane's read policy;
  - it gets no credentials, and only the network the project's tests need;
  - no git command the daemon runs takes an executable from the repo's config.

### 4.8 The daemon's network git and `gh`

- `gh` runs with the login environment, and its token is in the Keychain. Arguments are arrays and flags are
  fixed. Output is zod-parsed, and a PR URL must name the batch's repository.
- Push and fetch use `origin` from the checkout's `.git/config`, which a lane can write. A rewritten URL sends
  the batch branch, and the builder's credentials, wherever the lane chose. `core.sshCommand` and `insteadOf`
  come from the same file.
- **Design:** R9. The daemon pushes to the remote URL recorded when the batch started, and takes no program from
  the checkout's config.

### 4.9 GitHub

- **It receives** the batch branch (every lane commit), the PR title and the PR body.
- **It runs** Actions workflows on the pushed branch, including workflow files a lane changed. A branch in the
  same repository gets the repository's secrets.
  - 10db's repository keeps none at repository level.
  - `release-bot`'s secrets are limited to `main` by a deployment-branch policy.
  - The `release` environment that `release.yml` names doesn't exist yet. It needs the same policy before
    its signing secrets are added.
  - A project 10db works on must keep its CI secrets in environments limited to protected branches. That is
    the builder's setup; 10db can't enforce it.
- **In the design**, a batch that changes `.github/workflows/**` or `.github/actions/**` stops for a card before the
  push, and every batch is scanned for secrets first (R12).
- **The boundary** for what reaches `main` is pull request review and the builder's merge.

## 5. What the daemon reads, runs or sends for a lane

| Surface                                                                                                            | Worst outcome today                                                                                                                                                                                                                                                           | Protection today                                                                             | Design        |
| ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- | ------------- |
| The data directory: `ui-token`, `daemon.json`, `10db.sqlite`, `logs/`, `delivery/`                                 | **A lane reads `ui-token` and calls the API:** it answers its own cards, sets a gate command (unsandboxed code), or approves its own MCP server. **A link planted at `delivery/<batch>-pr-body.md` or a gate log path** makes the daemon overwrite a file the link points to. | `feat/accounts`: the guard's text rules                                                      | R3, R5, R8    |
| `.github/pull_request_template.md` (`delivery/pr-template.ts`)                                                     | Links are followed, with no size cap and no check for a regular file. A lane commits the template as a link to a credential file, and its text goes into the PR body on GitHub. A FIFO blocks the daemon.                                                                     | none                                                                                         | R8            |
| `.mcp.json`, `.claude/settings.json` (`sessions/repo-config-file.ts`)                                              | `O_NOFOLLOW` covers the last path component only, so a linked `.claude/` directory is followed. The text is only parsed, never forwarded.                                                                                                                                     | regular file, 256 KiB cap, no link on the last component, zod                                | R8            |
| `git add` and `git commit` through the MCP `commit` tool; `git switch` when a batch starts                         | The checkout's hooks run: lefthook, from a lane-editable `lefthook.yml`, as the builder.                                                                                                                                                                                      | none                                                                                         | R2, R9        |
| Git config keys that name programs: `core.hooksPath`, `core.fsmonitor`, `core.sshCommand`, filter and diff drivers | The daemon's git calls run them. Only `git status` turns `core.fsmonitor` off.                                                                                                                                                                                                | the guard refuses the lane's own `git config` and `git -c`, but not an Edit of `.git/config` | R9            |
| `git push` (`git/git.ts`)                                                                                          | The pre-push hook runs `make check` with the login environment, and the push goes to whatever URL `.git/config` names.                                                                                                                                                        | never forced; fixed refspec; prompts off                                                     | R2, R9        |
| The gate (`verify/gate-runner.ts`)                                                                                 | Lane-written tests and Makefile targets run with the login environment.                                                                                                                                                                                                       | own process group, timeout                                                                   | R1, R2        |
| MCP tool inputs (`mcp/tools.ts`)                                                                                   | All are zod-parsed. Only `commit` names paths, and they are checked as writes within claims, links resolved. No tool makes the daemon read a path.                                                                                                                            | as described                                                                                 | as is         |
| Text a lane writes: handoffs, evidence, proposals, decisions                                                       | It reaches later lanes' prompts and the builder's screen. An accepted proposal's text becomes a task, and then a PR body.                                                                                                                                                     | rendered as data; a builder's accept                                                         | accepted (§7) |
| The PR body (`delivery/pr-text.ts`)                                                                                | It is built from records, never from logs or diffs; the template row above is the exception.                                                                                                                                                                                  | as described                                                                                 | R8            |

## 6. Requirements

These are the properties the design must have. The spec amendment chooses the mechanisms, and the re-scoped
guard task tests each one.

| #   | Requirement                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Built  |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| R1  | **No credential reaches a process a lane can make run.** That covers Bash and its children, the gate, the hooks of the daemon's git commands and repo MCP servers. None gets an account's secret or a login-shell credential (`GH_TOKEN`, AWS keys, the SSH agent, registry tokens). A lane's claude process holds its own account's credential and no other.                                                                                               | no     |
| R2  | **Every process whose code a lane can choose runs inside a kernel sandbox that denies the protected reads.** That covers Bash and its children, the gate, the hooks of the daemon's git commands and stdio repo MCP servers. A repo hook in settings is refused (R7).                                                                                                                                                                                       | no     |
| R3  | **The sandbox reads only what the project needs.** Every user-data root is denied (`/Users`, `/Volumes`, the shared temp roots), then the checkout, the toolchains, the caches and the lane's own temp directory are allowed again. The protected reads are always denied, including the checkout's `.env*` files unless the project names an exception. A deny list can't name every secret on a machine; an allow list can protect secrets nobody listed. | no     |
| R4  | **The file tools follow the same read policy**, and never write `.git/` internals. Claude Code's permission deny rules enforce it, along with the broker for reads outside the checkout and the guard's check of the path after resolving links, so a link in the checkout can't point a read elsewhere.                                                                                                                                                    | no     |
| R5  | **A lane can't reach 10db's controls.** The UI token, the database and the logs sit in the denied data directory, and no token is in any lane's environment. A session's MCP token already dies with the session (built).                                                                                                                                                                                                                                   | no     |
| R6  | **Lane network goes through the sandbox's proxy.** The project's allowed domains open directly; every other host is a card or a refusal. Loopback is off unless the project turns it on. The gate gets loopback, when on, and nothing else.                                                                                                                                                                                                                 | no     |
| R7  | **Repo settings can't widen a lane.** Nothing from the repo's Claude Code settings reaches a lane: no hook, allow rule, `env` or sandbox block.                                                                                                                                                                                                                                                                                                             | no     |
| R8  | **The daemon reads repo files only through the safe reader.** That means a regular file, under a size cap, with no link on any path component. Files it writes in its data directory never follow a link.                                                                                                                                                                                                                                                   | partly |
| R9  | **No git command the daemon runs executes code from the checkout outside the sandbox.** Lanes can't write `.git/config` or `.git/hooks`. Hooks run inside the sandbox or not at all. Config keys that name programs or rewrite URLs are turned off or refused. A push goes to the remote URL recorded when the batch started.                                                                                                                               | no     |
| R10 | **The sandbox never replaces a card the project's policy asks for.** Hazard commands, such as a dependency change, still reach the builder. With `autoAllowBashIfSandboxed` on, no Bash call reaches `canUseTool` (spike 13 check 8), so the amendment settles how hazards get their cards.                                                                                                                                                                 | no     |
| R11 | **Each lane and each gate run has its own temp directory**, and no profile can read or write another's.                                                                                                                                                                                                                                                                                                                                                     | no     |
| R12 | **What leaves for GitHub is checked by the daemon.** It scans every batch for secrets with its own configuration before the push, and stops with a card when a batch changes CI workflows.                                                                                                                                                                                                                                                                  | no     |
| R13 | **The builder's takeover terminal loads nothing from the lane's checkout settings.** A hook or allow rule a lane wrote never runs as the builder.                                                                                                                                                                                                                                                                                                           | no     |

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
- **Loopback, where a project turns it on.** A sandboxed command can then connect to every port on localhost:
  dev servers, databases, Docker's API when it listens on TCP, a local proxy that bypasses network cards, and
  the daemon (locked by its token). Only unix sockets in the lane's own temp directory are allowed, so Docker's
  socket stays closed. Moving the daemon off loopback is a later hardening.
- **Lane-to-lane text.** Handoffs, evidence, proposals and decisions reach later lanes. A steered lane can steer
  the next one, and the boundaries hold for both.
- **One macOS user.** The daemon, every claude process and the builder share a uid. An escape from the sandbox
  or from Claude Code's permission checks is a full compromise. Separate users per account stay out of scope
  (accounts spec §1).
- **The file tools' boundary is software.** The claude process is unsandboxed, so R4 rests on Claude Code's
  permission checks, the broker and the guard's resolved-path check, not on the kernel. A flaw in any of them
  is a flaw in R4. Wrapping the whole process would make it the kernel's, and lane sandbox spec D10 says when
  that is possible.
- **Auto mode.** With auto mode on, a classifier-approved WebFetch can send data to any URL, and the classifier
  is not a boundary. The guard's refusals still apply first. A call Claude Code marks as needing a person becomes
  a card; an older `claude` that doesn't mark it lets a stored rule answer it.
- **Merged code.** Review is the boundary (§1).

## 8. Open checks

| #   | Question                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | Decides                                                                                  |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------- |
| 1   | Does a bare `Read` allow rule let a read outside the working directory run without a card?                                                                                                                                                                                                                                                                                                                                                                                                                                             | how exposed the UI token is today; not the design, which denies it                       |
| 2   | Can Claude Code's per-command Bash sandbox apply inside a claude process that `srt` already wraps, on macOS? The claude process needs its Keychain sign-in, and Seatbelt profiles pass to children.                                                                                                                                                                                                                                                                                                                                    | whether whole-process wrapping can keep the Keychain from Bash                           |
| 3   | Can a repo's `permissions.allow`, `sandbox.enabled` or `sandbox.filesystem.allowRead` widen a session started with `Options.sandbox`?                                                                                                                                                                                                                                                                                                                                                                                                  | whether R7 must refuse those keys or stop loading repo settings                          |
| 4   | Does Claude Code's own safety check make an Edit of `.claude/settings.json`, `.git/config` or `.git/hooks/*` ask, even under an `Edit` allow rule?                                                                                                                                                                                                                                                                                                                                                                                     | how many deny rules R4 needs                                                             |
| 5   | Does a narrower `allowRead` reopen a child of a denied `~/`, in `Options.sandbox` and in `srt`? Claude Code's docs say yes for its sandbox; nothing has measured either. Does the stronger form work: deny `/` and allow the system paths back? Does `permissions.blockReadsOutsideWorkingDirectories` add anything? Canaries go in home, a sibling repository, `/Users/Shared`, another lane's temp directory and a mounted volume. Whichever form holds, what must be allowed again for pnpm, mise, cargo, git and the gate to work? | whether R3 can be built as designed, and its allow list                                  |
| 6   | Can the gate pass in a sandbox? The setuid `ps` tests and the e2e repository under the checkout fail today (spike 13 check 10).                                                                                                                                                                                                                                                                                                                                                                                                        | R2 for the gate                                                                          |
| 7   | Does `security dump-keychain` under the lane config list any login-keychain item? `grep -c` for the spike's canary settles it.                                                                                                                                                                                                                                                                                                                                                                                                         | whether denying `/usr/bin/security` is needed or only tidy                               |
| 8   | Can a sandboxed command send data out through DNS lookups, with no allowed domain?                                                                                                                                                                                                                                                                                                                                                                                                                                                     | whether R6 covers name resolution                                                        |
| 9   | Does a real `pnpm add <package>` reach `canUseTool` with auto-allow off? Spike 13 ran only `pnpm add --help`. Do `ask` rules and hooks that return `ask` reach it with the sandbox on?                                                                                                                                                                                                                                                                                                                                                 | R10's mechanism                                                                          |
| 10  | Can each lane's `Options.sandbox` get its own temp directory instead of the shared `/tmp/claude-<uid>`? (`srt` takes whatever 10db writes.)                                                                                                                                                                                                                                                                                                                                                                                            | R11 for lanes                                                                            |
| 11  | How does the SDK report a sandbox that `failIfUnavailable` stops: an init error, or a failure at the first Bash call?                                                                                                                                                                                                                                                                                                                                                                                                                  | the card that says why a session didn't start                                            |
| 12  | Does a `Read(...)` deny rule match through a link inside the working directory? Do Grep and Glob follow links out of it?                                                                                                                                                                                                                                                                                                                                                                                                               | whether the guard's resolved-path check is the only thing stopping a read through a link |
| 13  | Under `srt` itself, not `Options.sandbox`: are mach lookup, local binding and unix sockets configurable the same way? Can `git commit` write `.git/index` and refs while `.git/config` stays protected? Does a wrapped stdio MCP server keep its stdout clean?                                                                                                                                                                                                                                                                         | the gate profile, D6 and D7                                                              |
| 14  | Can a sandboxed program read the canary Keychain item through Security.framework directly (`SecItemCopyMatching` from a compiled or `ctypes` caller), not through `security`? Do Apple Events and `launchctl` stay refused with `allowAppleEvents: false`?                                                                                                                                                                                                                                                                             | whether the Keychain deny holds beyond the `security` binary                             |
| 15  | Does the whole 10db gate pass under the `srt` gate profile, with D9's changes and D14's temp directory?                                                                                                                                                                                                                                                                                                                                                                                                                                | the exit criterion of the pre-plan spike                                                 |

## 9. The guard findings parked by accounts Task 7

Accounts Task 7 parked these findings for the re-scoped guard task. Each closes in one of two ways:

- **moot:** the kernel denies the read, whatever the shell text says;
- **fix:** policy correctness, because the guard and the permission matcher share one scanner.

| Finding                                                                                                                  | Closes as                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `cd ~ \|\| cd /tmp && cat .claude.json` and the other conditional or piped `cd` shapes judged from the `cd` target alone | moot (R3)                                                                                                                                                                                                                                                                       |
| `cd` narrowing after a conditional or piped `cd`                                                                         | moot (R3)                                                                                                                                                                                                                                                                       |
| `${x:-a <<EOF}` opening a here-document bash never opens, hiding a `cd`                                                  | Moot (R3) as a credential guard. The permission matcher already rejects these shapes, because `$` or `<` makes a segment non-literal; Task 7R keeps rows that prove it. Its fail-closed fix covers parses the scanner marks uncertain, such as an unclosed quote or a stray `)` |
| Here-document detection off for words that contain `$`, a backtick, `{` or `[`                                           | the same                                                                                                                                                                                                                                                                        |
| Here-strings attached to a word (`cat<<<…`)                                                                              | the same                                                                                                                                                                                                                                                                        |
| `${…}` split on `;`, `&&` and spaces                                                                                     | the same                                                                                                                                                                                                                                                                        |
| `tar` long-option abbreviations misleading mode detection                                                                | moot (R3)                                                                                                                                                                                                                                                                       |
| An escaped space joins words, so `git\ status` matches a `git status` rule                                               | fix: a stored rule skips a card the builder would have seen. Inside the sandbox it is a policy bug, not a breach                                                                                                                                                                |
| Keychain commands (`security`)                                                                                           | moot once `~/Library/Keychains` and `/usr/bin/security` are denied (spike 13 check 4)                                                                                                                                                                                           |
