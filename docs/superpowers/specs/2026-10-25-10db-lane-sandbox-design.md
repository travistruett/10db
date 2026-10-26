# 10db lane sandbox: the kernel boundary for lanes

**Status:** the builder chose the four open choices on 2026-10-25 (§3, D3–D6). Under review: an independent
Codex read, then a plan review.
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
- Claude Code's auto mode (its permission classifier), a separate later decision;
- a worktree per task (factory decision 13 stands: one shared checkout per project);
- platforms other than macOS.

## 2. Terms

- **Lane profile:** the sandbox settings 10db builds for one project's lanes, from D2 and the project's own
  additions. A lane's Bash runs under it through the Agent SDK's `sandbox` option.
- **Gate profile:** the lane profile without the account's variables, plus the additions the project's tests
  need (loopback, file events, unix sockets under the temp directory). The gate, the hooks of the daemon's git
  commands and repo MCP servers run under it through `@anthropic-ai/sandbox-runtime` (`srt`). It allows no
  other network, except a repo MCP server's own hosts (D7).
- **Protected reads:** 10db's data directory, every account's config directory, `~/.claude`, `~/.claude.json`,
  `~/Library/Keychains` and `/usr/bin/security`. Every profile denies them, whatever a project adds.

## 3. Decisions

These get numbers when they are recorded in `docs/architecture/decisions.md`.

