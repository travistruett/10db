# 10db Sessions M2a, One Claude Core and One Fake: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One Claude session core with a lane profile and an explore profile, in place of the two loops in
`claude-adapter.ts` (1189 lines) and `claude-shape.ts` (532). One scripted fake for both profiles, in place of
`fake-adapter.ts`'s lane session and `fake-shape.ts`. No behaviour change.

**Architecture:** `claudeQueryOptions(profile, sandbox)` is a pure function that holds every SDK option that depends
on the profile. `claude-session-hooks.ts` holds the billing-gated guard hook and the `canUseTool` bridge both profiles
use. `claude-session.ts` holds one session core, which reads a profile's rules where the two loops differ today, and
one retry loop, whose start plan gives a lane three starts and Plan one (§5.4's "one function with an `attempts`
parameter"). `claude-adapter.ts` keeps only the `SessionAdapter` surface: `createClaudeAdapter`, `probeAccount` and
`complete`. `SessionAdapter.start` and `startShape` keep their signatures; M2b replaces them with `open`.

**Tech Stack:** TypeScript, `@anthropic-ai/claude-agent-sdk` 0.3.316 (types only outside `claude-adapter.ts`), Vitest.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` §5.4, §12 (M2a), §13. Research:
`docs/architecture/research/2026-11-11-sessions-research.md` T1 §2 (item 1, 7), §5 (A, E), §6 (traps 1, 3, 9).

## Global Constraints

- Root `AGENTS.md`, `apps/daemon/AGENTS.md`, `.claude/rules/code-style.md`, `.claude/rules/testing.md`.
- Branch `feat/sessions-m2a` in its own worktree:
  `git worktree add ../10db-worktrees/sessions-m2a -b feat/sessions-m2a origin/main`. M1 and the trust line's T2
  merge first (the roadmap's order). Tasks in order. One commit per task.
- **T2 has changed both loops.** T2 (`2026-11-12-10db-trust-t2-setup-comes-along.md`) puts the builder's setup on
  every session: the instructions appended to the system prompt and the skills and plugin dirs in `plugins` (trust
  line §6). This plan cites c4da899's lines and values; read each from `main` after T2. Where T2 changed an option,
  the table and the rows take `main`'s value, and line numbers move. Plan gets auto mode later, in M4b (trust line
  §12), so the explore profile still runs in `default` mode here.
- Commits are Conventional Commits, name every path, single-quoted `-m`, and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`. Never `--no-verify`.
- **No behaviour change.** For each profile, these stay exactly as on `main` after T2:
  - every event, in order
  - every `ended` reason and message
  - every SDK option key and value, including keys that are absent
  - every SDK call and its order
  - every log line and its fields

  The only allowed unifications are internal state, and code that is identical in both copies today. Log lines are
  pinned by the lane's existing log tests (`claude-adapter.test.ts:883, 2009-2091`) and by one `captureLogs` row per
  profile in Task 1. The debug stderr lines (row 2) are kept by porting them as written, not by a test.
- **Provider parity.** This milestone touches only the Claude sessions:
  - The Codex adapter and its Plan refusal (`codex-adapter.ts:114-116`) are untouched.
  - The live Plan turn (Task 7) runs on a subscription only.
  - Bedrock, API-key and gateway accounts rest on the scripted rows, which the account check covers per kind
    (`claude-adapter.test.ts:2421-2607`).
- **Existing tests stay green and unmodified, except their import lines.** No `it` body, helper or fixture in an
  existing test file changes. New `it`s may be added in a new `describe`.
- An SDK option the profile doesn't set is left out, never set to `undefined`: the explore tests assert
  `not.toHaveProperty('sandbox')` (`claude-shape.test.ts:197-198`), and `not.toHaveProperty('plugins')` unless T2
  gave Plan the setup dirs, in which case they assert T2's dirs.
- **Not here.** §5.4 also names `includePartialMessages: true`, commands from `supportedCommands()`, and a model pick
  applied through `setModel`. Each of them changes behaviour, so each lands with its milestone: M2c for the first two,
  and the explore engine (M4b) for the third. The fake's new events wait for M2c.
- Only `claude-adapter.ts` imports the Agent SDK at runtime (`apps/daemon/AGENTS.md:106`). Every new file imports SDK
  types only.
- **A test of code that already works** (Task 1) proves red by a one-line mutation of the code under test, reverted
  before the commit. The commit names each mutation. Every later task keeps Task 1's rows green: they are the net for
  the merge.
- After each task, run: `pnpm --filter @10db/daemon exec vitest run src/sessions src/shape src/daemon/start-shape.test.ts src/daemon/start-screens.test.ts`
  and `pnpm --filter @10db/daemon typecheck && pnpm exec eslint --max-warnings=0 apps/daemon/src/sessions`.
  Tasks 5 and 6 also run the whole daemon project: `pnpm exec vitest run --project daemon`.

## Where the two loops differ today

Every row stays per profile, except the rows marked **unify**. Line numbers are `claude-adapter.ts` (lane) and
`claude-shape.ts` (explore) on c4da899. Task 5 reads every per-profile row from the profile, and nothing else
branches on it.

| # | What | Lane | Explore | Merged |
| --- | --- | --- | --- | --- |
| 1 | Spawn | `spawnClaude(…, 'lane')`, always (:382) | `deps.spawn` when given, `'interactive'` from the adapter (:223-225; adapter :1153-1171) | per profile |
| 2 | stderr | keeps a 4,000-char tail; debug `claude stderr`, 2,000 chars (:577-580) | debug `plan claude stderr`, 500 chars (adapter :1163-1165) | per profile |
| 3 | Log fields | `{ sessionId, workstreamId }` (:426, :938) | `{ sessionId, shapeId }` (:239) | per profile |
| 4 | Project settings checked before the start | unsandboxed only (:520-532) | never | lane only |
| 5 | Settings re-check hooks | unsandboxed only (:251-272, :379) | never | lane only |
| 6 | PreToolUse request and answer | `{ toolName, input, cwd }`, `toHookOutput` (:361-367) | adds `agentId`, `agentType`; `toShapeHookOutput` (:158-166) | per profile |
| 7 | `canUseTool`'s `escalated` | `isClassifierEscalation(options)` (:339) | `false` (:137) | per profile |
| 8 | PostToolUse and PostToolUseFailure measurement | none | `postToolUse`, `toolFailed`; a throw is logged as a warning (:178-220) | explore only |
| 9 | Account wait and starts | 30, 60 and 120 s; 3 starts; 10 and 30 s pauses (:71-75, :933-1008) | 30 s, 1 start (:54, :336) | one retry loop with a start plan |
| 10 | No account | sign-in check (subscription only), start again, then `noAccountWhy` or `missingAccountRefusal` (:610-657) | `billing_refused`: "Claude Code reported no account within 30 s. No message was sent." (:338-343) | per profile |
| 11 | A stop during the account wait | checks `ended \|\| failure`, then checks the account, then releases (:609, :663-667) | returns at `halted()`, which includes the stop (:337) | per profile |
| 12 | Refusal suffix | "No prompt was sent." | "No message was sent." | per profile |
| 13 | MCP registration failure | "Claude Code could not register the MCP servers. No prompt was sent." | "Claude Code could not register 10db’s tools. No message was sent." | per profile |
| 14 | Note for failed servers | the repo `.mcp.json` wording (:387-392) | the project-servers wording (:59-64) | per profile |
| 15 | Failed-servers log | warn `claude mcp servers failed to connect`, every name (:687) | warn `project mcp servers failed to connect`, repo names only (:385) | per profile |
| 16 | Prompt uuid | `spec.promptUuid` (:696) | none (:390) | per profile |
| 17 | Init logs | billing and MCP logs (:714-730) | none | lane only |
| 18 | Model check message | ends "…; that turn's first request may have been billed." (:748) | ends "…before any tool ran." (:427) | per profile |
| 19 | Permission mode logs (later init, status) | yes (:821-837) | none | lane only |
| 20 | A rejected rate limit | `limitRejected` ends `rate_limited`; carries `resetsAt` (:851-855, :516) | emits it as mapped; ends `completed` | per profile |
| 21 | MCP status logged after the first turn | yes (:760-774, :850) | none | lane only |
| 22 | First reply can show a refused model | `repliedYet = false` (:788) | `repliedYet = resume !== null` (:438) | per profile |
| 23 | `Error processing settings` before init | `sandbox_refused` when sandboxed (:866-880) | `error` | lane only |
| 24 | Pump waits for the account step | yes (:862, :881) | no | lane only |
| 25 | `interrupt()` before the prompt is sent | `null`, claude untouched (:904) | calls the SDK's `interrupt` (:513) | per profile |
| 26 | Refusal log | `claude session refused` | `shape session refused` | per profile |
| 27 | `ended` extras | `refusal` with `account_refused` only, `refusalBasis` with `model_refused` only (:498-503) | whatever `refuse` stored (:289-290); `refuse` stores them only with those reasons | **unify** (same output) |
| 28 | MCP servers registered | `buildMcpServers(spec)` (:212-229) | the same object, built inline (:352-367) | **unify** |
| 29 | `send` during the account wait | `unsent` list, then `preflightOk.then` (:891-902) | `preflightOk.then` (:501-511) | **unify** (`unsent` is read only between starts) |
| 30 | An unsandboxed session | refused unless `allowUnsandboxed` (adapter :1149-1152) | allowed, and it has no Bash | per profile |
| 31 | A later `init` (after a compaction or a resume) | ignored after logging the mode, so `started` comes once (:820-827) | mapped again, so a second `started` carries the new session id (:467-474). `shape/service.ts:702-705` rewrites `sdkSessionId` from it, so porting the lane's line would make Plan resume a stale id | per profile |
| 32 | A rate limit with no reset time (an assistant `rate_limit` error) | fills `resetsAt` from the last `rate_limit_event`; each turn's end clears `limitRejected` (:843, :853-855) | emits `resetsAt: null`. Plan's notice wording depends on that null (`shape/service.ts:739-744`) | per profile |

## Review Focus

1. **A Plan session on an account that is slow to start.** It waits 30 s once. It never asks `claude auth status`,
   never starts again, and never pauses the account (trap 9). Row in Task 1.
2. **A Plan session on a daemon with no sandbox.** It must start, never meet the lane's unsandboxed refusal, even on an
   adapter built without `allowUnsandboxed`. Row in Task 1.
3. **A stop during the account wait, in Plan.** It ends `stopped` and sends nothing. Row in Task 1.
4. **A Plan message sent before the first message reaches Claude Code.** It follows the first message, through the
   retry loop's forwarding that Task 5 adds. Row in Task 1.
5. **A rejected rate limit in Plan.** The session ends `completed`, as Plan's service expects today, not
   `rate_limited`. Row in Task 1.

---

### Task 1: Pin each profile's side of every difference no test pins yet

**Files:**

- Test: `apps/daemon/src/sessions/claude-adapter.test.ts`. Add a new `describe('a Plan session through the
  adapter')` after the `describe('createClaudeAdapter')` block, and one `it` in that block. Add a `shapeSpec(overrides)`
  helper beside `spec()` (`:44`), shaped like `claude-shape.test.ts:26-53`.

**Interfaces:**

- Consumes: `adapterFor`, `fakeQuery`'s `Script` (`account` may be a pending promise, `mcpSet: 'reject'`, `then`,
  `stderr`, `interruptHangs`), `ManualClock`, `laneSandbox` (`:308`), `laneTiers` (`:787-794`), `captureLogs`
  (`:18`, used as at `:2011`) and `rateLimitEvent` from the same file and `claude-test-support.ts`. The rows go through
  `createClaudeAdapter(…).startShape`, so they also pin the adapter's wiring (rows 1, 2, 30 of the table).

