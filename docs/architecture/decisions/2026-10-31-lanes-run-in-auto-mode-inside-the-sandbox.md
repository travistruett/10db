# Lanes run in Claude Code's auto mode inside the sandbox; 10db's guard and hazard cards still come first

- **Date:** 2026-10-31
- **Supersedes:** decision 124's "auto mode is gone" (every lane in `default` mode). The rest of decision 124
  stands: the lane sandbox is always on, with no switch.
- **Amends:** factory spec §7 ("Permissions are decided by rules, never by an LLM"), as decision 103 did, and
  `docs/architecture/03-trust-boundaries.md` ("Default permission mode").

## Decision

Every real lane starts its Claude Code session with `permissionMode: 'auto'`. In auto mode a call no rule asks
about is settled by Claude Code's classifier and never reaches `canUseTool` (spike row a), so everything that must
still hold for a sandboxed lane is decided before the classifier. What decides a tool call, in order:

1. **10db's guard** (`judgeToolUse` in `apps/daemon/src/guard/judge.ts`, the PreToolUse hook). Its refusals
   (claims, protected paths, the data directory, read-only steps) stay hard denies, whatever the classifier
   would say. The hook runs first whatever the classifier decides (row c).
2. **The same hook's asks** (`sandboxedAsk` in `apps/daemon/src/guard/sandboxed-asks.ts`). For a sandboxed lane
   the hook answers `permissionDecision: 'ask'` for: a hazard command (also inside `sh -c`, `find -exec` and
   compounds), a background loop with no end, a Monitor call with any input key beyond `command`, `description`
   and `timeout_ms` (`ws` opens a socket from Claude Code's own process, outside the sandbox's network proxy),
   WebFetch, WebSearch and repo MCP tools (they act outside the proxy), a read outside what lanes may read, and a
   write to a Claude Code configuration path. An `ask` from a hook reaches `canUseTool` in auto mode (row g), so
   the broker raises the cards it raises today, with today's bodies (the pnpm card, the loop card), and stored
   rules answer them as before. A Monitor command gets the same checks as a Bash command (hazards, loops, extra
   keys) and no more: `readsOnlyOwnFiles` no longer gates it, because in auto mode it would only add back the
   friction the Bash path removed. The broker's checks stay as they were for the calls that reach it.
3. **The sandbox's ask rules** (`permissions.ask`, passed inline per session) for the `.claude` paths. A
   content-scoped ask rule reaches `canUseTool` in auto mode, compounded commands included (row h).
4. **Network access to a host outside the project's allowed domains by a Bash command** is refused by the sandbox
   proxy and Claude Code's network classifier, which fails closed (row d). It no longer reaches `judgeHost`, so
   no card is raised before the refusal. Today's host card already denied first and asked after; in auto mode the
   lane sees the refusal and can ask the builder itself. 10db does not raise a card from Claude Code's
   `PermissionDenied` hook: its input carries the tool name, input and a reason, with no host. The lane briefing
   tells lanes to ask the builder. The builder accepted this on 2026-10-31: one host card was raised in the two
   days measured. WebFetch, WebSearch and MCP tools do not pass through the proxy; they are judged by the hook
   asks in point 2.
5. **Claude Code's auto-mode classifier** decides everything else: the plain reads, searches, test runs and
   builds that used to wait on an "Allow Bash?" or "Allow Monitor?" card.
6. **What the classifier escalates** (`requiresUserInteraction`, or a classifier decision on `canUseTool`'s
   options) reaches the broker and becomes a card, and no stored rule or carried allowance answers it (decision
   103's rule, unchanged; tested in `inbox.test.ts`). The spike never saw an escalation, so this path stays
   defensive.

Tools that used to card for a sandboxed lane and now go to the classifier, accepted: Skill, BashOutput,
KillShell, Task and NotebookRead. The hook asks narrowly for unreadable hazards: a program that is not written
out, a program with hazard forms followed by a word the shell expands, and `xargs` feeding one. Redirections are
dropped before a command is matched against the hazards, in the guard's claim check too.

The scan for a program or script 10db cannot read (`firstUnread`) is dropped for sandboxed lanes, and its module
is deleted. It carded `$CMD --help`, `sh -c "$x"` and the like; that is the friction auto mode removes, and the
sandbox, not the scan, bounds what a script can do. A hazard in plain view still cards; one spelled so the hazard
scan cannot see it no longer does (the known gap class of decision 2026-10-29). Writes outside a lane's claims
still card through the watcher.

The project's exact gate command is not in a sandboxed lane's allow list: an allow rule settles a call before the
classifier, so the hard deny below would never fire. The changed-check command stays allowed.

The session also gets inline `autoMode` rules (`settings.autoMode`, which Claude Code reads only from user,
managed or inline settings, never the repository's). These are the denials the builder kept typing as card
answers. The first two are `hard_deny`, because a `soft_deny` yields to a prompt that names the command, and
lane briefings name `make gate` when they forbid it (spike row e); the third is `soft_deny`, since the sandbox
already bounds paths:

- `hard_deny`: running the project's full gate (`make gate` or its gate command): 10db runs it after the step;
- `hard_deny`: generating CPU load (busy loops, `yes`, stress tools) on the builder's Mac;
- `soft_deny`: reading or writing outside the lane's worktree except the paths the sandbox already allows.

A refusal reaches the session as "denied by the Claude Code auto mode classifier" without the rule's text, so
the lane briefing says what the rules are. 10db does not set the classifier's model: nothing observable showed
`CLAUDE_CODE_AUTO_MODE_MODEL` taking effect (spike row f). A sandboxed session still loads no settings file, so a
repository cannot loosen any of this.

A spike checked these points against a real session before the switch flipped. Its results are below.

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

What this changes in the design:

- Point 3 does not hold. In auto mode a new host never reaches `judgeHost`: the classifier decides it, and fails
  closed. A lane that needs a host outside the project's allowed domains gets a refusal, not a card. The decision
  must either accept that (hosts come only from the project's allowed domains and the repo's declared ones) or
  keep `default` mode.
- The "never run the gate" and "no CPU load" rules go in `hard_deny`, not `soft_deny`: a soft rule yields to a
  prompt that names the command, and lane briefings name `make gate` when they forbid it.
- The classifier's own `escalated` path (`requiresUserInteraction`, `decisionReasonType: 'classifier'`) was never
  observed: every classifier refusal was a denial that the session saw, not an ask. Point 5 is untested, and the
  broker's escalation path stays defensive.
- Setting the classifier model has no proven effect; do not rely on it for cost or speed until it is shown.

## Why

From 10db's own event log, on 2026-10-31: the 45 finished tasks averaged 7.3 hours of wall time and 36 minutes
of sessions. Lanes waited about 100 hours on permission cards (31 "Allow Bash?", 19 "Allow Monitor?", others),
and about three answers in four were a bare "allow once" of a plain command such as `grep -n`, `sed -n` or
`git status`. The builder trusts auto mode in their own sessions and asked for 10db to work the same way.

Decision 124 removed auto mode because the classifier would approve the hazards and new hosts the sandbox's
cards exist for. The hook's asks (point 2) answer that: they hand hazards and the tools that act outside the proxy to the
broker before the classifier, and the proxy refuses new hosts for commands. The sandbox stays the boundary; the classifier is policy,
not a boundary (threat model §3), as decision 103 said.

Turned down: a model of 10db's own (through OpenRouter) answering permission cards. Auto mode already does that
job, is tuned for it, and costs no new key. And keeping `default` mode with a smarter shell scanner: the scanner
is a filter, and splitting commands to approve them is what the threat model says never to build.
