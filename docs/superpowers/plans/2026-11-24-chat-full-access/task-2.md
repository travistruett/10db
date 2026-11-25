# Task 2: a Full access chat's Claude session runs as Claude Code does

Read the index's Brief and Global Constraints first, and the index's "Spike answers".

**Files:** `apps/daemon/src/chat/hooks.ts` (`spec()` and the turn's hold), `apps/daemon/src/chat/confinement.ts`,
`apps/daemon/src/chat/prompt.ts`, `apps/daemon/src/daemon/shape-session-tools.ts` (the broker without a
sandbox), `apps/daemon/src/sessions/types.ts`, new `apps/daemon/src/sessions/full-access.ts`,
`apps/daemon/src/sessions/claude-query-options.ts`, `apps/daemon/src/sessions/claude-session.ts`
(`exploreQueryOptions`, `settingsRefusal`, `settingsRecheckHooks`, the MCP list),
`apps/daemon/src/sessions/account-check.ts`, `apps/daemon/src/sessions/project-settings.ts`,
`apps/daemon/src/environment/launch.ts`, and their `AGENTS.md` notes.

**Implements:**

```ts
// sessions/types.ts, on ExploreSessionSpec only (never AgentSessionCore)
readonly fullAccess?: FullAccessSettings;
export interface FullAccessSettings {
  readonly permissionMode: 'auto' | 'default';
  readonly apiKeyHelper: string | null;
  readonly scrub: boolean;
  readonly ownSetup: boolean;
}
// sessions/full-access.ts (pure)
export function fullAccessSettings(input: {
  readonly kind: AccountKind;
  readonly autoModeRuns: boolean;
  readonly apiKeyHelper: string | null;
  readonly defaultConfigDir: boolean;
}): FullAccessSettings;
// sessions/claude-query-options.ts
export function fullAccessOptions(
  profile: Extract<ClaudeProfile, { kind: 'explore' }>,
  full: FullAccessSettings,
): ClaudeProfileOptions;
// chat/confinement.ts
export function judgeFullAccessCall(call: ChatCall, root: string, folder: ChatPlace): ShapeVerdict;
```

**Design.**
- **`fullAccessSettings`:** `permissionMode` is `'auto'` when `autoModeRuns` and the kind carries no key in the
  env, else `'default'`; `apiKeyHelper` for an API key; `scrub` for a Bedrock key; `ownSetup` when the account
  uses the builder's default config folder.
- **`spec()` with the chat row's `fullAccess`:** no sandbox from `deps.prepare`; a broker built without
  `fileAccess` even when srt is absent (today `deps.prepare` is undefined then and `canUseTool` denies all); on a
  Claude account only, no `buildTrustPolicy` and no `createHookJudge` (a Codex account keeps both: task 3);
  `preToolUse` is `judgeFullAccessCall`. When `ownSetup`, no setup
  plugins, injected instructions or relayed servers (Claude Code loads them); otherwise keep 10db's relay as a
  sandboxed chat has it. 10db's `/mcp` server always, plus approved project servers if the spike says they wait.
  Plan's prompt and agents stay as today.
- **`judgeFullAccessCall`:** 10db's and Plan's tool policy (`chat/tool-policy.ts`) for `mcp__10db__*`; for a
  file-tool edit inside the root, the folder-hold check `judgeChatCall` makes; for everything else a bare allow
  with no `updatedInput`, so auto or default mode decides (an explicit allow skips auto mode,
  `claude-mapping.ts`). No Agent input rewrite, no git refusal.
- **`fullAccessOptions`:** `settingSources: ['user','project','local']`, `strictMcpConfig: false`, no `sandbox`,
  no ask rules, Claude Code's default `tools`, `fileCheckpointing` on, the chat's system prompt appended (without
  its "Change git through your tools, never the shell" line), `settings: { autoCompactEnabled: true,
  apiKeyHelper? }`, `permissionMode` from the settings, `CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1'` only with `scrub`.
  `ANTHROPIC_API_KEY` is left out of the env when `apiKeyHelper` is set.
- **Account check:** `credentialsMatch` (`account-check.ts`) and the preflight accept the `apiKeySource` the
  spike saw for a helper, only when the spec set `apiKeyHelper`.
- **Billing:** `settingsRefusal` and `settingsRecheckHooks` run for a Full access chat too (today lanes only),
  over the project, local and user settings files, the user file read at `sessionConfigDir(...)/settings.json`.
  Every family `project-settings.ts` refuses by name stays refused, for lanes and chats alike. The one change: a
  provider switch set off (`CLAUDE_CODE_USE_BEDROCK` or `CLAUDE_CODE_USE_VERTEX` as `0` or `false`) passes, since
  it moves nothing.
- **The hold (state table, "A turn starts" column):** a Full access turn takes the hold wherever the chat works.
  When `takeTurn` fails it waits for the hold as a blocked Here send does, never starting read-only. At turn end
  the release waits until the SDK reports no running background task for the session (the conversation's
  `backgroundTasks`), in place of the sandbox's `endJobs`, under the same `JOBS_STOP_DEADLINE_MS`: past it the
  session closes, which stops its background tasks, and the hold is released, as a sandboxed chat's is today.

Spec sections: the decision's "Decision" 1-5; trust-line spec, the attended policy section (replaced for Full
access by Claude Code's own checks).

**Test (core: permissions, pure rule table), one,** for `fullAccessSettings`: Claude plan on the default folder
gives `auto`, no scrub, `ownSetup`; API key gives the helper and `auto`; Bedrock key gives `default` and scrub;
a plan on its own folder gives `ownSetup: false`. Prove it red by giving the Bedrock key `auto`. The settings it returns for an API key carry the helper, and
`fullAccessOptions` built from them has no `ANTHROPIC_API_KEY` in its env (one assertion in the same test). Extend the
existing `project-settings` parser test with one case each for the local file and `CLAUDE_CODE_USE_BEDROCK=false`.
Value cards per `.claude/rules/testing.md`.