- [ ] **Step 1: Write the rows.**

| Row | Asserts | Red by (mutation, reverted) |
| --- | --- | --- |
| waits 30 s once for the account, asks no sign-in check, and refuses as billing | `account` never settles, `then: 'hang'`, `ManualClock`, `signInCheck` spy. After `clock.advance(30_000)`, the last event is `{ type: 'ended', reason: 'billing_refused', message: 'Claude Code reported no account within 30 s. No message was sent.' }`, `record.queries === 1` and the spy was not called | `ACCOUNT_MS = 31_000` in `claude-shape.ts` |
| ends with Plan's words when the email differs | `account_refused`, message ends `No message was sent.` | the suffix changed to `No prompt was sent.` |
| ends with Plan's words when the model differs | `initMessage('none', undefined, 'claude-opus-5-5')` on a spec asking for `claude-sonnet-5-5`: `billing_refused`, message exactly `Model check failed: 10db asked for claude-sonnet-5-5 but Claude Code runs claude-opus-5-5. The session stopped at its first turn, before any tool ran.` | the lane's sentence appended |
| ends with Plan's words when 10db's tools fail to register | `mcpSet: 'reject'`: `error`, message exactly `Claude Code could not register 10db’s tools. No message was sent.` | the lane's sentence |
| ends completed, not rate_limited, when a rejected limit is the last word | `[initMessage(), rateLimitEvent({ status: 'rejected', resetsAt: 1_791_000_000 })]`, then `end`: a `rate_limit` event with `resetsAt: new Date(1_791_000_000_000)`, then `ended` `completed` | the lane's `limitRejected` end reason |
| calls Claude Code's interrupt even before the first message is sent | `account` pending: `await handle.interrupt()` is `null` and `record.interrupts === 1` | `\|\| !promptSent` added to `interrupt` |
| ends at once when claude exits before it reports an account | `account` pending, `messages: []`, `then: 'end'`, no clock advance: the last event is `ended` `completed` with message `null`. The `it` takes a 2,000 ms timeout (its third argument), so the mutation fails fast, not at vitest's 30 s | `if (!started) await preflightOk;` added before the pump's `end` |
| ends with an error, not sandbox_refused, when its read-only sandbox fails to start | `shapeSpec({ sandbox: laneSandbox })`, `messages: []`, `then: { throws: 'Error processing settings: sandbox' }`: `ended` `error` | the lane's `SANDBOX_SETTINGS_ERROR` branch copied in |
| hands canUseTool escalated: false, whatever the classifier marked | after `turn_complete`, call `record.options.canUseTool('Bash', {}, { signal, toolUseID: 't1', decisionReasonType: 'classifier', requiresUserInteraction: true } as never)`, with a comment on the cast: the SDK passes these two fields at runtime, but its typings omit them (`claude-adapter.ts:231-235`). The spec's `canUseTool` got `escalated: false` | `escalated: isClassifierEscalation(options)` |
| starts claude at the daemon's own priority, not the lane tier | `stderr: ''`: `record.spawned === 1` and `laneTiers` is empty | `'lane'` passed in the adapter's `startShape` spawn |
| starts unsandboxed on an adapter that refuses an unsandboxed lane | `createClaudeAdapter` without `allowUnsandboxed`, `shapeSpec({ sandbox: null })`: the events hold `turn_complete`, and no `ended` names `UNSANDBOXED_REFUSAL` | the lane's refusal applied in `startShape` |
| stops during the account wait: ended stopped, nothing registered or sent | `account` a deferred promise, `then: 'hang'`; `await handle.stop()`, then resolve it: the last event is `ended` `stopped`, and `record.mcpCalls` and `record.inputs` are empty | the `if (halted()) return;` after `accountInfo` removed (`claude-shape.ts:337`) |
| sends a message sent during the account wait after the first message | `account` a deferred promise; `send('later')`, then resolve it: the text of `record.inputs` is `['First message', 'later']` | `send` pushing at once, before the prompt |
| ends stopped, not account_refused, when a stop is waiting on a hung interrupt as a wrong account arrives (row 11) | `ManualClock`, `stopGraceMs` 1,000, `interruptHangs: true`, `then: 'stall'` (it waits only for the abort; `'hang'` would end at `stop()`'s `input.end()`, `claude-adapter.test.ts:181-184`), `account` a deferred promise. Call `handle.stop()` without awaiting it. Resolve the account with `email: 'other@example.com'`, flush microtasks, then `clock.advance(1_000)` twice and await the stop. The last event is `ended` `stopped`, with no `refusal` | the explore preflight's `halted()` check after `accountInfo` replaced by the lane's `ended \|\| failure !== null` |
| emits a second started with the new session id at a later init (row 31) | `[initMessage(), assistantMessage([textBlock('a')]), resultMessage(…), { ...initMessage(), session_id: 'prov-session-2' }]`: the `started` events' `providerSessionId`s are `[PROVIDER_SESSION, 'prov-session-2']` | the lane's `if (started) { …; continue; }` on a later init |
| leaves a rate limit with no reset time at null (row 32) | `[initMessage(), rateLimitEvent({ status: 'allowed_warning', resetsAt: 1_791_000_000 }), assistantMessage([], 'rate_limit'), resultMessage(…)]`: the second `rate_limit` event has `resetsAt: null` | the lane's `lastResetsAt` fill |
| logs as a shape session, and none of the lane's lines | `captureLogs()`'s logger in place of `silentLogger`. One normal turn, then one refusal (another email). The refusal logs `shape session refused` with `shapeId`. No line is `claude session billing`, `claude session mcp`, `claude session mcp status` or `claude session permission mode` | the lane's init logging (`:714-730`) called for explore |
| (in `describe('createClaudeAdapter')`) logs a refusal as a claude session, with its workstream | `captureLogs()`, another email: one `claude session refused` line with `workstreamId` and no `shapeId` | the explore log name used for the lane |
| (in `describe('createClaudeAdapter')`) answers an interrupt before its prompt is sent with null, leaving claude alone | lane, `account` pending: `await handle.interrupt()` is `null` and `record.interrupts === 0` | `\|\| !promptSent` removed from the lane's `interrupt` |

- [ ] **Step 2: Run them on `main`'s code.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-adapter.test.ts`
Expected: PASS. These rows describe today's behaviour.

- [ ] **Step 3: Prove each row red.** Apply each row's mutation alone, run the Step 2 command, and see that row (and
  only rows about the same difference) fail. Revert the mutation. Never commit a mutation.

