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

To be filled in by task 1 of `docs/superpowers/plans/2026-10-31-10db-lanes-auto-mode.md`.

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
