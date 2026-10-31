# Lanes run in Claude Code's auto mode inside the sandbox; 10db's guard and hazard cards still come first

- **Date:** 2026-10-31
- **Supersedes:** decision 124's "auto mode is gone" (every lane in `default` mode). The rest of decision 124
  stands: the lane sandbox is always on, with no switch.
- **Amends:** factory spec §7 ("Permissions are decided by rules, never by an LLM"), as decision 103 did, and
  `docs/architecture/03-trust-boundaries.md` ("Default permission mode").

## Decision

Every real lane starts its Claude Code session with `permissionMode: 'auto'`. What decides a tool call, in
order:

1. **10db's guard** (`judgeToolUse` in `apps/daemon/src/guard/judge.ts`, the PreToolUse hook). Its refusals
   (claims, protected paths, the data directory, read-only steps) stay hard denies, whatever the classifier
   would say.
2. **The sandbox's ask rules** (`permissions.ask`, passed inline per session). Content-scoped ask rules prompt
   even in auto mode, so every hazard the broker cards today still reaches 10db's broker (`canUseTool`) and its
   card.
3. **Network access to a new host** reaches the broker's `judgeHost` as it does today, never the classifier.
4. **Claude Code's auto-mode classifier** decides everything else: the plain reads, searches, test runs and
   builds that used to wait on an "Allow Bash?" or "Allow Monitor?" card.
5. **What the classifier escalates** (`requiresUserInteraction`, or a classifier decision on `canUseTool`'s
   options) reaches the broker and becomes a card, and no stored rule or carried allowance answers it (decision
   103's rule, unchanged).

The session also gets inline `autoMode` rules (`settings.autoMode`, which Claude Code reads only from user,
managed or inline settings, never the repository's). These are the denials the builder kept typing as card
answers:

- never run the project's full gate (`make gate` or its command): 10db runs it after the step;
- never generate CPU load (busy loops, `yes`, stress tools) on the builder's Mac;
- never read or write outside the lane's worktree except the paths the sandbox already allows.

The classifier model is `CLAUDE_CODE_AUTO_MODE_MODEL`, set by 10db to the fastest model the account offers that
auto mode supports (Haiku 5.5 where offered). A sandboxed session still loads no settings file, so a repository
cannot loosen any of this.

A spike proves points 2, 3 and 5 against a real session before the switch flips. Its results are below.

## Spike results

Run on 2026-10-31 against Claude Code 2.1.316 through Agent SDK 0.3.310, model `claude-haiku-5-5`, one real
session per behaviour. Each session had `permissionMode: 'auto'`, `settingSources: []`, the inline `permissions.ask`
rules, a sandbox with `failIfUnavailable`, `allowUnsandboxedCommands: false`, `autoAllowBashIfSandboxed: false` and
one allowed domain, a PreToolUse hook and a `canUseTool` that log and (for `canUseTool`) deny. The script replicated
the settings by hand rather than calling the daemon's builders, which need a running sandbox runtime; it differs in
the ask rules (`Write` and `Edit` under a `.claude/` dir, the shape `claudeProtectedPaths` produces) and in a
smaller filesystem profile.

| #   | Point                                                                                  | Result                     | Evidence                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --- | -------------------------------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| a   | Plain and compound reads run with nothing at `canUseTool`                              | Holds                      | `grep -n foo README.md`, `for f in $(ls); do echo $f; done` and `echo $(cat README.md \| head -1)` all ran; the hook saw each, `canUseTool` saw none.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| b   | A sandbox ask-rule match reaches `canUseTool`                                          | Holds                      | `Write` under the ask-ruled dir reached `canUseTool` with `decisionReasonType: 'rule'`; `requiresUserInteraction` was absent. The deny came back to the session as the tool result.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| c   | A PreToolUse deny holds                                                                | Holds                      | The hook's deny reached the session as `PreToolUse:Write hook error: <reason>`; the call never reached `canUseTool`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| d   | A request to a non-allowlisted host reaches `canUseTool` as `SandboxNetworkAccess`     | **Fails**                  | In auto mode `curl https://example.org` raised no `canUseTool` call at all: the sandbox's network ask goes to Claude Code's classifier (the binary's `Sandbox network classifier`, which fails closed) and the proxy answered 403 (`deny network-outbound example.org:443`). In `default` mode, with Bash allowed, the same request reached `canUseTool` as `SandboxNetworkAccess` with `{host: 'example.org'}`.                                                                                                                                                                                                                                        |
| e   | Inline `autoMode` rules block `make gate` and CPU load, with a reason the session sees | Holds, with two conditions | In `soft_deny`, the rules were cleared when the prompt named the command ("run make gate"): it ran. They blocked it when the prompt only asked to check the project, and a `hard_deny` entry blocked it and `timeout 1 yes > /dev/null` even when named. Both were refused without reaching `canUseTool`; the session saw "Permission for this action was denied by the Claude Code auto mode classifier. Reason: The server-side auto mode classifier judged this action dangerous (it gave no explanation)", and `result.permission_denials` listed the call. The reason never carries the rule's own text. The load test was bounded by `timeout 1`. |
| f   | `CLAUDE_CODE_AUTO_MODE_MODEL` is honoured                                              | Not shown                  | A nonexistent model id and `claude-haiku-4-5` gave identical outcomes, and `modelUsage` lists only the session model. The binary names the classifier "server-side"; nothing observable ties the variable to it.                                                                                                                                                                                                                                                                                                                                                                                                                                        |

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
cards exist for. Points 2 and 3 answer that: hazards are content-scoped ask rules, which Claude Code prompts for
even in auto mode, and network hosts go to the broker. The sandbox stays the boundary; the classifier is policy,
not a boundary (threat model §3), as decision 103 said.

Turned down: a model of 10db's own (through OpenRouter) answering permission cards. Auto mode already does that
job, is tuned for it, and costs no new key. And keeping `default` mode with a smarter shell scanner: the scanner
is a filter, and splitting commands to approve them is what the threat model says never to build.
