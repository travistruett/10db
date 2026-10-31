# Lanes run in Claude Code's auto mode inside the sandbox; the PreToolUse hook hands 10db what the classifier must not settle

- **Date:** 2026-10-31
- **Supersedes:** `2026-10-30-lanes-wait-for-auto-mode-proof.md` (lanes stay in `default` mode until the live
  test passes) and decision 124's "auto mode is gone". The rest of decision 124 stands: the lane sandbox is
  always on, with no environment switch. It also supersedes decision 94's `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1`
  for a session in auto mode, and `2026-10-30-lane-monitor-of-its-own-task-output.md` and
  `2026-10-31-lane-monitor-names-its-output-file-in-a-variable.md` (the Monitor grammar).
- **Amends:** factory spec §7 ("Permissions are decided by rules, never by an LLM"), as decision 103 did, and
  `docs/architecture/03-trust-boundaries.md` ("Default permission mode").

## Decision

Every sandboxed lane starts its Claude Code session with `permissionMode: 'auto'` (`LANE_PERMISSION_MODE`),
unless the builder turns off the app-wide setting "Lanes decide routine permissions with Claude Code's auto mode"
(Settings, Lane permissions; the `lane_auto_mode` app setting, on by default, read when each session starts).
There is no environment switch. An unsandboxed session, which only scripted tests start, always runs in `default`.

In auto mode a call no rule asks about is settled by Claude Code's classifier and never reaches `canUseTool`, so
what must still reach 10db is decided before the classifier. In order:

1. **The guard** (`judgeToolUse`, run by `judgePreToolUse`). Its refusals stay hard denies. It judges a Monitor
   command exactly as a Bash command, so the deploy, git and gh refusals hold through Monitor.