- [ ] **Step 4: Commit.**

```bash
git add apps/daemon/src/sessions/claude-adapter.test.ts && git commit -m 'test(daemon): pin where a plan session and a lane session differ before one core runs both

Red by: the mutation in each row of the plan Task 1 table, applied alone and reverted.

Value: protects=the account wait, refusal words, end reasons, interrupt, later init, rate-limit reset, logs, priority and sandbox rule of each profile;
fails_when=merging the loops applies the rule of one profile to the other;
why_new=claude-shape.test.ts drives startShapeSession directly and pins options and a few refusals, never the account wait, the rate-limit end, a later init, the adapter wiring or a stop before the first message;
no_claim=debug stderr lines

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: One options builder, `claudeQueryOptions(profile, sandbox)`

**Files:**

- Create: `apps/daemon/src/sessions/claude-query-options.ts`, `apps/daemon/src/sessions/claude-query-options.test.ts`
- Modify: `apps/daemon/src/sessions/claude-adapter.ts:274-384` (`sandboxedSettings` moves out; `buildQueryOptions`
  spreads the new function's result)
- Modify: `apps/daemon/src/sessions/claude-shape.ts:75-227` (`shapeOptions` spreads it)

**Interfaces:**

- Produces in `claude-query-options.ts`:

```ts
export type ClaudeProfile =
  | {
      readonly kind: 'lane';
      readonly allowedTools: readonly string[];
      /** The mode a sandboxed lane runs in, already resolved (`laneMode`); an unsandboxed one runs in default. */
      readonly permissionMode: LanePermissionMode;
      readonly pluginDir: string;
    }
  | {
      readonly kind: 'explore';
      readonly systemPrompt: string;
      readonly tools: readonly string[];
      readonly allowedTools: readonly string[];
      readonly disallowedTools: readonly string[];
      readonly agents: Readonly<Record<string, ShapeAgentDefinition>>;
    };

