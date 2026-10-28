# 10db lane sandbox: the kernel boundary for lanes

**Status:** the builder chose the open choices on 2026-10-25 (D2–D5, D15–D17). Reviewed by a plan review and by
outside reads from Gemini and ChatGPT, whose findings are folded in.
**Built:** slice 1 (§7). It is always on: every real lane runs under the sandbox, with no switch. The gate runs
under `srt` with the same profile (D6, D9, D14, decision 132). Every other decision is **designed**.
**Threat model:** `docs/architecture/03-trust-boundaries.md`. This spec meets its requirements R1–R10 and its
§8 open checks name what is still unverified.
**Research:** `docs/architecture/research/spike-13-sandbox.md`.
**Amends:**

- the factory-loop spec: §3 (setting sources and the environment), §7 (which tool calls become cards) and §8
  (the guard);
- the accounts spec: §1, §3 "Practical isolation" and §8;
- the batch delivery spec: §6 (the push).

## 1. Intent

The guard was meant to keep lanes away from credentials by parsing shell text. Each of four fix rounds closed
its findings and opened new bypasses (accounts plan Task 7). Meanwhile the daemon runs code a lane wrote, with
no sandbox at all: the gate, the git hooks on its commits and the pre-push hook. Every agent harness that takes
a position on this puts the hard boundary in an OS sandbox:

- OpenCode's permissions are a "UX feature ... not designed to provide security isolation";
- Codex sends commands to Seatbelt or bubblewrap;
- Pi uses containers;
- Claude Code's docs say Bash rules are "not a security boundary".

**Success means:**

1. A steered lane can't read any credential except the one its own claude process was started with. It can't
   read the builder's other secrets or another project's checkout either (R1, R3, R4).
2. Nothing a lane can write runs outside a kernel sandbox: its Bash commands, the gate, the hooks of the
   daemon's git commands and repo MCP servers (R2, R9).
3. A lane can't reach 10db's controls: the UI token, the database and other sessions' tokens (R5).
4. A lane's network goes through the sandbox's proxy. An unlisted host is a card (R6).
5. Fewer cards than today. Commands run inside the sandbox without a card, except hazard commands, new network
   hosts, MCP tools and the web tools (R10).
6. The daemon reads repo files as untrusted input (R8).

**Out of scope:**

- separate macOS users per account, containers and virtual machines;
- wrapping the whole claude process in a sandbox (D10);
- Claude Code's auto mode (its permission classifier): lanes never use it, and every lane runs in `default`
  permission mode so hazards and new hosts reach the broker;
- a worktree per task (factory decision 13 stands: one shared checkout per project);
- platforms other than macOS.

## 2. Terms

- **Lane profile:** the sandbox settings 10db builds for one project's lanes, from D2 and the project's own
  additions. A lane's Bash runs under it through the Agent SDK's `sandbox` option.
- **Gate profile:** the lane profile without the account's variables, plus the additions the project's tests
  need (loopback, file events, unix sockets under the temp directory). The gate, the hooks of the daemon's git
  commands and repo MCP servers run under it through `@anthropic-ai/sandbox-runtime` (`srt`). It allows no
  other network, except a repo MCP server's own hosts (D7). The test process sees `TENDB_SANDBOX=1`, so a
  test that can't run in the sandbox can skip (D9).
- 10db derives both profiles from one source: the protected reads, the read list and the project's
  additions. The lane profile is an `Options.sandbox` object and the gate profile an `srt` config. The two
  spell paths differently (spike 13 check 6), so neither is written by hand.
- **Protected reads:** 10db's data directory, every account's config directory (the default account's,
  including the login shell's `CLAUDE_CONFIG_DIR`), `~/.claude`, `~/.claude.json`, `~/Library/Keychains` and
  `/usr/bin/security`, and in the checkout the project's secret files (`.env*` and names the project lists, less
  the exceptions it names). Every profile denies them, whatever a project adds. Denying `/usr/bin/security`
  doesn't stop it running under srt (the gate); the barrier is the denied `~/Library/Keychains`.

## 3. Decisions

