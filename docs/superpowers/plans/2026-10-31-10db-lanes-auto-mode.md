# 10db Lanes in Auto Mode Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan
> task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Lanes stop waiting on permission cards for plain commands. Every real lane runs in Claude Code's auto
mode, inside the sandbox, with 10db's guard first, hazards and new hosts still carded, and the builder's
recurring denials passed to the classifier as inline rules.

**Decision:** `docs/architecture/decisions/2026-10-31-lanes-run-in-auto-mode-inside-the-sandbox.md` (read it in
full: it lists the order of what decides a call).

**Architecture:** One place changes behaviour: `sessionOptions` in `apps/daemon/src/sessions/claude-adapter.ts`
(`permissionMode: 'default'` today, with `settings: { permissions: { ask: [...sandbox.askRules] } }`). The
broker (`apps/daemon/src/inbox/permission-broker.ts`) and the guard (`apps/daemon/src/guard/judge.ts`) do not
change, except where the spike shows a case that no longer reaches them.

## Global constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`.
- Work only in `/Users/travistruett/Projects/10db-worktrees/auto-mode` (branch `feat/lanes-auto-mode`). Commit
  with explicit paths. Never run `make gate` yourself; run the tests, typecheck and lint of the packages you
  change.
- The Claude Agent SDK version is the one pinned in `apps/daemon/package.json`. Read its types
  (`node_modules/@anthropic-ai/claude-agent-sdk/*.d.ts`) for `permissionMode`, `settings` and `canUseTool`'s
  options rather than guessing.

## Tasks

### Task 1: Spike, against a real session

Write a throwaway script outside the repo's tests (in the worktree's `scratch/`, which is gitignored) that
starts a real Claude Code session through the SDK exactly as `sessionOptions` would for a sandboxed lane, but
with `permissionMode: 'auto'`, inline `settings.autoMode` rules and `CLAUDE_CODE_AUTO_MODE_MODEL`, and with a
`canUseTool` and PreToolUse hook that log what reaches them. Use the cheapest model and a short prompt that asks
the session to try, one at a time:

- [ ] a plain read command (`grep -n foo README.md`), and a compound one with `$(...)` and a `for` loop: expect
      the classifier to allow with nothing reaching `canUseTool`;
- [ ] a command matching one of the sandbox's ask rules (read `sandbox.askRules` for one): expect it to reach
      `canUseTool`;
- [ ] a call the guard denies (a write to a protected path): expect the PreToolUse deny to hold;
- [ ] a network request to a host not on the allowlist: expect it to reach `canUseTool` as the network tool;
- [ ] `make gate` and a CPU busy loop: expect the inline `autoMode` rules to block them, with the reason passed
      back to the session;
- [ ] the classifier model override: confirm which model ran (the SDK's messages or the session's usage).

Record each result (what reached the hook, `canUseTool`, the options' `decisionReasonType` and
`requiresUserInteraction`, and what the session saw) in the decision file's "Spike results" section, replacing
its placeholder, and commit that file alone. If any expectation fails, stop after recording it and report: the
design changes before task 2.

### Task 2: Lanes run in auto mode

Only after task 1's expectations hold.

- [ ] Red first, in the adapter's existing tests (`apps/daemon/src/sessions/claude-adapter*.test.ts`): a
      sandboxed session's options have `permissionMode: 'auto'`, keep the inline ask rules, carry the three
      `autoMode` rules from the decision, and set `CLAUDE_CODE_AUTO_MODE_MODEL` in the session env; an
      unsandboxed (fake) session is unchanged.
- [ ] Implement in `claude-adapter.ts`. The `autoMode` rules live in one named module (not inline strings in
      the adapter), worded as in the decision. The classifier model is chosen from the account's offered models
      (the routing catalogue knows which are offered); fall back to leaving the variable unset.
- [ ] The broker's classifier-escalation path (`escalated: isClassifierEscalation(options)`) already exists;
      add a test that an escalated call is carded and that no stored rule answers it.
- [ ] Docs: `docs/architecture/03-trust-boundaries.md` (the "Default permission mode" bullet and the summary
      line saying there is no auto mode), and any `AGENTS.md` or briefing text (`apps/daemon/src/briefing/`)
      that tells lanes they run in default mode. Remove the comment above `permissionMode` in the adapter that
      explains why auto mode is off.
- [ ] Run the daemon's tests for the files you touched, its typecheck and lint, and the repo docs tests
      (`pnpm --filter ./tests/repo exec vitest run src/architecture-docs.test.ts src/agent-docs.test.ts`).