export type ClaudeProfileOptions = Pick<
  Options,
  | 'settingSources' | 'strictMcpConfig' | 'settings' | 'plugins' | 'sandbox' | 'systemPrompt'
  | 'tools' | 'allowedTools' | 'disallowedTools' | 'agents' | 'permissionMode'
> & {
  /** Merged over the session env, before AUTOUPDATE_OFF: the sandbox's env and the scrub switch; {} unsandboxed. */
  readonly sandboxEnv: Readonly<Record<string, string>>;
};

export function claudeQueryOptions(
  profile: ClaudeProfile,
  sandbox: LaneSandboxSpec | null,
): ClaudeProfileOptions;
```

  The values are today's (`claude-adapter.ts:303-328`, `claude-shape.ts:95-125`):
  - Lane, sandboxed: `settingSources: []`; `settings` `{ autoCompactEnabled: true, permissions: { ask }, autoMode }`;
    `sandbox`; `disallowedTools` the sandbox's; the profile's `permissionMode`; scrub `'0'` in auto, else `'1'`.
  - Lane, unsandboxed: `settingSources: ['project']`; `settings` `{ autoCompactEnabled: true }`; `permissionMode:
    'default'`; no `sandbox` or `disallowedTools`.
  - Lane, either way: `plugins: [{ type: 'local', path: pluginDir }]`, then T2's setup dirs.
  - Explore: always `settingSources: []`, `permissionMode: 'default'`, `systemPrompt` (with T2's appended
    instructions), `tools` and `agents` (each `model ?? 'inherit'`). Its `plugins` are T2's setup dirs, and never
    the lane's harness dir.
  - T2's setup reaches each profile however T2 passes it (a field on each profile, or a second argument). Add it to
    each row's `want` as `main` builds it.
  - Explore, sandboxed: `settings` with `permissions.ask` but no `autoMode`; scrub `'1'`; `disallowedTools` are the
    profile's then the sandbox's.
  - Both: `strictMcpConfig: true`.
- Consumes nothing from Task 1. `buildQueryOptions(spec: SessionSpec, deps: QueryDeps): Options` keeps its signature;
  it builds the lane profile with `permissionMode: laneMode(spec, deps)`.

- [ ] **Step 1: Write the failing table** (pure: rung 1). Reuse the read-only sandbox literal from
  `claude-shape.test.ts:55-79`.

```ts
const lane = (permissionMode: LanePermissionMode): ClaudeProfile => ({
  kind: 'lane', allowedTools: ['Read', 'mcp__10db__*'], permissionMode, pluginDir: '/harness',
});
const explore: ClaudeProfile = {
  kind: 'explore', systemPrompt: 'You are Shape.', tools: ['Read', 'Grep'], allowedTools: ['Read'],
  disallowedTools: ['Edit'], agents: { scope: { description: 'Scope', prompt: 'Review', tools: ['Read'] } },
};
const harness = [{ type: 'local', path: '/harness' }];
const agents = { scope: { description: 'Scope', prompt: 'Review', tools: ['Read'], model: 'inherit' } };
const preset = { type: 'preset', preset: 'claude_code', append: 'You are Shape.' };
const sandboxedLane = {
  settingSources: [], strictMcpConfig: true,
  settings: { autoCompactEnabled: true, permissions: { ask: sandbox.askRules }, autoMode: sandbox.autoMode },
  sandbox: sandbox.settings, disallowedTools: sandbox.disallowedTools, plugins: harness,
  allowedTools: ['Read', 'mcp__10db__*'],
};

it.each([
  { name: 'lane, unsandboxed: project settings, the plugin, default mode even when auto is asked',
    profile: lane('auto'), sandbox: null,
    want: { settingSources: ['project'], strictMcpConfig: true, settings: { autoCompactEnabled: true },
            plugins: harness, allowedTools: ['Read', 'mcp__10db__*'], permissionMode: 'default', sandboxEnv: {} } },
  { name: 'lane, sandboxed in auto mode: no settings file, the classifier rules, the scrub off',
    profile: lane('auto'), sandbox,
    want: { ...sandboxedLane, permissionMode: 'auto',
            sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '0' } } },
  { name: 'lane, sandboxed in default mode: the scrub on', profile: lane('default'), sandbox,
    want: { ...sandboxedLane, permissionMode: 'default',
            sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } } },
  { name: 'explore, unsandboxed', profile: explore, sandbox: null,
    want: { settingSources: [], strictMcpConfig: true, settings: { autoCompactEnabled: true },
            systemPrompt: preset, tools: ['Read', 'Grep'], allowedTools: ['Read'], disallowedTools: ['Edit'],
            agents, permissionMode: 'default', sandboxEnv: {} } },
  { name: 'explore, sandboxed: ask rules but no classifier rules, the scrub on', profile: explore, sandbox,
    want: { settingSources: [], strictMcpConfig: true,
            settings: { autoCompactEnabled: true, permissions: { ask: sandbox.askRules } },
            sandbox: sandbox.settings, systemPrompt: preset, tools: ['Read', 'Grep'], allowedTools: ['Read'],
            disallowedTools: ['Edit', ...sandbox.disallowedTools], agents, permissionMode: 'default',
            sandboxEnv: { ...sandbox.env, CLAUDE_CODE_SUBPROCESS_ENV_SCRUB: '1' } } },
])('$name', ({ profile, sandbox: s, want }) => expect(claudeQueryOptions(profile, s)).toEqual(want));

