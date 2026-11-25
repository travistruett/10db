# Task 0: live spike of the unsandboxed retry

Read the index's brief and Global Constraints first. Size: Core. No production change is committed by this task.

Make a throwaway change on the branch (never committed): `allowUnsandboxedCommands: true` in `buildLaneProfile`
(`apps/daemon/src/sandbox/profile.ts`, ~384), and in `judgeCommand` (`apps/daemon/src/shape/confinement.ts`,
~168) return `{ decision: 'ask', reason: 'spike' }` instead of the deny. Run a chat in the 10db Dev window
(`pnpm dev:window`, skill `10db-dev-window`) on a Claude plan account, Here, after the first change. Ask it to run
a command the sandbox blocks (a write to `~/Library/Caches/10db-spike-<n>`, then `curl -sI https://example.com`
if the network is blocked) and drive the UI at `http://localhost:1420` with Playwright.

Answer, each with the evidence (log line, hook input, screenshot path in the session scratchpad):

1. After the sandbox blocks it, does Claude retry with `dangerouslyDisableSandbox: true` unprompted?
2. Does the retry reach 10db's PreToolUse hook (`chat/hooks.ts` `preToolUse`) with the flag in `tool_input`?
3. Does the hook's `ask` reach `canUseTool` (the broker), with the flag in `req.input`, on auto mode as well as
   default mode?
4. Allowed, does the command run outside the sandbox (the file exists)?
5. Which environment does it see: `env | sort` through an allowed unsandboxed call. List every `TENDB_*`,
   `ANTHROPIC_*`, `CLAUDE_*`, `AWS_*`, `OPENAI_*`, `GH_*`/`GITHUB_*` name present (names only, never values), and
   whether `git config user.email` answers.
6. Does an "Allow This" button ever show on a Claude chat today (a refused call in auto mode)?
7. Does the retry carry its own `tool_use_id`, distinct from the blocked call's?
8. Does a subagent's flagged call reach the hook with `agent_id` set?
9. Repeat 3 on a Bedrock account if one is set up in 10db (skip and say so if not).
10. Does an ask rule `Bash(dangerouslyDisableSandbox:true)` exist in what 10db passes, and would adding one change
    anything given the hook already asks? (Read the SDK options 10db builds; no live run needed.)

Write the answers into the index under "Spike answers", revert the throwaway change, and commit only the index
(`git add docs/superpowers/plans/2026-11-25-chat-inline-asks.md && git commit -m 'docs: spike answers for inline chat asks'`).
If 2 or 3 is no, stop and report: the plan comes back to the coordinator.

Tests: none.