| #   | Decision | Why |
| --- | -------- | --- |
| D1  | **The kernel sandbox is the lane boundary.** A lane's Bash runs under Claude Code's sandbox (`Options.sandbox`, Seatbelt) with `enabled`, `failIfUnavailable: true` and `allowUnsandboxedCommands: false`. A session whose sandbox can't start doesn't start, and its card says why. The guard and the cards are policy (threat model §3). | Spike 13: the sandbox engages through the SDK (check 1), and `denyRead` holds against 25 read routes (checks 2–4). With `allowUnsandboxedCommands: false`, Claude Code ignores a request to run a command outside the sandbox. |
| D2  | **Read policy: deny home, allow what the project needs.** The lane profile denies `~/` and allows again the checkout, the toolchain and cache directories 10db knows (mise, pnpm, cargo and rustup, Node's and git's caches) and paths the project lists. Protected reads stay denied whatever is listed. Writes go only to the checkout and the temp directory. | **The builder's choice.** A deny list can't name every secret on a machine (`~/.ssh`, `~/.aws`, other clients' repos, token files), but an allow list protects secrets nobody listed. The cost: a tool that reads an unlisted path fails until the path is added to the project. |
| D3  | **Cards, once Bash is sandboxed.** `autoAllowBashIfSandboxed` stays off. A Bash call that Claude Code doesn't treat as read-only therefore still reaches `canUseTool`, and the broker allows it without a card unless it is a hazard: a project hazard command, or a dependency change. `SandboxNetworkAccess` requests for unlisted hosts become cards: allow once, or always for the project (which adds the host to its allowed domains). MCP tools and WebFetch/WebSearch keep their cards. The guard still refuses what it refuses today. | **The builder's choice:** hazards and new hosts only. Keeping auto-allow off leaves the broker as the one place that decides, with no reliance on a hook returning `ask` (threat model §8 check 9). Spike 13 check 8 showed that with auto-allow on, no Bash call reaches `canUseTool`; check 9 showed that unlisted hosts arrive as `SandboxNetworkAccess`. A missed hazard is a policy miss inside the sandbox, not a breach. |
| D4  | **Lanes load no settings from the repo.** `settingSources` becomes `[]`. Repo hooks, allow rules, `env` and sandbox blocks never reach a lane, and repo skills, agents and commands under `.claude/` no longer load in lanes. A lane gets what it needs from 10db's project settings: allowed commands, read paths, allowed domains, extra environment names and the sandbox additions. The briefing tells the lane to read the repo's agent instructions (`AGENTS.md`, or `CLAUDE.md` where a repo uses it). The billing check on the repo's settings file goes, since nothing loads it. | **The builder's choice.** A lane can edit `.claude/settings.json`, so loading it lets one session give the next a hook that runs outside every sandbox, or allow rules that skip cards. Refusing only some keys would be another deny list. The 10db repo's own settings carry hooks meant for the builder's sessions. |
| D5  | **Lanes and the gate get an allow-listed environment.** It is built from the login environment, keeping only: `PATH`, `HOME`, `USER`, `LOGNAME`, `SHELL`, `TERM`, `LANG` and `LC_*`, `TZ`, `TMPDIR`, and named toolchain variables (mise's, `PNPM_HOME`, `CARGO_HOME`, `RUSTUP_HOME`, `JAVA_HOME` and the like). Variables the project lists are added, then the account's own variables (lanes only). Bash children get no account variable: the lane profile lists each name in `sandbox.credentials.envVars` with `mode: deny`, and `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` is set. | **The builder's choice.** Today the whole login environment reaches every lane and the gate, including `GH_TOKEN`, AWS keys and the SSH agent socket. Stripping by name misses a secret with an unexpected name, and spike 13 check 5 shows the scrub alone leaves GitHub tokens and unrecognised names. A deny by exact name is the only way to keep the account's own secret from Bash while the claude process keeps it. |
| D6  | **Lane-written code that the daemon runs runs inside the gate profile.** That covers the gate (on a lane's green run and at ship), and the daemon's `git commit` and `git switch`, which run the checkout's hooks. They run under `srt` with the gate profile's environment and no credentials. The push runs no repo hook (`--no-verify`), because the gate ran in the sandbox just before (batch delivery decision 82). It goes to the remote URL recorded when the batch started. | The gate, lefthook and `make check` are files a lane can edit. Running them outside a sandbox would undo D1 (threat model §4.7). Spike 13 check 10 lists what the 10db gate needs (loopback, `com.apple.FSEvents`, unix sockets under the temp directory) and what can't run there (D9). |
| D7  | **Repo MCP servers run under `srt`.** An approved stdio server from `.mcp.json` runs under the gate profile. It gets only `PATH`, `HOME` and its approved variables (as today), and its network is the project's allowed domains plus the hosts its approval card names. | The approval hashes the server's command and arguments, not the code they run: an approved `node scripts/mcp.js` runs whatever the lane last wrote there (threat model §4.6). |
| D8  | **The file tools follow D2 through the broker and deny rules.** Read, Grep and Glob are allowed without a card only inside the checkout (path-scoped allow rules, never a bare `Read`). Outside it they reach `canUseTool`, and the broker decides on the resolved real path. It allows the session's own saved tool results and the read list, refuses protected reads with no card, and asks with a card for anything else (always for the project adds the path to the read list). `Read(...)` deny rules for the protected reads back the broker up inside Claude Code. Edit and Write never touch `.git/` internals. | Permission deny rules always beat allow rules, so "deny home, allow named" can't be written as rules alone. The broker can decide it on a real path, which isn't shell parsing. Spike 13 check 6 showed a Read deny rule stops the Read tool and also reaches the Bash sandbox. Claude Code protects `.git/config` and `.git/hooks` from sandboxed Bash, but not from the Edit tool. |
| D9  | **Each project's gate must pass under its gate profile.** For the 10db repo, two changes. Tests that need a setuid binary (`ps`) skip under the sandbox and still run in CI. The e2e fixture repository moves under the temp directory. A project's sandbox additions are project settings with a Settings form. | Spike 13 check 10: exec of a setuid binary fails in the sandbox, and git can't create a repository under the working directory. CI runs outside 10db, so CI still covers those tests. |
| D10 | **Whole-process wrapping waits.** The claude process stays outside the kernel sandbox, bounded by its permission rules and the broker. It is revisited once threat model §8 check 2 shows whether Claude Code's Bash sandbox can apply inside an `srt`-wrapped claude. | The claude process reads its own sign-in from the Keychain, and Seatbelt profiles pass to children. Wrapping the whole process without a working inner sandbox would give Bash the Keychain access that D2 denies. |
| D11 | **The daemon treats the checkout as untrusted.** Every repo file it reads goes through the safe reader: a regular file under a size cap, with no link on any path component. That includes the PR template. Files it writes in its data directory never follow a link. The data directory is created with mode 0700. | Threat model §5: the PR template follows links today, so a lane can commit it as a link to a credential file and publish the file's text in a PR body. |
| D12 | **The guard keeps its policy jobs and drops its credential parsing.** Once D1, D2 and D5 are built, the guard's shell-text credential rules go: Keychain commands, environment dumps, secret-variable references and protected paths in shell text. What stays: claims, commits only through `commit`, the delivery and `gh` rules, hazard routing, read-only steps, and the structured path checks on the file tools. Its scanner fails closed for the permission matcher: an uncertain parse matches no stored rule. | Threat model §3 and §9. Text rules that can't hold keep producing false denies and new findings. Until the sandbox ships they stay as interim policy, since they are still better than nothing on `main`. |

## 4. Consequences

- **A lane can no longer push, even in a `local` project.** It holds no credentials and the remote is not an
  allowed host unless the project allows it. The builder pushes. This amends batch delivery decision 79's
  `local` case, where agents could push to unprotected branches.
- **Repo instructions must be read deliberately.** Without repo settings, Claude Code doesn't load a repo's
  `CLAUDE.md` into a lane. The briefing points the lane at the repo's agent instructions instead.
- **The first run of a project may fail on a path or host nobody listed.** A file-tool read and an unlisted
  host raise a card that can add the path or host to the project. A sandboxed Bash read has no card: it fails
  with `Operation not permitted`, the lane reports it, and the builder adds the path in Settings.
- **All lanes share one temp directory** (`/tmp/claude-<uid>`) until threat model §8 check 10 finds a way to
  give each its own.
- **CI covers what the sandboxed gate skips.** That is the setuid tests for 10db itself.

## 5. Sequencing

1. **Accounts first.** The accounts branch finishes with a re-scoped guard task in place of the rest of Task 7:
   - the permission matcher fails closed on an uncertain parse, and an escaped space no longer joins words;
   - every parked Task 7 finding is closed: fixed, or recorded as moot once this spec is built (threat model
     §9);
   - its architecture section becomes `04-accounts.md` and points its "Known and accepted" at the threat model.

   The guard's credential rules stay as interim policy (D12).
2. **A lane sandbox plan, after accounts merges,** because D5 builds on the accounts launcher. In order:
   - D11 and the push URL pin, which need no sandbox;
   - D5;
   - D4;
   - D1, D2, D3 and D8 together, since cards and file tools change with the sandbox;
   - D6, D7 and D9;
   - D12.

   Each step closes rows in threat model §6 and turns its Built column to yes.
3. **Before the plan:** threat model §8 checks 3, 4, 5, 6 and 9 run as a spike, because the plan's details
   depend on them. Check 2 decides D10 later.

## 6. Testing

- **Each requirement gets a test that goes red without its mechanism.** For example:
  - a sandboxed `cat` of a protected path fails;
  - a gate that reads `~/.ssh` fails;
  - a lane's `lefthook.yml` change runs only inside the sandbox;
  - a linked PR template is refused;
  - a lane session never has `GH_TOKEN`.
- **Sandbox tests run real Seatbelt on macOS.** The fake adapter stands in only where a model is needed.
- **Broker tables:** hazard or not; file-tool paths inside the checkout, in the read list, protected and
  other; and `SandboxNetworkAccess` hosts.
- **A live check:** one real dogfood batch on the 10db repo with the gate profile, recording every card it
  raises.