it.each([['unsandboxed', null], ['sandboxed', sandbox]])(
  'never gives the explore profile project settings, auto mode or the harness plugin dir (%s)', (_n, s) => {
    const options = claudeQueryOptions(explore, s);
    expect(options.settingSources).toEqual([]);
    expect(options.permissionMode).toBe('default');
    expect(options.plugins ?? []).not.toContainEqual({ type: 'local', path: '/harness' });
    expect(options).not.toHaveProperty('settings.autoMode');
  });
it('leaves sandbox and disallowedTools out of an unsandboxed lane', () => {
  const options = claudeQueryOptions(lane('auto'), null);
  expect(options).not.toHaveProperty('sandbox');
  expect(options).not.toHaveProperty('disallowedTools');
});
```

- [ ] **Step 2: Run it to see it fail.**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/claude-query-options.test.ts`
Expected: FAIL, the module doesn't exist.

- [ ] **Step 3: Implement `claudeQueryOptions`**, then make `buildQueryOptions` and `shapeOptions` spread it.
  Each composes `env: { ...spec.env, ...sandboxEnv, ...AUTOUPDATE_OFF }` and keeps its own `cwd`, `model`, `effort`,
  `resume`, `pathToClaudeCodeExecutable`, `canUseTool`, `hooks`, `abortController` and spawn exactly as they are. Drop
  `sandboxEnv` from what reaches the SDK.

- [ ] **Step 4: Run the new table, then every test in the Global Constraints command.** Expected: PASS, with no
  existing test changed.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/sessions/claude-query-options.ts apps/daemon/src/sessions/claude-query-options.test.ts apps/daemon/src/sessions/claude-adapter.ts apps/daemon/src/sessions/claude-shape.ts && git commit -m 'refactor(daemon): one claude options builder over profile and sandbox

Value: protects=what each profile and sandbox loads: settings sources, the plugin dir, the permission mode, the sandbox and the scrub;
fails_when=the explore profile gains project settings, auto mode or the harness plugin dir, or a profile loses its sandbox, mode or setup;
why_new=buildQueryOptions and the shape option tests each pin one profile through its own builder, never both through one;
no_claim=the hooks and canUseTool wiring (the existing tests)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 3: One billing-gated guard hook and one `canUseTool` bridge

**Files:**

- Create: `apps/daemon/src/sessions/claude-session-hooks.ts`
- Modify: `apps/daemon/src/sessions/claude-adapter.ts:231-272, 289-384`,
  `apps/daemon/src/sessions/claude-shape.ts:56-57, 66-67, 126-221`

**Interfaces:**

- Produces in `claude-session-hooks.ts`:

```ts
/** Identical in both copies today. */
export const BILLING_UNVERIFIED =
  'The billing check for this session did not pass, so 10db allows no tools in it.';

/** Every tool waits for `verified`; from the moment `refused()` is true every tool is denied. */
export interface ToolGate {
  readonly verified: Promise<boolean>;
  refused(): boolean;
}

/** The hook's cwd for each call, read once by canUseTool for the same tool use id; the newest 256 are kept. */
export interface HookCwds {
  remember(toolUseId: string, cwd: string): void;
  take(toolUseId: string): string | undefined;
}
export function createHookCwds(): HookCwds;

export function canUseToolBridge(bridge: {
  readonly gate: ToolGate;
  readonly cwds: HookCwds;
  readonly canUseTool: (req: ToolRequest) => Promise<ToolDecision>;
  /** Lane: isClassifierEscalation. Explore: () => false. */
  readonly escalated: (options: unknown) => boolean;
  /** Asked only for an mcp__ tool. */
  readonly listedTools: (() => Promise<readonly string[]>) | undefined;
}): NonNullable<Options['canUseTool']>;

/** Denies while the gate is closed; a judge that throws becomes a deny naming 10db's guard. */
export function preToolUseHook(hook: {
  readonly gate: ToolGate;
  readonly cwds: HookCwds;
  readonly judge: (input: PreToolUseHookInput) => HookJSONOutput;
}): HookCallbackMatcher;

export function isClassifierEscalation(options: unknown): boolean; // moved from claude-adapter.ts:236-248
export function settingsRecheckHooks(recheck: (what: string) => HookJSONOutput): NonNullable<Options['hooks']>;
export function measurementHooks(
  spec: Pick<ShapeSessionSpec, 'postToolUse' | 'toolFailed'>,
  logger: Logger,
): NonNullable<Options['hooks']>;
```

  - The lane's `judge` is `toHookOutput(spec.preToolUse({ toolName, input, cwd }))`. Explore's is
    `toShapeHookOutput(spec.preToolUse({ toolName, input, agentId, agentType, cwd }))` (table row 6).
  - The deny after a throw uses `toHookOutput` in both, as today.

- [ ] **Step 1: Extract and wire.** No new test: the behaviour is already pinned, through the hooks and `canUseTool`, by
  the tests at `claude-adapter.test.ts:571-756, 1007-1133, 1763-1946` and `claude-shape.test.ts:247-281, 373-530`.

- [ ] **Step 2: Run the Global Constraints commands.** Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add apps/daemon/src/sessions/claude-session-hooks.ts apps/daemon/src/sessions/claude-adapter.ts apps/daemon/src/sessions/claude-shape.ts && git commit -m 'refactor(daemon): one billing-gated guard hook and canUseTool bridge for both claude sessions

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 4: Move the lane session out of the adapter, unchanged

A move, nothing else. `claude-adapter.ts` keeps `ClaudeAdapterOptions`, `probeAccount`, `complete`, `drain` and
`createClaudeAdapter`.

**Files:**

- Create: `apps/daemon/src/sessions/claude-session.ts`
- Modify: `apps/daemon/src/sessions/claude-adapter.ts` (`:64-1008` move out, except what stays above)
- Modify (import lines only): `apps/daemon/src/sessions/claude-adapter.test.ts:22-29`,
  `apps/daemon/src/sessions/claude-shape.test.ts:15`, `apps/daemon/src/sessions/claude-shape.ts:21`

**Interfaces:**

