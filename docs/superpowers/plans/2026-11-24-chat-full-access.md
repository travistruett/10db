# Full access for a chat

**Size: Core** (sandbox, permissions, billing, 10db's writers). Index plus one card per task.
Decision: `docs/architecture/decisions/2026-11-24-a-chat-the-builder-turns-full-access-on-for-runs-as-claude-code-does.md`.
Specs it changes: `docs/superpowers/specs/2026-11-17-10db-sessions-simplified-design.md` ("4.3" and "4.5 Open in
Terminal"), `docs/superpowers/specs/2026-11-12-10db-trust-line-design.md` (the attended policy section).

## Brief

- **What changes for you.** A chat's ⋯ menu has **Turn On Full Access…**. After one confirmation the chat runs as
  `claude` does in your terminal: no 10db sandbox, your settings, hooks, plugins, skills and MCP servers, and
  Claude Code's own checks deciding what to ask. An orange **Full access** badge sits in the title row; its menu
  turns it off. Board tasks never get it. The look was approved from screenshots on 2026-11-24.
- **What it buys.** Working on 10db from inside 10db, in one window.
- **What could go wrong, and how we'd know.**
  - A lane or task runs unsandboxed: `fullAccess` exists only on the chat's spec type, so it doesn't compile, and
    the adapter's refusal of an unsandboxed lane stays.
  - The chat writes the checkout while 10db merges into it: a Full access turn takes the folder hold or waits
    for it, and keeps it until its background commands end or the jobs deadline closes the session.
  - A settings file moves billing: the start check and the mid-session recheck read every settings file the chat
    loads, and refuse with a line naming the file.
  - Like `claude` in a terminal, a Full access agent can read anything you can, 10db's own Keychain entries
    included.
- **Calls you might disagree with.**
  - Codex runs its full-access mode but keeps 10db's judge, because Codex's Auto-review reviews almost nothing
    under full access.
  - A Bedrock key account runs in `default` mode (asks are cards), so the key never reaches the agent's commands.
  - Turning it on while a chat is only reading records Here, as Open in Terminal does.
  - Your own setup loads on your default Claude account. On an account with its own config folder (an API key,
    Bedrock, a second plan) 10db still brings your setup across, as it does for a sandboxed chat; on Codex your
    `~/.codex` config doesn't load yet, and the confirmation says so.
  - Plan turns inside a Full access chat run with full access too: it is the same attended conversation.
- **Needed from you:** nothing.

## Global Constraints

- `fullAccess` lives on `ExploreSessionSpec` only, never `AgentSessionCore`, so a `LaneSessionSpec` can't carry
  it. On the daemon side only `chat/hooks.ts` `spec()` turns the chat row's flag into a session spec; lanes,
  passes, the gate and task conversations never see it, and `claude-adapter.ts` keeps refusing an unsandboxed lane.
- 10db's writers stay protected: a Full access turn, wherever the chat works, takes the folder hold for the turn
  or waits for it, and releases it only once its background commands have ended.
- Kept: the chat's and Plan's 10db tool policy, the title-row git steps, the account checks, the billing checks.
- `chat/hooks.ts` is shared with `feat/limits-judge-nouls` (session 10db-e9): change only `spec()`'s Full access
  branch and the hold release; leave its `createHookJudge` call line as it is. Don't touch `trust/` except to read
  `sessionDevAccess`, or `inbox/hook-judge.ts`.
- Generate the migration last, after the final merge of `main`; only one open PR adds migrations at a time.
- Tests: only those named in the cards (`.claude/rules/testing.md`). Before review, a click-through on the real
  daemon and a real account (task 4).

## Provider parity

| Account | Full access runs |
| --- | --- |
| Claude plan (default config folder) | auto mode, no sandbox, `user`/`project`/`local` settings, the builder's own servers and plugins as Claude Code loads them |
| Claude plan (own config folder), API key, Bedrock profile | as above, with 10db's relay of the builder's plugins, instructions and servers kept, since `user` is the account's folder; API key through `apiKeyHelper` |
| Bedrock key | as above in `default` mode under the scrub; asks are cards |
| ChatGPT plan, OpenAI key, OpenRouter | Codex `danger-full-access`, 10db's judge with Docker and loopback open, instructions and servers relayed; the builder's `~/.codex` config and hooks don't load yet (stated in the confirmation) |

## Interfaces

```ts
// packages/contracts/src/chat.ts
ChatDto: { ...; fullAccess: z.boolean() }
ChatPatchInput: { ...; fullAccess: z.boolean().optional() }

// packages/db/src/schema.ts, chats
fullAccess: integer('full_access', { mode: 'boolean' }).notNull().default(false)

// apps/daemon/src/sessions/types.ts, ExploreSessionSpec
readonly fullAccess?: FullAccessSettings;
export interface FullAccessSettings {
  /** Claude Code's own permission mode: 'auto' where auto mode runs and no key is in the env, else 'default'. */
  readonly permissionMode: 'auto' | 'default';
  /** The API-key account's Keychain helper; ANTHROPIC_API_KEY is then left out of the env. */
  readonly apiKeyHelper: string | null;
  /** CLAUDE_CODE_SUBPROCESS_ENV_SCRUB=1: a key is in the env (Bedrock key). */
  readonly scrub: boolean;
  /** The account's config folder is the builder's default one, so Claude Code loads the builder's setup itself. */
  readonly ownSetup: boolean;
}

// apps/daemon/src/sessions/full-access.ts (pure)
export function fullAccessSettings(input: {
  readonly kind: AccountKind;
  readonly autoModeRuns: boolean; // autoModeRuns(kind, model)
  readonly apiKeyHelper: string | null; // takeoverOf(account) gives it for an API key
  readonly defaultConfigDir: boolean; // sessionConfigDir(...) is the builder's own
}): FullAccessSettings;

// apps/daemon/src/sessions/claude-query-options.ts
export function fullAccessOptions(
  profile: Extract<ClaudeProfile, { kind: 'explore' }>,
  full: FullAccessSettings,
): ClaudeProfileOptions;

// apps/daemon/src/chat/confinement.ts
export function judgeFullAccessCall(call: ChatCall, root: string, folder: ChatPlace): ShapeVerdict;
```

## State table (design, not a test list)

| Chat | Turn On | Turn Off | A turn starts |
| --- | --- | --- | --- |
| reading / choosing | records Here (`ChatWorkService.enterHere`), stores on | n/a | n/a |
| here / branch | stores on | stores off | full: takes the hold or waits for it ("{holder} is changing files…"); never runs read-only |
| moving | refused: "Wait for the move to finish" | same | n/a |
| a turn running | refused (409): "Waits for the turn to end" | same | n/a |
| in the terminal / sealed | item hidden | item hidden | n/a |
| turn ended, background commands running | n/a | n/a | the hold stays until they end, at most `JOBS_STOP_DEADLINE_MS`; then the session closes, stopping them, and the hold is released |

## Tracks and tasks

0. Spike: settings sources, `.mcp.json` approval, a keyed account, Codex's `sandbox` param, live (`task-0.md`).
1. State: column, contracts, `ChatService.patch` (`task-1.md`).
2. Claude: the Full access session, its call verdict, the hold, keys and billing (`task-2.md`).
3. Codex: the Full access thread (`task-3.md`).
4. Desktop: wire the approved mock-up, then a click-through on the real daemon (`task-4.md`).
5. Docs and notes (`task-5.md`).

Order: 0, 1, 2, 3 (2 and 3 share `spec()`), then 4, then 5. One implementer runs it end to end.
