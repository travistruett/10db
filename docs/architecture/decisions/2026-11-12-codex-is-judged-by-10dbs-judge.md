# Codex is judged by 10db's judge through its guard hook, with approvals closed

- **Date:** 2026-11-12

## Decision

A Codex session's calls are judged by 10db's judge (`JudgeKind.Tendb`), through the PreToolUse guard hook 10db
installs in the account's `CODEX_HOME`: the guard runs first, and a call it leaves open goes to the session's
`judgeCall` (`inbox/hook-judge.ts`), which takes the fast path, then the `crosses_limit` decision. Codex keeps
`approvalPolicy: 'never'` on `thread/start`, `thread/resume` and `turn/start`, and 10db sends no
`approvalsReviewer`. Auto-review is not used.

- Under `never`, Codex itself refuses a forced `rm` (`-f`, `--force`, any short group holding `f`), whatever
  10db's judge says. 10db leaves that refusal as Codex's.
- A hook Codex hasn't recorded as trusted is skipped silently. 10db records the guard hook's trust
  (`CodexHome.trustGuardHook`), reads the hook list back and refuses the session (`sandbox_refused`) unless the
  hook is enabled and trusted (`checkGuardHook`). 10db never sends `bypass_hook_trust`.
- Web search is `cached` in every Codex session with the Web switch on and `disabled` with it off; `live` and
  `indexed` are never sent.
- Without a ready judge (no OpenRouter key, the master switch or Limits off, `TENDB_JUDGE=off`) a Codex session
  starts on 10db's rules and says so in its thread.

## Why

- **Auto-review sees only what crosses Codex's sandbox.** Live check L1 (research notes, "Live checks") showed
  Auto-review judging an escalation over app-server, and the protocol routes only approval requests to it:
  sandbox escapes, blocked network access, MCP approval prompts. Live check L5 ran it beside 10db's `lane`
  profile and guard hook: it reviewed escalations and the one call Codex's own dangerous-command check flags, a
  forced `rm`; `rm -r`, `find -delete` and an overwrite through `apply_patch` ran with no review. The trust
  line keeps the sandbox as rules no judge can cross, so with escalations closed Auto-review would judge almost
  nothing.
- **Only the hook sees every call.** A Codex PreToolUse hook can't answer `ask` (the binary rejects it), but it
  can deny, so 10db's judge answers there and a limit in attended work is carried to the builder's card by the
  broker, and in a lane is a recorded skip.
- **Turned down:** Auto-review alone (it never sees in-sandbox calls), and Auto-review with escalations open
  (`on-request`), which would let a model approve a sandbox escape the trust line keeps closed; the guard can't
  refuse an escalated call either, since the hook payload doesn't say a call is escalated (L5 (b)).
- **What would bring Auto-review back:** a reviewer Codex runs for calls inside the sandbox, or a hook that can
  answer `ask`, layered on with `on-request`, a per-thread policy and the guard refusing every escalation from
  Codex's side.