- Produces in `claude-session.ts`:
  - `type QueryFn` (moved as is), `CLAUDE_MCP_SERVER` and `UNSANDBOXED_REFUSAL`.
  - `refusedSession(message: string): SessionHandle`.
  - `spawnClaude(options, deps, priority: 'lane' | 'interactive')`.
  - `buildMcpServers(spec: Pick<SessionSpec, 'projectMcpServers' | 'mcp'>)`. The parameter is widened for Task 5;
    existing callers compile unchanged.
  - `buildQueryOptions(spec: SessionSpec, deps: QueryDeps): Options` and `type QueryDeps`.
  - `interface LaneSessionDeps { claudePath; pluginDir; logger; stopGraceMs?; clock?; lanePermissionMode?; signInCheck? }`,
    with the same types as `ClaudeAdapterOptions`. `ClaudeAdapterOptions` becomes `extends LaneSessionDeps`, plus
    `spawnLogin?`, `query?` and `allowUnsandboxed?`.
  - `startLaneSession(spec: SessionSpec, deps: LaneSessionDeps, runQuery: QueryFn): SessionHandle`: today's
    `startWithRetry`.
- `claude-session.ts` imports nothing from `claude-adapter.ts`. `claude-shape.ts` takes `QueryFn` from
  `claude-session.ts`.
- `vi.mock('../priority')` (`claude-adapter.test.ts:788`) mocks the module for every importer, so `spawnClaude`'s new
  home is still mocked.

- [ ] **Step 1: Move the code, change the three import lines, run the Global Constraints commands.** Expected: PASS.

- [ ] **Step 2: Commit.**

```bash
git add apps/daemon/src/sessions/claude-session.ts apps/daemon/src/sessions/claude-adapter.ts apps/daemon/src/sessions/claude-adapter.test.ts apps/daemon/src/sessions/claude-shape.test.ts apps/daemon/src/sessions/claude-shape.ts && git commit -m 'refactor(daemon): the claude lane session moves out of the adapter, unchanged

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 5: Plan's session runs on the same core; `claude-shape.ts` goes

**Files:**

- Modify: `apps/daemon/src/sessions/claude-session.ts`, `apps/daemon/src/sessions/claude-adapter.ts:1149-1171`
- Delete: `apps/daemon/src/sessions/claude-shape.ts`
- Modify (import line only): `apps/daemon/src/sessions/claude-shape.test.ts:13`. **(call)** The file keeps its name:
  it tests the explore profile through `startShapeSession`, which M2b replaces.

**Interfaces:**

- Consumes: `claudeQueryOptions` (Task 2); the hooks module (Task 3); `startLaneSession`, `LaneSessionDeps` and
  `buildMcpServers` (Task 4).
- Produces in `claude-session.ts`:

```ts
export interface ClaudeSessionDeps {
  readonly claudePath: string;
  readonly logger: Logger;
  readonly stopGraceMs?: number;
  readonly clock?: Clock;
}

export type ClaudeSession =
  | {
      readonly profile: 'lane';
      readonly spec: SessionSpec;
      readonly pluginDir: string;
      readonly lanePermissionMode?: LanePermissionMode;
      readonly signInCheck: SignInCheck;
    }
  | {
      readonly profile: 'explore';
      readonly spec: ShapeSessionSpec;
      readonly spawn?: (options: SpawnOptions, onSpawn: (pid: number | null) => void) => SpawnedProcess;
    };

/** One wait per start; how many waits is how many starts (spec §5.4's `attempts`). */
export interface StartPlan {
  readonly waitsMs: readonly number[];
  readonly backoffMs: readonly number[];
}
export const LANE_STARTS: StartPlan; // { waitsMs: [30_000, 60_000, 120_000], backoffMs: [10_000, 30_000] }
export const EXPLORE_STARTS: StartPlan; // { waitsMs: [30_000], backoffMs: [] }

/** The retry loop over one core; a start that gets no account and isn't the last closes without an event. */
export function startClaudeSession(
  session: ClaudeSession,
  deps: ClaudeSessionDeps,
  runQuery: QueryFn,
  starts: StartPlan,
): SessionHandle;

/** Unchanged signature and deps (ShapeSessionDeps moves here as is). */
export function startShapeSession(spec: ShapeSessionSpec, deps: ShapeSessionDeps): ShapeSessionHandle;
```

  - `startShapeSession` is
    `startClaudeSession({ profile: 'explore', spec, spawn: deps.spawn }, deps, deps.query, EXPLORE_STARTS)`, with
    `spawn` left out when `deps.spawn` is absent.
  - `createClaudeAdapter.start` keeps its unsandboxed check (row 30), then calls
    `startClaudeSession({ profile: 'lane', spec, pluginDir, lanePermissionMode, signInCheck }, opts, runQuery, LANE_STARTS)`.
    `signInCheck` defaults to `claudeAuthStatus(opts.claudePath, env)`, as it does today at `:424-425`.
  - `startLaneSession` and `LaneSessionDeps` go. `ClaudeAdapterOptions` extends `ClaudeSessionDeps`, plus
    `pluginDir`, `lanePermissionMode?`, `signInCheck?`, `spawnLogin?`, `query?` and `allowUnsandboxed?`, as today.
  - `START_ATTEMPTS` becomes `starts.waitsMs.length`.
- Each per-profile row of the table is read from one `as const` record of profile rules: copy, wait plan, flags and log
  names, keyed by `session.profile`. Rows 4, 5, 17, 19, 21, 23 and 24 are `session.profile === 'lane'` branches.
  Nothing else in the core reads the profile.
- The lane keeps three starts (30, 60 and 120 s, `START_ATTEMPTS = START_WAITS_MS.length`), as spec §5.4, the code
  and `claude-adapter.test.ts:1162` all say. `decisions/2026-10-30-a-slow-start-is-not-a-signed-out-account.md:12`
  still says `START_ATTEMPTS = 2`. Task 7 corrects it.

- [ ] **Step 1: Write the core.** Port the lane's `startSession` line by line, then fold in each explore line from
  `claude-shape.ts` at the row of the table it belongs to. Where a row says "per profile", the lane line and the
  explore line both survive, chosen by the profile's rules. Keep `claude-session.ts` to one job, the session's run
  (about 700 lines): when a block that holds no state grows past about 40 lines, such as the init check or the
  `ended` builder, move it to a pure function in the same file.

- [ ] **Step 2: Delete `claude-shape.ts`, and change the one import line in `claude-shape.test.ts`.**

- [ ] **Step 3: Run the Global Constraints commands, then the whole daemon project.**

Run: `pnpm exec vitest run --project daemon`
Expected: PASS: every existing test, and every row Task 1 added.

- [ ] **Step 4: Check that no profile rule leaked.** List each `session.profile` read in `claude-session.ts`, and
  check each one against a row of the table. Any read that is not on the table is a behaviour change: undo it.

- [ ] **Step 5: Commit.**

```bash
git add apps/daemon/src/sessions/claude-session.ts apps/daemon/src/sessions/claude-adapter.ts apps/daemon/src/sessions/claude-shape.ts apps/daemon/src/sessions/claude-shape.test.ts && git commit -m 'refactor(daemon): plan sessions run on the lane session core, with a profile for each

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 6: One scripted fake for both profiles