2. **The hook's asks** (`judgePreToolUse`). A hook `ask` reaches `canUseTool` in auto mode (row g). It asks for:
   - a Bash command that may run a hazard the task has not claimed: `hazardHit`, `firstUnread` (both scoped to
     the unclaimed hazards that have commands) and `unreadableHazard` (`guard/unread-hazards.ts`: a program that
     is not written out, a word the shell fills in after a program with hazard forms, a wrapper or
     `xargs`/`parallel` in front of one, a segment the parser is unsure of, and `eval`'s words read again as a
     command);
   - an endless background loop, whatever is claimed;
   - a Monitor call with an input key beyond `command`, `description` and `timeout_ms` (`ws` opens a socket from
     Claude Code's own process), or with no command. A Monitor command itself runs inside the sandbox (row j),
     so it gets Bash's checks and no more: `readsOnlyOwnFiles` no longer gates it;
   - WebFetch, WebSearch, the MCP resource tools and repo MCP tools, which act outside the sandbox's proxy;
   - a read the file-access judge would ask about and a write to a Claude Code configuration path (the file tools
     are not under Seatbelt).
     It refuses a Bash or Monitor call carrying `allowed_domains`, which in auto mode lets the classifier alone
     widen the sandbox's hosts. The broker answers an `ask` from a stored rule or a card, as before; a hook ask is
     not read as a classifier escalation (row k).
3. **The sandbox's ask rules** (`permissions.ask`) for the `.claude` paths reach `canUseTool` in auto mode (row h).
4. **A host a Bash command reaches that the project does not list** is refused by the sandbox proxy with no card
   (row d). The builder accepted this. The lane briefing tells lanes to ask the builder with `AskUserQuestion`.
5. **Claude Code's classifier** decides everything else: the plain reads, searches, test runs and builds that
   used to wait on an "Allow Bash?" or "Allow Monitor?" card. The tools that used to card and now go to it, and
   are accepted: Skill, BashOutput, KillShell, Task and NotebookRead.
6. **What the classifier escalates** (`requiresUserInteraction`, or `decisionReasonType: 'classifier'`) reaches the
   broker as `escalated` and becomes a card no stored rule answers (decision 103). The live runs never saw one:
   the classifier or the model refuses outright.

The session also gets inline `autoMode` rules (Claude Code reads `autoMode` only from user, managed or inline
settings, never the repository's): `hard_deny` the project's full gate (the command as a JSON string, so any
command is safe in the sentence) and CPU load on the builder's Mac, `soft_deny` paths outside the worktree. Both
lists name `"$defaults"` first: Claude Code's documentation says a list without it replaces the built-in rules
(force push, `curl | bash`, production deploys, the exfiltration rule), and the settings test pins it. The exact
gate command is not in a sandboxed lane's `allowedTools`, because an allow rule settles a call before the
classifier and the hard deny would never fire; the changed-check command stays allowed. `CLAUDE_CODE_AUTO_MODE_MODEL`
is not used (row f).

**The env scrub.** Claude Code forces `default` mode while `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB` is `1` (row i), so
the adapter sets it to `0` for a session in auto mode and keeps `1` in default mode (unit tests in
`claude-adapter.test.ts`). With it off, Claude Code's own children inherit the session env, which holds the
account's credential, so what is outside the Bash sandbox was checked:

- A lane's Bash and Monitor commands run inside the sandbox, and the lane profile denies every name off the
  allowlist to them by name (`sandbox.credentials.envVars`, which includes the scrub variable itself). Tests:
  `env-allowlist.test.ts` denies each of `SECRET_VARIABLES`, `AWS_ACCESS_KEY_ID`, `AWS_PROFILE`,
  `ANTHROPIC_BASE_URL`, `CLAUDE_CODE_USE_BEDROCK` and `CLAUDE_CONFIG_DIR`, and `lane-sandbox.test.ts` shows that
  with all of them in the session env the profile denies each, and the command env and the env file hold none.
- No hook command runs: the harness plugin has no `hooks` directory or manifest entry, a sandboxed session loads
  no settings file and carries no `hooks` setting, and every hook it registers is an in-process callback (tests
  in `claude-adapter.test.ts`). Stdio MCP servers run under srt through `env -i`, with no session env.
- What remains is Claude Code itself and the git it runs outside the sandbox, which inherit the credential.
  Claude Code needs it. The git runs with `GIT_CONFIG_GLOBAL=/dev/null`, no variable that names a lane-writable
  path, and a git dir the lane cannot write (`denyWrite`), so a lane cannot plant a hook or config for it to
  run. Stripping the names from the child's env is not possible, since an API-key, gateway or Bedrock account
  authenticates with them.

A guard that throws in the PreToolUse hook is turned into a deny. The matcher follows the readings of a package
manager line up to a limit and throws past it, so a line nothing can read is refused, not passed.

**Matching.** The matcher behind `hazardHit` and the guard's claim, DEPLOY, git and gh checks reads a command
more ways than it was written: redirections dropped three ways and, as a fourth, any word with a `<` or `>`;
every later word of a line as a wrapped program (with `@version` stripped), all of the first 16 and past that the
programs with rules; `run`, `run-script`, `rum` and `urn` as the script they run, applied until nothing new
appears; pnpm and yarn binaries given as the subcommand; `yarn workspace <name>`; a bare `yarn`; npm and bun
subcommand aliases read as the canonical one (so the default hazard list stays canonical); dash, ksh, csh, tcsh
and fish as shells; `coproc` as a prefix. Git and gh behind `xargs` or `parallel` are always refused. The parser
marks a word the shell fills in (`dynamicWords`: an unquoted `$`, backtick, glob or brace expansion, a `$` in
double quotes) so a quoted literal such as `'src/**/*.test.ts'` is not an unread word, and a program that takes
its arguments as data (`grep`, `echo`) is not read as running a hazard it names.

Known gaps, each bounded by the sandbox and not chased further: an alias defined in the same command and then
used, a wrapper that runs a program held in a variable (`xcrun $P add x`), a script written and then run,
`node`, `perl`, `ruby` and `python` run with `-e` or `-c`, `make` targets, and `npm run <script>`.

## Spike results

Run on 2026-10-31 against Claude Code 2.1.316 through Agent SDK 0.3.310, model `claude-haiku-5-5`, one real
session per behaviour. Each session had `permissionMode: 'auto'`, `settingSources: []`, the inline `permissions.ask`
rules, a sandbox with `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false` and
one allowed domain, a PreToolUse hook and a `canUseTool` that log and (for `canUseTool`) deny. The script replicated
the settings by hand rather than calling the daemon's builders, which need a running sandbox runtime; it differs in
the ask rules (`Write` and `Edit` under a `.claude/` dir, the shape `claudeProtectedPaths` produces) and in a
smaller filesystem profile.

| #   | Point                                                                                     | Result                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | ----------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Plain and compound reads run with nothing at `canUseTool`                                 | Holds                      | `grep -n foo README.md`, `for f in $(ls); do echo $f; done` and `echo $(cat README.md \| head -1)` all ran; the hook saw each, `canUseTool` saw none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| b   | A sandbox ask-rule match reaches `canUseTool`                                             | Holds                      | `Write` under the ask-ruled dir reached `canUseTool` with `decisionReasonType: 'rule'`; `requiresUserInteraction` was absent. The deny came back to the session as the tool result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| c   | A PreToolUse deny holds                                                                   | Holds                      | The hook's deny reached the session as `PreToolUse:Write hook error: <reason>`; the call never reached `canUseTool`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| d   | A request to a non-allowlisted host reaches `canUseTool` as `SandboxNetworkAccess`        | **Fails**                  | In auto mode `curl https://example.org` raised no `canUseTool` call at all: the sandbox's network ask goes to Claude Code's classifier (the binary's `Sandbox network classifier`, which fails closed) and the proxy answered 403 (`deny network-outbound example.org:443`). In `default` mode, with Bash allowed, the same request reached `canUseTool` as `SandboxNetworkAccess` with `{host: 'example.org'}`.                                                                                                                                                                                                                                        |
| e   | Inline `autoMode` rules block `make gate` and CPU load, with a reason the session sees    | Holds, with two conditions | In `soft_deny`, the rules were cleared when the prompt named the command ("run make gate"): it ran. They blocked it when the prompt only asked to check the project, and a `hard_deny` entry blocked it and `timeout 1 yes > /dev/null` even when named. Both were refused without reaching `canUseTool`; the session saw "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation)", and `result.permission_denials` listed the call. The reason never carries the rule's own text. The load test was bounded by `timeout 1`. |
| f   | `CLAUDE_CODE_AUTO_MODE_MODEL` is honoured                                                 | Not shown                  | A nonexistent model id and `claude-haiku-4-5` gave identical outcomes, and `modelUsage` lists only the session model. The binary names the classifier "server-side"; nothing observable ties the variable to it.                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| g   | A PreToolUse hook returning `permissionDecision: 'ask'` reaches `canUseTool` in auto mode | Holds                      | `pnpm add left-pad` and `cd tmp && pnpm add left-pad`, with the hook answering `ask` for them: both reached `canUseTool` with `decisionReasonType: 'hook'` and the hook's reason as `decisionReason`. `requiresUserInteraction` was absent on the options, so a hook ask is not read as a classifier escalation and stored rules answer it. The classifier did not decide either.                                                                                                                                                                                                                                                                       |
| h   | A content-scoped `permissions.ask` rule on Bash reaches `canUseTool` in auto mode         | Holds                      | With `Bash(pnpm add:*)` in the inline ask rules and no hook ask, both the plain and the compounded (`cd tmp && pnpm add left-pad`) command reached `canUseTool` with `decisionReasonType: 'rule'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

What the rows changed in the design:

- Row d: a new host reached by a Bash command is refused by the proxy with no card. The builder accepted
  that on 2026-10-31 (one host card in the two days measured); the briefing tells the lane to ask with
  `AskUserQuestion`. WebFetch, WebSearch, Monitor's `ws` and MCP tools do not pass through the proxy, so the
  hook asks about them instead.
- Row e: the gate and CPU rules are `hard_deny`, with `$defaults` first.
- Row f: the classifier's model is not set; nothing showed `CLAUDE_CODE_AUTO_MODE_MODEL` taking effect.
- Rows g and h: a PreToolUse `ask` and a content-scoped ask rule both reach `canUseTool`, so hazards and the
  tools that act outside the proxy are handed over in the hook.

Run again on 2026-10-31 for this decision (sonnet, real sessions, Claude Code 2.1.316):

| #   | Point                                                                 | Result    | Evidence                                                                                                                                                                                                                                                                               |
| --- | --------------------------------------------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| i   | `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1` keeps a session out of auto mode | Holds     | Claude Code 2.1.316 forces `default` mode while it is set ("Permission mode forced to default"); declaring `allowedTools` does not lift it. With it `0`, init reports `permissionMode: 'auto'`.                                                                                        |
| j   | A Monitor command runs inside the Seatbelt sandbox like Bash's        | Holds     | With a profile that does not list `~/.tenDB-probe-out`, Bash `echo hi > ~/.tenDB-probe-out/f` failed with "operation not permitted"; the same write through Monitor left no file.                                                                                                      |
| k   | A hook-originated `ask` is not a classifier escalation                | Holds     | The options carry `decisionReasonType: 'hook'` and no `requiresUserInteraction`, so stored rules still answer it.                                                                                                                                                                      |
| l   | The live block "lane sandbox in auto mode, live"                      | See below | Hazard write, hazard command however spelled and ask-rule edit: pass. Claude Code's own network (WebFetch, Monitor `ws`): pass. New hosts from Bash: refused with no card, as row d said. Secret upload: stopped by the classifier or the model. Routine commands: ran without a card. |

## Why

From 10db's own event log, on 2026-10-31: the 45 finished tasks averaged 7.3 hours of wall time and 36 minutes of
sessions. Lanes waited about 100 hours on permission cards (31 "Allow Bash?", 19 "Allow Monitor?", others), and
about three answers in four were a bare "allow once" of a plain command such as `grep -n`, `sed -n` or
`git status`. The builder trusts auto mode in their own sessions and asked for 10db to work the same way.

Decision 124 removed auto mode because the classifier would approve the hazards and new hosts the cards exist
for. The hook's asks answer that: they hand hazards and the tools that act outside the proxy to the broker before
the classifier, and the proxy refuses new hosts for commands. The sandbox stays the boundary; the classifier is
policy, not a boundary (threat model §3). The earlier decision to wait for the live test is met: the cases pass
(row l), and the one that cannot be a card (new Bash hosts) is accepted. The reason no session had entered auto
mode was the env scrub (row i), found by bisecting the SDK options.

Turned down: a model of 10db's own (through OpenRouter) answering permission cards for this; auto mode already
does that job and costs no new key. Keeping `default` mode with a smarter shell scanner: the scanner is a
filter, and splitting commands to approve them is what the threat model says never to build. An environment
switch: decision 124 removed it because a Finder-launched app cannot reach one; the setting lives in the app.