These get numbers when they are recorded in `docs/architecture/decisions.md`.

| #   | Decision | Why |
| --- | -------- | --- |
| D1  | **The kernel sandbox is the lane boundary.** A lane's Bash runs under Claude Code's sandbox (`Options.sandbox`, Seatbelt) with `enabled`, `failIfUnavailable: true`, `allowUnsandboxedCommands: false` and `allowAppleEvents: false`. A session whose sandbox can't start doesn't start, and its card says why (how the SDK reports that is threat model §8 check 11). **The profile is validated and proven live.** An invalid sandbox value drops the whole sandbox without an error, and `failIfUnavailable` doesn't stop it (spike 14 check 11). So 10db builds the profile from paths, host names and variable names only, checks it against a strict schema before the session starts, and a live test (`TENDB_LIVE_CLAUDE=1`) runs the exact profile it builds and asserts that canaries in `denyRead` stay unreadable. The guard and the cards are policy (threat model §3), except the guard's resolved-path check on the file tools (D8). | Spike 13: the sandbox engages through the SDK (check 1), and `denyRead` holds against 25 read routes (checks 2–4). With `allowUnsandboxedCommands: false`, Claude Code ignores a request to run a command outside the sandbox. |
| D2  | **Read policy: deny user data, allow what the project needs.** The lane profile denies every root that holds user data: `/Users` (home, other users and `/Users/Shared`), `/Volumes`, and the shared temp roots outside the lane's own temp directory (D14). It allows again the checkout, the toolchain and cache directories 10db knows (mise, pnpm, cargo and rustup, Node's and git's caches) and paths the project lists. Protected reads stay denied whatever is listed. Writes go only to the checkout and the temp directory. | **The builder's choice.** A deny list can't name every secret on a machine (`~/.ssh`, `~/.aws`, other clients' repos, token files), but an allow list protects secrets nobody listed. The cost: a tool that reads an unlisted path fails until the path is added to the project. Claude Code's sandbox docs say a narrower `allowRead` reopens part of a denied `~/`. Nobody has measured it, and `srt` is unverified (threat model §8 check 5). If it fails, D2 can't be built as written. Denying only `~/` would leave `/Users/Shared`, other users' files, mounted volumes and shared temp readable (ChatGPT's review). The spike also tries the stronger form, deny `/` and allow the system paths back, and the plan uses the strongest form that runs. **Built:** spike 14 check 5 showed the strongest form runs, so the profile denies `/` and allows back the system locations (`/tmp`, `/var` and `/etc` reopen only the links), the checkout, the toolchain reads and the lane's temp directory, which holds its package caches. |
| D3  | **Cards, once Bash is sandboxed.** `autoAllowBashIfSandboxed` stays off. Every Bash call that Claude Code doesn't treat as read-only still reaches `canUseTool`. The broker allows it without a card unless it is a hazard: a project hazard command, or a dependency change. It tells the two apart with the guard's own hazard rules. The guard, in `PreToolUse`, still refuses a hazard command whose claim the lane doesn't hold, and anything else it refuses today. A command Claude Code treats as read-only changes nothing and needs no card. **New hosts:** a `SandboxNetworkAccess` request for an unlisted host is denied at once, because the command would time out long before anyone answered. A card then records the host with two choices: allow once, or always for the project, which adds it to the allowed domains. The denial tells the lane to retry after the answer. MCP tools, WebFetch and WebSearch keep their cards. | **The builder's choice:** hazards and new hosts only. The broker decides on what reaches it, so nothing relies on a hook returning `ask`. Spike 13 check 8: with auto-allow on, no Bash call reaches `canUseTool`; with it off, a non-read-only command does. Check 9: unlisted hosts arrive as `SandboxNetworkAccess`. That a real `pnpm add <package>` reaches `canUseTool` is threat model §8 check 9, since only `--help` was measured. A missed hazard is a policy miss inside the sandbox, not a breach. |
| D4  | **Lanes load no settings from the repo.** `settingSources` becomes `[]`. Repo hooks, allow rules, `env` and sandbox blocks never reach a lane, and repo skills, agents and commands under `.claude/` no longer load in lanes. A lane gets what it needs from 10db's project settings: allowed commands, read paths, allowed domains, extra environment names and the sandbox additions. The briefing tells the lane to read the repo's agent instructions (`AGENTS.md`, or `CLAUDE.md` where a repo uses it). The billing check on the repo's settings file goes, since nothing loads it. | **The builder's choice.** A lane can edit `.claude/settings.json`, so loading it lets one session give the next a hook that runs outside every sandbox, or allow rules that skip cards. Refusing only some keys would be another deny list. The 10db repo's own settings carry hooks meant for the builder's sessions. |
| D5  | **Lanes and the gate get an allow-listed environment.** It is built from the login environment, keeping only: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG` and `LC_*`, `TZ`, `TMPDIR`, and named toolchain variables (mise's, `PNPM_HOME`, `CARGO_HOME`, `RUSTUP_HOME`, `JAVA_HOME` and the like). `PATH` loses every relative entry and every entry inside the checkout. Variables the project lists are added, then the account's own variables (lanes only). Bash children get no account variable: the lane profile lists each name in `sandbox.credentials.envVars` with `mode: deny`, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is set. | **The builder's choice.** Today the whole login environment reaches every lane and the gate, including `GH_TOKEN`, AWS keys and the SSH agent socket. Stripping by name misses a secret with an unexpected name, and spike 13 check 5 shows the scrub alone leaves GitHub tokens and unrecognised names. A deny by exact name is the only way to keep the account's own secret from Bash while the claude process keeps it. |
| D6  | **Lane-written code that the daemon runs runs inside the gate profile.** That covers the gate (on a lane's green run and at ship), and the daemon's `git commit` and `git switch`, which run the checkout's hooks. They run under `srt` with the gate profile's environment and no credentials. The push runs no repo hook (`--no-verify`), because the gate ran in the sandbox just before (batch delivery decision 82). It goes to the remote URL recorded when the batch started. | The gate, lefthook and `make check` are files a lane can edit. Running them outside a sandbox would undo D1 (threat model §4.7). Spike 13 check 10 lists what the 10db gate needs (loopback, `com.apple.FSEvents`, unix sockets under the temp directory) and what can't run there (D9). |
| D7  | **Repo MCP servers run under `srt`.** An approved stdio server from `.mcp.json` runs under the gate profile. It gets only `PATH`, `HOME` and its approved variables (as today), and its network is the project's allowed domains plus the hosts its approval card names. | The approval hashes the server's command and arguments, not the code they run: an approved `node scripts/mcp.js` runs whatever the lane last wrote there (threat model §4.6). |
| D8  | **The file tools follow D2 through the broker and deny rules.** Read, Grep and Glob are allowed without a card only inside the checkout (path-scoped allow rules, never a bare `Read`). Outside it they reach `canUseTool`, and the broker decides on the resolved real path. It allows the session's own saved tool results and the read list, refuses protected reads with no card, and asks with a card for anything else (always for the project adds the path to the read list). `Read(...)` deny rules for the protected reads back the broker up inside Claude Code. **Links:** Claude Code's own deny rules apply first, and the guard's `PreToolUse` check resolves every file-tool path through links for the calls that reach it. A path inside the checkout whose real path is a protected read is refused, and one whose real path is elsewhere outside the checkout goes to the broker as above. That check is part of the file-tool boundary, not policy. It compares paths as the volume does: case-insensitively and Unicode-normalized on APFS's default case-insensitive volumes. It covers Grep's and Glob's `path` and Glob's pattern, and NotebookEdit falls under the Edit rules. Edit and Write never touch `.git/` internals, judged on the resolved path the same way. A file-tool write to any other path Claude Code protects from sandboxed Bash raises a card: the `.claude` settings files and its hooks, skills, agents and commands directories, `.mcp.json`, `.vscode`, `.idea`, shell startup files and `.gitconfig`. | Permission deny rules always beat allow rules, so "deny home, allow named" can't be written as rules alone. The broker can decide it on a real path, which isn't shell parsing. Spike 13 check 6 showed a Read deny rule stops the Read tool and also reaches the Bash sandbox, but only on a direct path. A lane's sandboxed Bash can create `x -> ~/.claude.json` in the checkout, because making a link reads nothing. The Read tool runs outside the sandbox, and it would then read `x` under the checkout's allow rule unless something resolves the link (threat model §8 check 12). Claude Code protects `.git/config` and `.git/hooks` from sandboxed Bash, but not from the Edit tool. |
| D9  | **Each project's gate must pass under its gate profile.** For the 10db repo, two changes. Tests that need a setuid binary (`ps`) skip when `TENDB_SANDBOX=1` is set, and still run in CI. The e2e fixture repository moves under the temp directory. A project's sandbox additions are project settings with a Settings form. | Spike 13 check 10: exec of a setuid binary fails in the sandbox, and git can't create a repository under the working directory. CI runs outside 10db, so CI still covers those tests. |
| D10 | **Whole-process wrapping waits, and the file tools' boundary is software.** The claude process stays outside the kernel sandbox, bounded by its permission rules, the broker and the guard's resolved-path check. That is a weaker guarantee than the kernel's, and the threat model says so (§7). It is revisited per account kind. A keyed account's claude needs no Keychain, because its secret arrives in the environment, so it can be wrapped whole once the scrub and deny rules are shown to keep that secret from its children. A subscription can be wrapped whole only if threat model §8 check 2 shows Claude Code's Bash sandbox nests inside an `srt`-wrapped claude. | The claude process reads its own sign-in from the Keychain, and Seatbelt profiles pass to children. Wrapping the whole process without a working inner sandbox would give Bash the Keychain access that D2 denies. Handing claude a brokered token instead would mean 10db reads and passes on the subscription's login, which accounts spec §3 rules out. |
| D11 | **The daemon treats the checkout as untrusted.** Every repo file it reads goes through the safe reader: a regular file under a size cap, with no link on any path component. That includes the PR template. The reader opens the file without following a final link and without blocking. It then confirms the descriptor is the file the path names: the path's real path must equal the path itself (so no component is a link), its device and inode must match the descriptor's, and it must have exactly one link. A component swapped between the check and the read fails the comparison. Files it writes in its data directory never follow a link. The data directory is created with mode 0700. | Threat model §5: the PR template follows links today, so a lane can commit it as a link to a credential file and publish the file's text in a PR body. |
| D12 | **The guard keeps its policy jobs and drops its credential parsing.** Once D1, D2 and D5 are built, the guard's shell-text credential rules go: Keychain commands, environment dumps, secret-variable references and protected paths in shell text. What stays: claims, commits only through `commit`, the delivery and `gh` rules, hazard routing, read-only steps, and the structured path checks on the file tools. Its scanner fails closed for the permission matcher: an uncertain parse matches no stored rule. | Threat model §3 and §9. Text rules that can't hold keep producing false denies and new findings. Until the sandbox ships they stay as interim policy, since they are still better than nothing on `main`. |
| D13 | **The daemon's git takes no program or redirect from the checkout's config.**<br>• Lanes can't write `.git/config` or `.git/hooks`. The kernel protects both from sandboxed Bash, and D8 protects them from the file tools.<br>• Every git call the daemon makes in the checkout outside `srt` passes `-c core.fsmonitor=false` and `-c core.hooksPath=` pointed at an empty directory. `gh` gets the same through `GIT_CONFIG_COUNT`, `GIT_CONFIG_KEY_<n>` and `GIT_CONFIG_VALUE_<n>`, so the git it runs inherits them.<br>• Before a fetch or a push, the daemon reads the checkout's local config. It refuses with a card when any key rewrites a URL or names a program: `url.*.insteadOf`, `url.*.pushInsteadOf`, `core.sshCommand`, `credential.*`, `include.*`, `includeIf.*`, `filter.*`, `diff.*.textconv` or `diff.*.command`, `remote.*.receivepack` or `remote.*.uploadpack`. | R9. A pinned URL doesn't defeat `insteadOf`, which rewrites explicit URLs too, and `add`, `status` and `diff` run fsmonitor and filters outside any sandbox. Any command that writes the index, `add` and `status` included, runs the `post-index-change` hook. Making the file unwritable is the boundary. The key check catches a config written before that, or by the builder, and is structured: git's own key names, not shell text. |
| D14 | **Each lane and each gate run gets its own temp directory.** It is created for that session or run and removed when it ends. `TMPDIR` points there, and the profile allows writes and unix sockets only there, never in the temp roots other lanes use. The e2e fixture repository and any test repositories live inside it. | Both outside reviews: one shared `/tmp/claude-<uid>` lets one project read another's temp files, plant fixtures or hooks in its test repositories, and take over its sockets. For `srt`, 10db writes the config, so this is in its hands. For `Options.sandbox` it depends on whether Claude Code honours a per-session temp directory (threat model §8 check 10). **Built for lanes:** Claude Code honours `CLAUDE_CODE_TMPDIR`, but only for a path of 44 bytes or less; a longer path falls back to the shared `/tmp/claude-<uid>` without a word. So each lane's directory is made under `/private/tmp` with a short name, and the daemon refuses to start a session whose real path is over 44 bytes (spike 14 check 10). The gate's directory is **designed**. |
| D15 | **Loopback is a per-project addition, off by default.** A project turns on local listening and connecting in Settings, under a warning that it opens every localhost port to its lanes and its gate. 10db's own project turns it on, because its server tests bind 127.0.0.1. | **The builder's choice.** On macOS, `allowLocalBinding` lets a sandboxed command connect to every local port: databases, dev servers, Docker's TCP API, a local proxy that would bypass network cards, and the daemon (whose token still holds). Moving the daemon to a unix socket in the data directory would take it off loopback. That needs the desktop's HTTP transport to change, so it is a later hardening. |
| D16 | **The daemon scans every batch before it pushes.** It runs `gitleaks` with 10db's own pinned configuration, never the repo's, over the batch's commits. A finding stops shipping with a card that names the file and rule but never the secret. The system check warns when `gitleaks` is missing. | **The builder's choice.** A lane can read any secret a project hands it, commit it, and the daemon would push it. Denying `.env*` (D2) removes the common source. The scan catches known formats, and GitHub's push protection, on where enabled, is a second net. Neither is a boundary, and the threat model says so. |
| D17 | **A batch that changes CI stops for a card at ship.** When its diff touches `.github/workflows/**` or `.github/actions/**`, shipping stops before the push with a card showing those changes. It pushes only after the builder approves. | **The builder's choice.** A pushed branch runs its own workflow files on GitHub before review. A workflow can ask for a write token, and on a same-repository branch it can reach secrets that no environment restricts. The diff check reads paths from git, not text a lane wrote. |
| D18 | **Takeover loads no settings from the repo.** The takeover terminal starts `claude` with the same rule as D4, so a hook or allow rule a lane wrote never runs in the builder's terminal. This amends the takeover plan (`2026-10-22-10db-10-takeover.md`). | Takeover runs the builder's own `claude`, unsandboxed, in the lane's checkout. Loading the repo's settings there would run a lane-written hook as the builder (from Gemini's takeover point). |

## 4. Consequences

- **A lane can no longer push, even in a `local` project.** It holds no credentials and the remote is not an
  allowed host unless the project allows it. The builder pushes. This amends batch delivery decision 79's
  `local` case, where agents could push to unprotected branches.
- **Repo instructions must be read deliberately.** Without repo settings, Claude Code doesn't load a repo's
  `CLAUDE.md` into a lane. The briefing points the lane at the repo's agent instructions instead.
- **The first run of a project may fail on a path or host nobody listed.** A file-tool read and an unlisted
  host raise a card that can add the path or host to the project. A sandboxed Bash read has no card: it fails
  with `Operation not permitted` and the lane reports it. Today a read-list path is added by answering a
  file-tool card "always allow in this project"; adding one in Settings is designed. The toolchain reads
  cover mise's state and cache, `~/.cargo/bin` and rustup's home; mise's, nvm's and volta's installs are
  listed by each manager's layout and opened entry by entry, never `etc`; a `PATH` entry under home opens
  only its own files; mise's config dir is never opened, and each lane gets its own global mise config with
  the builder's tool versions only (built). A toolchain whose files live elsewhere
  outside its PATH entries can still hit `Operation not permitted` the same way.
- **Package caches are per lane.** No writable cache that can hold code a later install or build runs is shared
  between lanes, so npm's cache, pnpm's store, state and cache directories live in the lane's temp directory and go with it (built); each session downloads
  again. cargo's `CARGO_HOME` is per lane too, which costs a full rebuild each session (30 to 37 s for `cargo check` of the Tauri crate, measured) (built). A shared cargo home let one lane
  plant a `config.toml` or edit an unpacked `build.rs` that every later lane ran. An npm install with that
  cache is unmeasured, though spike 14 check 9 measured one with the cache in the checkout. pnpm 12 takes its
  store operation lock in a fixed `/private/tmp/pnpm-store-operation-locks-<uid>` (measured), shared with every
  lane and the builder's own pnpm, so the profile keeps it closed and a pnpm dependency change can't run in a
  lane; its hazard card says so.
- **A project with server tests turns loopback on** (D15), and accepts what that opens. A project whose tests read
  a `.env` file names it as an exception, or moves the values into its environment names (D5).
- **A batch that changes CI waits for the builder at ship** (D17), and so does one the secret scan stops (D16).
- **CI covers what the sandboxed gate skips.** That is the setuid tests for 10db itself.

## 5. Sequencing

Slice 1, **built** (§7) and always on, is D1–D4, D8 and D15, and part of D5 and D14, of the plan below.

1. **Accounts first.** The accounts branch finishes with a re-scoped guard task in place of the rest of Task 7:
   - the permission matcher fails closed on an uncertain parse, and an escaped space no longer joins words;
   - every parked Task 7 finding is closed: fixed, or recorded as moot once this spec is built (threat model
     §9);
   - its architecture section becomes `04-accounts.md` and points its "Known and accepted" at the threat model.

   The guard's credential rules stay as interim policy (D12). Task 7R's text and decision rows 90–96 live in
   this spec's docs PR. That PR merges to `main`, and `feat/accounts` merges `main` before Task 7R runs.
2. **A lane sandbox plan, after accounts merges,** because D5 builds on the accounts launcher. In order:
   - D11, D13, D16, D17 and the push URL pin, which need no sandbox;
   - D5's allow-listed environment. Keeping the account's own variables from Bash needs the sandbox, so that
     part lands with D1;
   - D4;
   - D1, D2, D3, D8, D14 and D15 together, since cards, file tools and the profile change with the sandbox;
   - D6, D7 and D9;
   - D18, with the takeover plan;
   - D12.

   Each step closes rows in threat model §6 and turns its Built column to yes.
3. **Before the plan:** threat model §8 checks 3–6 and 8–15 run as a spike, because the plan's details depend
   on them. Checks 5, 10 and 12 can change D2, D14 and D8 themselves, so they run first. Check 15 is the exit
   criterion: the 10db gate passes whole under the gate profile, with D9's changes. Check 2 decides D10 later.

## 6. Testing

- **Each requirement gets a test that goes red without its mechanism.** For example:
  - a sandboxed `cat` of a protected path fails;
  - a gate that reads `~/.ssh` fails;
  - a lane's `lefthook.yml` change runs only inside the sandbox;
  - a linked PR template is refused;
  - a Read of a link in the checkout that points at a protected read is refused;
  - a lane session never has `GH_TOKEN`;
  - a canary in `/Users/Shared`, a sibling repository, another lane's temp directory and a `.env` file is
    unreadable;
  - a batch with a known-format secret, and one that changes a workflow, each stop at ship.
- **Sandbox tests run real Seatbelt on macOS.** The fake adapter stands in only where a model is needed.
- **Broker tables:** hazard or not; file-tool paths inside the checkout, in the read list, protected and
  other; and `SandboxNetworkAccess` hosts.
- **A live check:** one real dogfood batch on the 10db repo with the gate profile, recording every card it
  raises.

## 7. What is built

Slice 1 runs every real lane's Bash and file tools under the sandbox, always; there is no switch. The daemon's
and runner's options require the sandbox, and the Claude adapter refuses a session that arrives without one.
Only fake sessions, which run no commands, go without it. `apps/daemon/src/sandbox/` builds the profile and
the session's temp directory; the plan is `docs/superpowers/plans/2026-10-26-10db-12-lane-sandbox.md`. Every gate
runs under `srt` with the lane profile, built by the same code, in a temp directory of its own (decision 132,
threat model §4.7).

| Decision | State | Notes |
| -------- | ----- | ----- |
| D1       | built | For every lane's Bash. The profile is validated, and the live test proves it. |
| D2       | built | The deny-`/` form. Per-project read lists come from stored `Read` rules. Package caches are per lane, in its temp directory. |
| D3       | built | Hosts: denied at once, one card per host per session, and the card stays open after the session ends. Every lane runs in `default` mode; there is no auto mode and no dev override, so hazards and new hosts reach the broker. |
| D4       | built | `settingSources: []`, and the billing check on the repo's settings file is skipped for sandboxed sessions. The briefing points the lane at `AGENTS.md`. |
| D5       | partly | Bash children get an allowlist of names, and every other name, an account's own included, is denied in `credentials.envVars`. The gate gets the same allowlist of the project env, set inside its sandbox. The claude process keeps the login environment. |
| D8       | built | A Grep, Glob or LS of a directory that holds a protected root is refused with no card, which narrows this decision's "anything else goes to the broker". |
| D10      | stands | The claude process stays outside the sandbox; the file tools' boundary is software (threat model §7). |
| D14      | built  | Lanes (see D14) and the gate: each gate run has its own temp directory under `/private/tmp`, removed after the run, holding its package caches. |
| D15      | built | Loopback is the project's "Let lane commands use localhost" switch in Settings › General, off by default and read before each session, and before each gate. |
| D13      | built | Decision 129: every daemon git call reads no attributes and passes `core.fsmonitor=false` and `core.hooksPath=/dev/null`, so no hook, filter, driver, fsmonitor or submodule git runs, and `gh` gets the hook and fsmonitor config through `GIT_CONFIG_COUNT`. A git that honours `GIT_ATTR_SOURCE` (2.41 or newer, found by a behaviour probe) is required. Commits stage on a private index and move only their branch by compare and swap. Checkout pins (git dirs and origin's URLs) persist per project, the commit branch is pinned per workstream, and fetch and push go to the pinned URLs. The local-config allowlist before a fetch or push is defense in depth. |
| D6       | built  | For the gate (decision 132): the lane profile under `srt`, with the project's hosts and the checkout writable. The daemon's git commands run no hook at all (D13), so nothing of theirs needs the sandbox. |
| D9       | built  | The tests that need `ps`, the shared `/tmp`, the builder's home or Seatbelt itself skip under `TENDB_SANDBOX=1`, which every lane and gate command gets; the e2e fixture repository lives in the temp directory. WebKit's e2e can't run in the sandbox and skips there (threat model §7). A project's sandbox additions are still designed. |
| D7       | built  | Decision 133: each approved repo stdio server runs under `srt`, one sandbox per server and session, with the lanes' reads, writes only to its own temp dir, no host and no loopback, whatever the project's switch: an approval names no hosts yet, so this decision's "hosts its approval card names" waits, and the project's allowed domains are not opened to it. Its env is the lanes' allowlist plus its approved variables (threat model §4.6). |
| D11, D12, D16, D17, D18 | designed | The safe reader, the guard's retirement, the secret scan, the CI card and the takeover rule. |

Not closed by slice 1: `.git/` files nobody probed in an ordinary checkout, such as `.git/info/attributes`, which can
select an already configured filter driver for the daemon's unsandboxed git. D13's git reads no attributes,
and refuses while `info/attributes` is non-empty. Re-run the live test
after each Claude Code or SDK upgrade.