**Files:**

- Create: `apps/daemon/src/sessions/fake-script.ts`: `FakeStep`, `FakeScriptBook`, `loadFakeScriptBook`,
  `FakeObservation` and `TURN_STEPS`, moved from `fake-adapter.ts:96-169`, plus the element types of
  `FakeAdapter.sent` and `FakeAdapter.interrupts` (`:174`, `:187`), named `FakeSent` and `FakeInterrupt`, so the
  session file never imports the adapter's class.
- Create: `apps/daemon/src/sessions/fake-session.ts`: the one session lifecycle, with the lane driver (the step
  interpreter now inline at `fake-adapter.ts:338-750`) and the explore driver (`refusedShapeSession` at
  `fake-shape.ts:182-198`, and `createFakeShapeSession` at `:202-306`), plus the `FakeShapeTurn`, `FakeShapeTurnResult` and `FakeShapeBehaviour` types.
- Create: `apps/daemon/src/sessions/fake-plan-script.ts`: `scriptedShapeBehaviour` and its draft, moved from
  `fake-shape.ts:42-180`. It is the e2e's Plan script, as the book is the lanes' script.
- Modify: `apps/daemon/src/sessions/fake-adapter.ts` (the class keeps its records, knobs, `probeAccount`,
  `startLogin`, `complete`, `readClientUuids`, and a thin `start` and `startShape`)
