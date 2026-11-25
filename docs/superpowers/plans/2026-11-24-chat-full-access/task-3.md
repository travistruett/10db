# Task 3: a Full access Codex chat runs Codex's full-access mode under 10db's judge

Read the index's Brief and Global Constraints first, task 2's `spec()` branch, and the index's "Spike answers".

**Files:** `apps/daemon/src/chat/hooks.ts` (the same `spec()` branch, Codex side), `apps/daemon/src/sessions/codex-session.ts`
(`startThread`, `turn/start`, the `lane` profile check), `apps/daemon/src/sessions/codex-lane-config.ts`,
`apps/daemon/src/sessions/AGENTS.md`.

**Design.** For a Full access spec on a Codex account (ChatGPT plan, OpenAI key, OpenRouter):
- `thread/start`, `thread/resume` and `turn/start` send `sandbox: 'danger-full-access'` (or the thread's
  `config.permissions`, if the spike found the home wins), `approvalPolicy: 'never'` as today, and skip the
  `activePermissionProfile === 'lane'` check.
- The thread `config` takes `CODEX_TUI_DEFAULTS` (`codex-takeover.ts`) with its shell environment excluding
  `TENDB_MCP_TOKEN`, `TENDB_MCP_TOKEN_*` and `OPENROUTER_API_KEY`, so the agent's shell never holds 10db's
  `/mcp` bearer token or a key.
- `spec()` keeps `buildTrustPolicy` and `createHookJudge` for a Codex account (task 2 drops them for Claude
  only): 10db's guard hook and judge stay, Codex's judge today, so a Full access Codex chat is never unjudged. The
  policy gets `devAccess` open for Docker and loopback (`sessionDevAccess` closes both when unsandboxed; pass it
  open for Full access from `spec()`).
- Instructions and the builder's servers stay relayed: Codex reads no `AGENTS.md` under `untrusted`.

Spec sections: the decision's "Decision" 3 and 5.

**Tests:** none new; `codex-session.test.ts`'s read-only explore test must still pass.