- Modify: `apps/daemon/src/sessions/index.ts:9-15` (export paths only; the exported names don't change)
- Delete: `apps/daemon/src/sessions/fake-shape.ts`

**Interfaces:**

- Produces in `fake-session.ts`:

```ts
export interface FakeSessionCore {
  readonly events: AsyncIterable<SessionEvent>;
  /** A no-op once ended. */
  emit(event: SessionEvent): void;
  /** Once: pushes `ended` (with `refusal` or `refusalBasis` only when given), ends the channel, runs onEnd callbacks. */
  end(reason: SessionEndReason, message: string | null, refusal?: AccountRefusal, basis?: ModelMarkBasis): void;
  ended(): boolean;
  onEnd(cleanup: () => void): void;
  /** Settles when end() has run. */
  readonly done: Promise<void>;
}
export function createFakeSessionCore(): FakeSessionCore;

/** A session that is only its `ended` event: the account refusals of both profiles. */
export function fakeEndedSession(ended: Extract<SessionEvent, { type: 'ended' }>): SessionHandle;

/** What the lane driver reads and records on the adapter; FakeAdapter builds one per start(). */
export interface FakeLaneContext {
  readonly title: string;
  readonly steps: readonly FakeStep[] | undefined;
  readonly reportedModel: string | undefined;
  readonly sent: FakeSent[];
  readonly observations: FakeObservation[];
  readonly interrupts: FakeInterrupt[];
  transcript(providerSessionId: string): Set<string>;
  taken(providerSessionId: string): string[];
  waitForSignal(name: string, untilStopped: Promise<'stopped'>): Promise<'signal' | 'stopped'>;
  interruptReceipt(untaken: readonly string[]): InterruptReceipt;
  interruptEndsSession(): boolean;
  stopGate(): Promise<void> | null;
}
export function runFakeLaneSession(spec: SessionSpec, context: FakeLaneContext): SessionHandle;
export function runFakeExploreSession(
  spec: ShapeSessionSpec,
  behaviour: FakeShapeBehaviour,
  providerSessionId: string,
): ShapeSessionHandle;
```

- Both drivers run on `createFakeSessionCore`. Each keeps its own differences, as the Claude core does:
  - The lane yields a tick after `started`.
  - The guard-failure text differs: the lane says `guard failed: ${error.message}`, explore says
    `guard failed: ${String(error)}`.
  - The refusal suffix: "No prompt was sent." and "No message was sent.".
  - The lane's refusal carries `refusal`; explore's doesn't.
  - Explore's stop doesn't wait for `done`.
  - `FakeAdapter`'s stop gates wrap each (`laneStopGate`, `shapeStopGate`).
- **(call)** The new events and the "at most one open handle per conversation" assertion (spec §5.4) are not added
  here:
  - The events don't exist until M2c.
  - Nothing in M2a's specs names a conversation. A shape-keyed assertion could fail a test that starts the next Plan
    session while the last one is closing, which would be a behaviour change.
  - M2b adds the assertion with `AgentSessionSpec.conversationId`, and M2c adds the events. Each is added once, in
    `FakeSessionCore`.

- [ ] **Step 1: Move and fold.** No new test. The fake is pinned by `fake-adapter.test.ts`, by every daemon test that
  drives it, and by the e2e. The shape suites (`src/shape/*.test.ts`, `daemon/start-shape.test.ts`,
  `daemon/start-screens.test.ts`) are what pin the explore driver.

- [ ] **Step 2: Run the whole daemon project, knip, and the e2e that run on the fake.**

Run: `pnpm exec vitest run --project daemon && pnpm knip && pnpm --filter @10db/desktop e2e shape.spec.ts workbench.spec.ts loop.spec.ts`
Expected: PASS.

- [ ] **Step 3: Commit.**

```bash
git add apps/daemon/src/sessions/fake-script.ts apps/daemon/src/sessions/fake-session.ts apps/daemon/src/sessions/fake-plan-script.ts apps/daemon/src/sessions/fake-adapter.ts apps/daemon/src/sessions/fake-shape.ts apps/daemon/src/sessions/index.ts && git commit -m 'refactor(daemon): one scripted fake session for lanes and plan conversations

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 7: Docs, a live Plan turn, run it, gate, PR

**Files:**

- Modify: `apps/daemon/AGENTS.md:285` (`sessions/claude-shape.ts` becomes `sessions/claude-session.ts`, explore
  profile), and the `sessions/` bullets near `:106`: one line naming `claude-session.ts` (the core, two profiles),
  `claude-query-options.ts`, and the fake's files.
- Modify: `apps/daemon/AGENTS.md:103`. "(`LANE_PERMISSION_MODE` in the Claude adapter)" becomes
  "(`LANE_PERMISSION_MODE` in `sessions/claude-session.ts`)".
- Modify, facts about the code only, as `docs/architecture/decisions/README.md` allows in the pull request that moves
  the code:
  - `docs/architecture/decisions/2026-11-02-shape-session-and-convert.md:12` (`claude-shape.ts`)
  - `docs/architecture/decisions/2026-10-30-lane-and-gate-priority.md:17` (`spawnClaude`)
  - `docs/architecture/decisions/2026-10-30-lanes-wait-for-auto-mode-proof.md:18` (`LANE_PERMISSION_MODE`)
  - `docs/architecture/decisions/2026-10-30-a-slow-start-is-not-a-signed-out-account.md:9` (the path)
  - The same file, `:12`: "starts the session again, once (`START_ATTEMPTS = 2`, `startWithRetry`)" becomes "starts
    the session again, up to three starts that wait 30, 60 and 120 s (`START_ATTEMPTS = START_WAITS_MS.length`, the
    retry loop in `sessions/claude-session.ts`)". Leave the rest of the record as it is; the PR names this
    correction.
  - `docs/architecture/03-trust-boundaries.md:139`

  Each names `sessions/claude-session.ts`, or `claude-query-options.ts` for an option. The PR body lists each
  correction.
- Modify: `apps/daemon/src/sessions/claude-adapter.live.test.ts` (one new `it`)

- [ ] **Step 1: Docs.** Make the edits above. Run:
  `pnpm exec vitest run --project repo tests/repo/src/architecture-docs.test.ts tests/repo/src/agent-docs.test.ts && pnpm format:check`.
  Expected: PASS.

- [ ] **Step 2: A live Plan turn** **(call)**. No live test covers Plan's preflight against the real SDK, and this
  milestone rewires it. In the live describe (`:114`), add
  `it('runs one Plan turn on the real claude, with no settings, plugin or project server')`:
  - It runs `adapter.startShape` with an unsandboxed spec built like the lane case at `:115`, and a one-line prompt.
  - It expects `started`, then `turn_complete`.
  - It calls `stop()`, and expects the last event to be `ended` `stopped`.

  To prove it red, run it once with `model: 'not-a-model'` and see it fail on `model_refused`. Then run it for real:

Run: `TENDB_LIVE_CLAUDE=1 pnpm --filter @10db/daemon exec vitest run src/sessions/claude-adapter.live.test.ts`
Expected: every live case passes, the four lane cases and the new Plan case. This costs a few turns on the
builder's subscription. If no signed-in subscription is reachable, skip the run, and say so in the PR, so the
builder runs it in the morning.

- [ ] **Step 3: Run it before review.**
  1. `pnpm dev`. With the `/browse` skill, open Plan on a project with a Claude account. Send one message, see the
     reply, and press Stop on a second message mid-turn.
  2. Start one task on the Board and see its lane start and run.

  Expected: the same behaviour as on `main`, and no new log line at `warn` or above in the dev daemon's log.

- [ ] **Step 4: Commit.**

```bash
git add apps/daemon/AGENTS.md docs/architecture/decisions/2026-11-02-shape-session-and-convert.md docs/architecture/decisions/2026-10-30-lane-and-gate-priority.md docs/architecture/decisions/2026-10-30-lanes-wait-for-auto-mode-proof.md docs/architecture/decisions/2026-10-30-a-slow-start-is-not-a-signed-out-account.md docs/architecture/03-trust-boundaries.md apps/daemon/src/sessions/claude-adapter.live.test.ts && git commit -m 'docs(daemon): name the one claude session core, and a live plan turn

Value: protects=a Plan session proves its account and runs a turn on the real Claude Code;
fails_when=the merged preflight breaks the explore profile against the real SDK, which the scripted query cannot show;
why_new=the live tests run lanes only;
no_claim=Bedrock, API-key and gateway accounts

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

- [ ] **Step 5: Gate, push, PR.** Run `make gate` once. Expected: the last line is `GATE PASS …`. Then
  `git push -u origin feat/sessions-m2a` and `gh pr create` with:
  - Title: `refactor(daemon): one claude session core with a lane and an explore profile, and one scripted fake`
  - Body:
    - the difference table's per-profile rows, as a list
    - the live run's result, or that it was skipped
    - the click-through result
    - the decision corrections, the three-start correction among them
    - ends with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| A1: a later `init` emits a second `started` in Plan | Table row 31; Task 1 row "emits a second started with the new session id at a later init" |
| A1: a rate limit with no reset time stays null in Plan | Table row 32; Task 1 row "leaves a rate limit with no reset time at null" |
| A1: row 11's window (a stop on a hung interrupt as a wrong account arrives) | Task 1 row "ends stopped, not account_refused, when a stop is waiting on a hung interrupt as a wrong account arrives" |
| A2: three starts; the decision still says `START_ATTEMPTS = 2` | Task 5 (no longer a call: spec §5.4, code and tests agree on three); Task 7 corrects `2026-10-30-a-slow-start-is-not-a-signed-out-account.md:12` |
| A3: rows that couldn't be written as described | Task 1: `then: 'hang'` on the 30 s and stop rows; a 2,000 ms `it` timeout on the "exits before it reports an account" row; a commented `as never` cast on the canUseTool row |
| A4: log lines pinned or the constraint weakened | Task 1: one `captureLogs` row per profile; Global Constraints names what pins logs, and leaves debug stderr lines to the port |
| A5: `apps/daemon/AGENTS.md:103` says "in the Claude adapter" | Task 7 Files |
| A6: parity | Global Constraints, "Provider parity" |
| Round 2: the row-11 test couldn't go red under `then: 'hang'` | Task 1: that row now uses `then: 'stall'`, so under the mutation the account check runs and the session ends `account_refused` |
| Line refs: `laneSandbox`, `createFakeShapeSession` | Task 1 Interfaces (`:308`); Task 6 Files (`fake-shape.ts:182-198` and `:202-306`) |
