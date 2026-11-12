# Sessions M2b: `AgentAdapter.open`, capabilities and an open `providerOf`: Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** One adapter seam. `AgentAdapter.open(spec)` replaces `start` and `startShape`, every adapter reports
`AgentCapabilities`, and `providerOf` becomes a lookup table, so a later agent is one more adapter and one more row.
The builder sees no change.

**Architecture:** `SessionAdapter` is renamed `AgentAdapter`. `SessionSpec` and `ShapeSessionSpec` merge into
`AgentSessionSpec`: a shared core plus a `profile` union (`lane` or `explore`). Each adapter dispatches on
`profile.kind`. Capabilities are pure tables in `sessions/capabilities.ts`, typed by a zod DTO in
`packages/contracts`. The routed adapter becomes a registry keyed by `providerOf`'s adapter id. The first daemon
reader of a capability is the runner's read-back, which stops branching on the provider.

**Tech Stack:** TypeScript, zod 4.6.7, Vitest, ESLint flat config.

**Spec:** `docs/superpowers/specs/2026-11-11-10db-sessions-design.md` (v3): §3 S5 and S6, §5.1 (the seam),
§5.3 (capabilities), §12 (M2b), §13 (pure rung: the capability tables and the invariant), §14 (the M2b record).
Research: `docs/architecture/research/2026-11-11-sessions-research.md` T1 §3 and §4.

## Starting point: M2a has merged

M2a (`2026-11-12-10db-sessions-m2a-claude-core.md`) leaves these. Task 2, Step 1 checks them.

- **`claude-adapter.ts`** keeps only the adapter surface: `createClaudeAdapter(opts): SessionAdapter`,
  `probeAccount` and `complete`.
  - `start` refuses an unsandboxed lane, then calls
    `startClaudeSession({ profile: 'lane', spec, pluginDir, lanePermissionMode, signInCheck }, opts, runQuery, LANE_STARTS)`.
  - `startShape` calls `startShapeSession(spec, deps)`.
- **`claude-session.ts`** holds the loop:
  - `startClaudeSession(session: ClaudeSession, deps, runQuery, starts)`, where `ClaudeSession` is a union on
    `profile: 'lane' | 'explore'` whose `spec` is a `SessionSpec` or a `ShapeSessionSpec`
  - `startShapeSession(spec: ShapeSessionSpec, deps: ShapeSessionDeps)`
  - `buildQueryOptions(spec, deps)`
  - `LANE_STARTS`, three starts of 30, 60 and 120 s, and `EXPLORE_STARTS`, one start
- **`claude-query-options.ts`** holds `claudeQueryOptions(profile: ClaudeProfile, sandbox)` and its pure table.
  **`claude-session-hooks.ts`** holds `preToolUseHook`, `canUseToolBridge` and `measurementHooks`.
- **Both test files stay.** `claude-adapter.test.ts` tests the lane and the adapter. `claude-shape.test.ts` tests
  the explore profile through `startShapeSession`.
- **The fake:**
  - `fake-script.ts` holds `FakeStep`, `FakeScriptBook` and `loadFakeScriptBook`.
  - `fake-session.ts` holds `createFakeSessionCore`,
    `runFakeLaneSession(spec: SessionSpec, context: FakeLaneContext)` and
    `runFakeExploreSession(spec: ShapeSessionSpec, behaviour, providerSessionId)`.
  - `fake-plan-script.ts` holds `scriptedShapeBehaviour`.
  - `fake-adapter.ts` keeps the class, its records and a thin `start` and `startShape`.
- **What M2a hands to M2b:** the fake's "one open handle" assertion, keyed by provider session id (Task 3).

## Global Constraints

- Root `AGENTS.md`, and the `AGENTS.md` of `apps/daemon`, `apps/desktop` and `packages/contracts`. Also
  `.claude/rules/code-style.md` and `.claude/rules/testing.md`.
- Work in `../10db-worktrees/sessions-m2b` on branch `feat/sessions-m2b`, from `origin/main` after M2a merged.
  Run the tasks in order.
- Name every path in each commit, with single-quoted `-m`. Messages are Conventional Commits and end with
  `Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>`.
- **No behaviour change.** Every existing test stays green with its assertions unchanged. Only how it calls the
  adapter changes (`open` and a profile in place of `start` or `startShape`).
- **Add no product rule the spec doesn't state.** Plan on a ChatGPT account stays refused. `open` with an explore
  profile on Codex ends at once with today's message. M5b lifts that.
- The UI never reads a provider (S5). This milestone adds no UI.
- `as const` objects, not enums. No `as` casts, no `!`, no `any`. Exhaustive switches over `profile.kind`.
- `packages/contracts` stays zod-only, with no `node:*` imports.
- The decision record goes in `docs/architecture/decisions/` as its own file. `decisions.md` is closed.
- An agent in a 10db lane runs only the checks for what it changed, never `make gate`. The last task runs the gate
  once on the finished branch.

## Calls made in this plan

Each is marked **(call)** where it is made.

1. **The adapter id is the existing `Provider` vocabulary.** `providerOf` returns `Provider` (`'claude' | 'codex'`)
   from a table, and `AgentCapabilities.harness` reuses it. A new agent adds one `Provider` value, one row in the
   table and one adapter. No new id type.
2. **`conversationId` waits for M4a.** The spec's core lists it, but `ConversationId` doesn't exist until M4a mints
   it. M4a adds the field to `AgentSessionCore`.
3. **The explore profile keeps `shapeId`** for its log context and the fake, until M4b gives every explore session
   a conversation.
4. **`preToolUse` in the core takes the explore form:** `(req: ShapeToolRequest) => ShapeVerdict`. A lane's
   `GuardVerdict` is assignable to it, and the Codex guard's `allow` branch already accepts both.
5. **The `Shape*` type names stay** (`ShapeImage`, `ShapeToolRequest`, `ShapeVerdict`, `ShapeAgentDefinition`).
   Renaming them would touch Plan's code for no behaviour. The core uses them as they are.
6. **`takeoverCommand` is added in M7**, with the takeover it builds (§7.5).
7. **Capabilities take `Pick<AccountExpectation, 'kind'>`.** Each call site passes the expectation it already has.
8. **The pinned and unavailable adapters take the harness's capabilities function.** A copy that is still
   downloading still reports what its agent can do.
9. **ESLint enforces S5 in the desktop.** `providerOf` and `Provider` can't be imported under `apps/desktop/src`.
10. **`AgentCapabilitiesDto` is registered in `CONTRACT_SCHEMAS` now**, before M4 puts it on `ConversationDto`. That
    way the generated schema exists when the first route needs it.
11. **`startShapeSession` keeps its name, retyped to take an `ExploreSessionSpec`.** It stays the explore entry that
    `open` and `claude-shape.test.ts` call, so that file's tests change only their spec helper.
12. **The one-open-handle assertion is a thrown `FakeSessionClashError`.** It is keyed by the provider session id
    the fake runs under: the resume id, or the one it mints. A handle counts as open until its `ended` is emitted. A
    refused start never opens. An existing test that trips it is a finding, not a test to loosen: it would be two
    writers on one agent session.

## Review Focus

1. **A Plan conversation on a ChatGPT account** still ends at once with today's refusal through
   `open({ profile: { kind: 'explore' } })` on Codex. Covered by the existing `codex-adapter.test.ts` row (`:211`),
   rewritten to `open` in Task 2.
2. **An unsandboxed lane on Claude** is still refused (`UNSANDBOXED_REFUSAL`) when it comes through `open`. The
   existing `claude-adapter.test.ts` row (M2a's row 30) keeps that, rewritten in Task 2.
3. **An agent copy still downloading.** `capabilities` still answers from the harness table, and `open` ends with
   the download message. Test in Task 2 (`pinned-adapter.test.ts`).
4. **A Claude project after a restart.** Read-back is skipped because `readBack` is false. A Codex one still reads.
   Covered by the `read-back.test.ts` rows at `:148-:250`, whose hand stub (`:94`, `:107`, `:289`) gains
   `capabilities: (a) => capabilitiesOf(a.kind)`. Task 4, Step 3 proves the Claude row goes red when Claude reports
   `readBack: true`.
5. **Plan's Read-counting hooks** (`postToolUse`, `toolFailed`) still reach the explore session after the reshape.
   Covered by `claude-shape.test.ts:373-530`, kept in Task 2, and by `shape/service.test.ts`.

---

### Task 1: Capabilities: the DTO, the per-provider tables and the invariant

**Files:**

- Create: `packages/contracts/src/agent-capabilities.ts`
- Modify: `packages/contracts/src/index.ts`, plus `packages/contracts/src/json-schema.ts` (`CONTRACT_SCHEMAS`:
  `'agent-capabilities-dto'`)
- Create: `packages/contracts/generated/agent-capabilities-dto.schema.json` (generated)
- Create: `apps/daemon/src/sessions/capabilities.ts`, `apps/daemon/src/sessions/capabilities.test.ts`
- Modify: `apps/daemon/src/sessions/index.ts` (exports)

**Interfaces:**

- Produces, in `@10db/contracts`:
  - `SteerMode = { Inject: 'inject', Queue: 'queue' } as const`
  - `ModelSwitch = { NextTurn: 'next_turn', None: 'none' } as const`
  - `ImageFormat = { Png: 'png', Jpeg: 'jpeg', Webp: 'webp' } as const`
  - `AgentCapabilitiesDto`, a `z.object` with exactly §5.3's fields:
    - `harness: z.enum(Provider)`, `label: z.string().min(1)`, `steer: z.enum(SteerMode)`
    - `receipts`, `readBack`, `slashCommands`, `plan`, `reasoning`, `subagents`, `takeover`, `costUsd`: booleans
    - `images: z.array(z.enum(ImageFormat))`, `modelSwitch: z.enum(ModelSwitch)`
- Produces, in `apps/daemon/src/sessions/capabilities.ts`:
  - `export type AgentCapabilities = AgentCapabilitiesDto` (re-exported from `sessions/types.ts` in Task 2)
  - `claudeCapabilities(kind: SupportedAccountKind): AgentCapabilities`
  - `codexCapabilities(kind: SupportedAccountKind): AgentCapabilities`
  - `capabilitiesOf(kind: SupportedAccountKind): AgentCapabilities`. It looks up
    `CAPABILITIES_BY_ADAPTER: Readonly<Record<Provider, (kind) => AgentCapabilities>>` by `providerOf(kind)`. The
    fake uses it, because it stands in for both agents.

- [ ] **Step 1: Write the failing tests** in `capabilities.test.ts`

```ts
const CLAUDE = {
  harness: 'claude', label: 'Claude Code', steer: 'inject', receipts: true, readBack: false,
  images: ['png', 'jpeg', 'webp'], slashCommands: true, plan: true, reasoning: true, subagents: true,
  modelSwitch: 'next_turn', takeover: true,
} as const;
const CODEX = { ...CLAUDE, harness: 'codex', label: 'Codex', readBack: true, subagents: false, costUsd: false };

it.each([
  ['claude_subscription', { ...CLAUDE, costUsd: false }],
  ['anthropic_api_key', { ...CLAUDE, costUsd: true }],
  ['bedrock', { ...CLAUDE, costUsd: true }],
  ['gateway', { ...CLAUDE, costUsd: true }],
  ['codex_signin', CODEX],
] as const)('%s runs on an agent that can do what spec §5.3 says', (kind, expected) => {
  expect(capabilitiesOf(kind)).toEqual(expected);
  expect(AgentCapabilitiesDto.parse(capabilitiesOf(kind))).toEqual(expected);
});

// Delivery rule 3 (spec §6.2): a message injected mid-turn counts as delivered only by a receipt.
it.each(SUPPORTED_ACCOUNT_KINDS.flatMap((kind) => [
  [`claude on ${kind}`, claudeCapabilities(kind)],
  [`codex on ${kind}`, codexCapabilities(kind)],
]))('%s: an adapter that injects reports receipts', (_name, caps) => {
  expect(caps.steer !== 'inject' || caps.receipts).toBe(true);
});
```

Task 2 adds rows for every adapter object to the invariant table.

- [ ] **Step 2: Run them and watch them fail**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/capabilities.test.ts`
Expected: FAIL, because `./capabilities` does not exist.

- [ ] **Step 3: Implement** the contracts file and `capabilities.ts` with the values above. `costUsd` is
  `isMetered(kind)` for Claude and `false` for Codex. Export the DTO and the three `as const` objects from the
  contracts index. Register `'agent-capabilities-dto': AgentCapabilitiesDto` (call 10), then run
  `pnpm --filter @10db/contracts generate`.

- [ ] **Step 4: Run the tests, then prove the invariant can go red**

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/capabilities.test.ts`
Expected: PASS.

Then set `receipts: false` in `codexCapabilities` and run again. Expected: FAIL on every `codex on …` row of the
invariant, and on the `codex_signin` table row. Revert the change. Run once more: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/contracts/src/agent-capabilities.ts packages/contracts/src/index.ts packages/contracts/src/json-schema.ts packages/contracts/generated/agent-capabilities-dto.schema.json apps/daemon/src/sessions/capabilities.ts apps/daemon/src/sessions/capabilities.test.ts apps/daemon/src/sessions/index.ts && git commit -m 'feat(daemon): each agent reports what it can do, and inject requires receipts

Value: protects=the per-provider capability table of spec 5.3 and the rule that an adapter that injects reports receipts; fails_when=a capability flips (Codex loses readBack, a Claude kind gains costUsd wrongly) or an adapter injects without receipts; why_new=no capability exists yet; no_claim=that an adapter behaves as its table says (its own tests cover that)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 2: `AgentAdapter.open` with `AgentSessionSpec` on every adapter and caller

This is one vertical slice. It is a mechanical change that typecheck drives, and the existing suites are its tests.

**Files:**

- Modify: `apps/daemon/src/sessions/types.ts` (the seam types)
- Modify, in `apps/daemon/src/sessions/`:
  - **Claude:**
    - `claude-adapter.ts` (`open` and `capabilities`)
    - `claude-session.ts` (`ClaudeSession.spec` becomes `LaneSessionSpec` or `ExploreSessionSpec`, and
      `startShapeSession(spec: ExploreSessionSpec, deps)`, call 11; the lane's judge answers through
      `toShapeHookOutput`)
    - `claude-session-hooks.ts` (`measurementHooks`'s `Pick` over `AgentSessionSpec`)
  - **Codex:**
    - `codex-adapter.ts`
    - `codex-session.ts` (`startCodexSession(spec: LaneSessionSpec, …)` at `:200`)
    - `codex-guard.ts:140`
    - `codex-lane-config.ts:39` (`codexThreadConfig(spec: LaneSessionSpec)`)
  - **The fake:** `fake-adapter.ts`, and `fake-session.ts` (`runFakeLaneSession(spec: LaneSessionSpec, …)` and
    `runFakeExploreSession(spec: ExploreSessionSpec, …)`)
  - **The rest:** `unavailable-adapter.ts`, `pinned-adapter.ts`, `routed-adapter.ts`, `index.ts`
- Modify (callers):
  - `apps/daemon/src/runner/runner.ts:2337` (the lane spec), `runner/read-back.ts:44` (type only)
  - `shape/service.ts:1126,1267` (the explore spec), `shape/service-fixture.ts`
  - `main.ts:125-153`, `daemon/start.ts:283`, `daemon/area-namer.ts:15`
  - `accounts/list-refresh.ts:35`, `accounts/preparer.ts:66`, `accounts/service.ts:142`
  - `delivery/pass-review.ts:63,67`
- Modify (tests that call the adapter): `sessions/claude-adapter.test.ts`, `claude-shape.test.ts`,
  `fake-adapter.test.ts`, `routed-adapter.test.ts`, `pinned-adapter.test.ts`, `unavailable-adapter.test.ts`,
  `codex-adapter.test.ts:211`, `runner/lane-messages.test.ts:94`, and any other file
  `git grep -l 'SessionAdapter\|startShape\|\.start(spec'` lists
- Modify: `apps/daemon/src/sessions/capabilities.test.ts` (rows for every adapter)

**Interfaces:**

- Consumes: Task 1's `claudeCapabilities`, `codexCapabilities` and `capabilitiesOf`.
- Produces, in `sessions/types.ts` (exported through `sessions/index.ts`):

```ts
export const AgentProfileKind = { Lane: 'lane', Explore: 'explore' } as const;

export interface AgentSessionCore {
  readonly sessionId: SessionId;
  readonly cwd: string;
  readonly prompt: string;
  readonly images?: readonly ShapeImage[];
  readonly promptUuid?: string;
  readonly model: string;
  readonly effort: Effort;
  readonly resumeProviderSessionId: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly account: AccountExpectation;
  readonly mcp: { readonly url: string; readonly token: string; readonly toolTimeoutMs: number };
  readonly sandbox: LaneSandboxSpec | null;
  readonly projectMcpServers: Readonly<Record<string, SessionMcpServer>>;
  preToolUse(req: ShapeToolRequest): ShapeVerdict;                       // (call 4)
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
  readonly postToolUse?: (req: ShapeToolResult) => void;
  readonly toolFailed?: (req: ShapeToolRequest) => void;
}
export interface LaneProfile {
  readonly kind: typeof AgentProfileKind.Lane;
  readonly workstreamId: WorkstreamId;
  readonly sequence: number;
  readonly allowedTools: readonly string[];
  readonly lanePermissionMode?: LanePermissionMode;
}
export interface ExploreProfile {
  readonly kind: typeof AgentProfileKind.Explore;
  readonly shapeId: ShapeId;                                              // (call 3)
  readonly systemPrompt: string;
  readonly tools: readonly string[];
  readonly allowedTools: readonly string[];
  readonly disallowedTools: readonly string[];
  readonly agents: Readonly<Record<string, ShapeAgentDefinition>>;
}
export type AgentProfile = LaneProfile | ExploreProfile;
export interface AgentSessionSpec extends AgentSessionCore { readonly profile: AgentProfile }
export type LaneSessionSpec = AgentSessionSpec & { readonly profile: LaneProfile };
export type ExploreSessionSpec = AgentSessionSpec & { readonly profile: ExploreProfile };

export interface AgentAdapter {
  capabilities(account: Pick<AccountExpectation, 'kind'>): AgentCapabilities;
  open(spec: AgentSessionSpec): SessionHandle;
  complete(spec: CompletionSpec): Promise<string>;
  probeAccount(probe: AccountProbeSpec): Promise<SeenAccount>;
  readClientUuids(spec: ConversationReadSpec): Promise<readonly string[]>;
  startLogin(login: AccountProbeSpec): Promise<AccountLogin>;
}
```

- Removed: `SessionAdapter`, `SessionSpec`, `ShapeSessionSpec`, `ShapeSessionHandle`.
- `createPinnedAdapter(source, build, capabilities: (account: Pick<AccountExpectation, 'kind'>) =>
  AgentCapabilities)` and `createUnavailableAdapter(message, capabilities)` take the harness's function (call 8).
  `main.ts` passes `(a) => claudeCapabilities(a.kind)` and `(a) => codexCapabilities(a.kind)`.
- `FakeAdapter.capabilities(account)` returns `capabilitiesOf(account.kind)`. `FakeAdapter.open` switches on
  `spec.profile.kind`:
  - The lane branch is today's `start`, around `runFakeLaneSession`.
  - The explore branch is today's `startShape`, around `runFakeExploreSession`.

  `prompts`, `shapeSessions` and every other record keep their shape. `shapeSessions[].spec` becomes an
  `ExploreSessionSpec`.

- [ ] **Step 1: Check the starting point.** Run
  `git grep -n 'export function startClaudeSession\|export function startShapeSession\|export function claudeQueryOptions\|export function runFake' apps/daemon/src/sessions`.
  Expected: one hit each, in the files named under "Starting point". If M2a landed a name differently, use M2a's
  name and say so in the commit body. M2a's `ClaudeProfile` stays as it is: the adapter still builds it from the
  spec's profile and its own options.

- [ ] **Step 2: Write the new rows first.**
  - **`pinned-adapter.test.ts`**, in the existing "refuses with the reason while the copy is not ready" test: while
    not ready, `adapter.capabilities({ kind: 'codex_signin' })` equals `codexCapabilities('codex_signin')`.
  - **`routed-adapter.test.ts`.** Give `recording(name)` a `capabilities` that returns
    `{ ...codexCapabilities('codex_signin'), label: name }`. Then add:

    ```ts
    it.each(SUPPORTED_ACCOUNT_KINDS)('asks the agent of %s what it can do', (kind) => {
      const routed = createRoutedAdapter({ claude: recording('claude'), codex: recording('codex') });
      expect(routed.capabilities({ kind }).label).toBe(providerOf(kind));
    });
    ```

  - **`capabilities.test.ts`.** The invariant table gains one row per adapter object and kind. Each row calls
    `.capabilities({ kind })` on:
    - `new FakeAdapter({})`
    - `createUnavailableAdapter('x', (a) => claudeCapabilities(a.kind))`
    - `createRoutedAdapter` over two unavailable adapters, one built with each harness's function

  Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/pinned-adapter.test.ts src/sessions/routed-adapter.test.ts src/sessions/capabilities.test.ts`
  Expected: FAIL, because no adapter has `capabilities`.

- [ ] **Step 3: Change the types in `sessions/types.ts`** as in the Interfaces block. Then let
  `pnpm --filter @10db/daemon typecheck` list every break.

- [ ] **Step 4: Move each adapter onto `open`.**
  - **Claude** (`claude-adapter.ts`):
    - `open` is an exhaustive `switch (spec.profile.kind)`.
    - The lane branch is today's `start`: the unsandboxed refusal, then `startClaudeSession(… LANE_STARTS)`.
    - The explore branch is `startShapeSession(spec, …)`.
    - The lane's judge in `claude-session.ts` answers through `toShapeHookOutput`. The core's `preToolUse` now
      returns a `ShapeVerdict`, and `toShapeHookOutput` handles a plain `GuardVerdict` exactly as `toHookOutput`
      did.
  - **Codex** (`codex-adapter.ts:106-117`): the lane branch is `startCodexSession`. The explore branch is
    `endedAtOnce(NO_BRAINSTORM)`, unchanged.
  - **The fake, the unavailable adapter, the pinned adapter and the routed adapter** each get `open` and
    `capabilities`. The routed adapter's `capabilities` delegates as its other methods do.

- [ ] **Step 5: Move the callers.**
  - `runner.ts:2337` builds `{ ...core, profile: { kind: 'lane', workstreamId: id, sequence, allowedTools,
    lanePermissionMode } }`. The fields are today's, and `sandbox` becomes `laneSession?.spec ?? null`.
  - `shape/service.ts:1126` builds `{ ...core, profile: { kind: 'explore', shapeId, systemPrompt, tools,
    allowedTools, disallowedTools, agents } }`.
  - Everywhere else the type name changes from `SessionAdapter` to `AgentAdapter`.

- [ ] **Step 6: Move the tests.** Each test's spec helper now builds an `AgentSessionSpec`, and
  `adapter.start(…)` and `adapter.startShape(…)` become `adapter.open(…)`. In `routed-adapter.test.ts`, `METHODS`
  becomes `['open', 'capabilities', 'complete', 'probeAccount', 'startLogin', 'readClientUuids']`, and `callAll`
  opens one lane and one explore spec. No existing assertion changes.

- [ ] **Step 7: Run the affected suites**

Run: `pnpm --filter @10db/daemon typecheck && pnpm --filter @10db/daemon exec vitest run src/sessions src/runner/lane-messages.test.ts src/runner/read-back.test.ts src/shape src/accounts src/delivery/pass-review.test.ts src/daemon`
Expected: PASS, including Step 2's new rows, with no existing assertion edited. If an existing assertion would
need an edit, stop: that is a behaviour change.

- [ ] **Step 8: Commit**

```bash
git add apps/daemon/src/sessions apps/daemon/src/runner/runner.ts apps/daemon/src/runner/read-back.ts apps/daemon/src/runner/lane-messages.test.ts apps/daemon/src/shape/service.ts apps/daemon/src/shape/service-fixture.ts apps/daemon/src/main.ts apps/daemon/src/daemon/start.ts apps/daemon/src/daemon/area-namer.ts apps/daemon/src/accounts/list-refresh.ts apps/daemon/src/accounts/preparer.ts apps/daemon/src/accounts/service.ts apps/daemon/src/delivery/pass-review.ts && git commit -m 'refactor(daemon): one AgentAdapter.open over a lane or explore profile replaces start and startShape

Value: protects=each adapter answering capabilities: the routed one by the account kind'"'"'s agent, the pinned one from its harness table while its copy downloads; fails_when=the router asks the wrong agent, or a downloading copy reports nothing or the other agent'"'"'s table; why_new=no adapter had capabilities; no_claim=that the tables are right (capabilities.test.ts, Task 1)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

Name every other file Step 6 touched in the same `git add`. The value card covers Step 2's routed and pinned rows. The invariant rows are new rows in Task 1's table, and need none.

---

### Task 3: The fake allows one open handle per agent session

The fake is the test boundary for every daemon test, so this assertion guards every pipeline test against two
owners opening one agent session (spec §5.4, §6.7 last paragraph, §13). Take it in small red-first steps.

**Files:**

- Modify: `apps/daemon/src/sessions/fake-session.ts`, `apps/daemon/src/sessions/fake-adapter.ts`,
  `apps/daemon/src/sessions/fake-adapter.test.ts`

**Interfaces:**

- Produces, in `fake-session.ts`:
  - `class FakeSessionClashError extends Error`, with `name = 'FakeSessionClashError'`. Its message names the
    provider session id.
  - `fakeProviderSessionId(spec: AgentSessionSpec, minted: string): string`. It returns
    `spec.resumeProviderSessionId ?? minted`. Both drivers and the adapter use it, so the id the assertion keys on
    is the one the session reports in `started`.
  - This changes the fake: a resumed fake Plan session now reports its resume id in `started`, where it used to
    report a fresh `fake-shape-<n>`. If a shape test reads that id, it shows in Step 3. The commit says so.
- `FakeAdapter` keeps a private `Set<string>` of open provider session ids:
  - `open` throws `FakeSessionClashError` before it records or starts anything when the id is in the set (call 12).
  - Otherwise it adds the id, and removes it in the session core's `onEnd`.
  - A start that ends at once on an account refusal never adds its id.

- [ ] **Step 1: Write the failing rows** in `fake-adapter.test.ts`, under a new `describe('one open handle per agent session')`:
  - **Two lanes, both resuming `p1`.** The second `open` throws `FakeSessionClashError`, whose message contains
    `p1`.
  - **The first is stopped, then a lane resumes `p1`.** It opens. Await the first's `ended` before the second
    `open`.
  - **A lane on `p1` is open, and an explore session resumes `p1`.** It throws: the key is the agent session, not
    the profile.
  - **Two fresh lanes, with no resume.** Both open, each under its own minted id.
  - **An account-refused start on `p1`, then a lane resuming `p1`.** It opens.

Run: `pnpm --filter @10db/daemon exec vitest run src/sessions/fake-adapter.test.ts -t 'one open handle'`
Expected: FAIL, because nothing throws.

- [ ] **Step 2: Implement** the set, the error and `fakeProviderSessionId`. Run Step 1's command. Expected: PASS.

- [ ] **Step 3: Run every daemon test that drives the fake**

Run: `pnpm exec vitest run --project daemon && pnpm exec vitest run --project daemon-delivery`
Expected: PASS. If a test throws `FakeSessionClashError`, stop. Report the test and the two owners to the
coordinator: the runner or Plan opened a second session on a live one. That is a decision for the builder. Do not
loosen the assertion or change the test.

- [ ] **Step 4: Commit**

```bash
git add apps/daemon/src/sessions/fake-session.ts apps/daemon/src/sessions/fake-adapter.ts apps/daemon/src/sessions/fake-adapter.test.ts && git commit -m 'test(daemon): the fake refuses a second open handle on one agent session

The fake Plan session now reports its resume id in `started` when it resumes. It used to report a fresh
`fake-shape-<n>`: that is what `fakeProviderSessionId` changes, and only the fake sees it.

Value: protects=one writer per agent session across every pipeline test (spec 5.4, 6.7); fails_when=the runner or Plan opens a session on a provider session id whose handle has not ended; why_new=nothing checked it, and the Claude core and the fake each became one in M2a; no_claim=that a real agent refuses a second writer (it does not; it interleaves the transcript)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 4: An open `providerOf`, a routed registry, read-back by capability, and the UI rule

**Files:**

- Modify: `packages/contracts/src/accounts.ts:30-40` (`providerOf`)
- Modify: `apps/daemon/src/sessions/routed-adapter.ts`
- Modify: `apps/daemon/src/runner/read-back.ts:44,69`, `apps/daemon/src/runner/read-back.test.ts:94,107,289`
- Modify: `eslint.config.js` (the `apps/desktop/src/**` block at `:70`)
- Create: `docs/architecture/decisions/./2026-11-12-one-adapter-seam-with-capabilities.md`
- Modify: `apps/daemon/AGENTS.md:105` (the routed-adapter line) and `:285` (Plan's session starts through
  `AgentAdapter.open` with the explore profile, not `startShape`)

**Interfaces:**

- Produces, in `@10db/contracts`:
  - `ADAPTER_OF_KIND`, typed as `{ … } as const satisfies Readonly<Record<SupportedAccountKind, Provider>>`
  - `providerOf(kind) = ADAPTER_OF_KIND[kind]`. Its signature is unchanged (call 1).
- Produces: `createRoutedAdapter(adapters: Readonly<Record<Provider, AgentAdapter>>): AgentAdapter`. Every method
  goes to `adapters[providerOf(kind)]`. The `main.ts:134` call already passes `{ claude, codex }`, which keeps
  compiling.
- `ReadBackDeps.adapter` becomes `Pick<AgentAdapter, 'readClientUuids' | 'capabilities'>`.

- [ ] **Step 1: Write the failing lint check.** Add to the desktop block of `eslint.config.js`:

```js
'no-restricted-imports': ['error', {
  patterns: [{ regex: '^@10db/[^/]+/.+', message: 'Import a workspace package through its entry point only.' }],
  paths: [{
    name: '@10db/contracts',
    importNames: ['providerOf', 'Provider'],
    message: 'The UI reads an agent\'s capabilities, never its provider (docs/architecture/decisions/./2026-11-12-one-adapter-seam-with-capabilities.md).',
  }],
}],
```

The block must repeat the workspace pattern, because a later flat-config block replaces the rule's options.

Create the scratch file `apps/desktop/src/provider-probe.ts` holding `import { providerOf } from '@10db/contracts';`
and `export const probe = providerOf;`.

Run: `pnpm exec eslint apps/desktop/src/provider-probe.ts`
Expected: FAIL, with the message above. Delete the scratch file. Then run
`pnpm exec eslint apps/desktop/src`. Expected: PASS, because the desktop imports neither name today.

- [ ] **Step 2: Make `providerOf` a table and the routed adapter a registry.** This is a refactor that the existing
  tests guard: Task 2's routed rows, and `packages/contracts/src/accounts.test.ts:193`.
  - `routed-adapter.ts` builds `by = (a) => adapters[providerOf(a.kind)]` and drops the `Provider.Codex` comparison.
  - The doc comment says a new agent is one `Provider` value, one row and one adapter.
  - Both test files stay as they are and stay green.

- [ ] **Step 3: Read back by capability.**
  - In `read-back.ts:69`, replace `providerOf(input.account.kind) !== Provider.Codex` with
    `!deps.adapter.capabilities(input.account).readBack`. Then remove the imports that are now unused.
  - `read-back.test.ts` builds its adapter by hand, typed `Pick<SessionAdapter, 'readClientUuids'>` (`:94`, `:107`,
    `:289`). Widen each to `Pick<AgentAdapter, 'readClientUuids' | 'capabilities'>`, and give each stub
    `capabilities: (a) => capabilitiesOf(a.kind)`.

Run: `pnpm --filter @10db/daemon exec vitest run src/runner/read-back.test.ts src/runner/pass-lane.test.ts src/sessions && pnpm --filter @10db/contracts exec vitest run src/accounts.test.ts`
Expected: PASS, with the row "the project runs on Claude: nothing is read" (`read-back.test.ts:207`) among them.

Then prove that row reads the capability. Set `readBack: true` in `claudeCapabilities` and run
`read-back.test.ts`. Expected: FAIL on `:207`, because a read happens. Revert, and run it again: PASS.

- [ ] **Step 4: Write the decision record**, `docs/architecture/decisions/./2026-11-12-one-adapter-seam-with-capabilities.md`.
  Rename it to the day the PR opens if that is later.

```markdown
# One adapter seam with capabilities, and the UI never reads a provider

- **Date:** 2026-11-12

## Decision

- Every agent is an `AgentAdapter` (`apps/daemon/src/sessions/types.ts`). `open(spec)` starts every session of
  every kind; `start` and `startShape` are gone. `AgentSessionSpec` is a core shared by every session plus a
  `profile`: `lane` (a task's session: workstream, sequence, allowed tools, permission mode) or `explore` (a
  read-only conversation: system prompt, tool lists, agents). Each adapter switches on the profile.
- Each adapter reports `AgentCapabilities` (`AgentCapabilitiesDto` in `@10db/contracts`): harness, label,
  steer (`inject` or `queue`), receipts, read-back, picture formats, slash commands, plan, reasoning, subagents,
  model switching, takeover and dollar cost. The tables are in `sessions/capabilities.ts`, per spec §5.3 of
  `docs/superpowers/specs/2026-11-11-10db-sessions-design.md`.
- A capability says what the agent can do, not what 10db has wired yet. Takeover is built with Open in Terminal,
  model switching between turns with the explore engine, and Codex's slash commands with streaming. Nothing reads
  those three capabilities before their feature exists.
- An adapter that injects a message into a running turn reports receipts. `capabilities.test.ts` checks it for
  every adapter and account kind.
- `providerOf` is a table from account kind to adapter id (the `Provider` vocabulary). The routed adapter is a
  registry keyed by it. A new agent is one `Provider` value, one row and one adapter.
- The daemon reads a capability where it once compared a provider; the runner's read-back reads `readBack`.
- The desktop never imports `providerOf` or `Provider` (ESLint). Every new view that names an agent shows
  `capabilities.label`. Some account settings still choose words by account kind (`views/settings/accounts/`).
  The rule doesn't reach those, and a follow-up task moves them onto capabilities.
- Claude Code stays on the Agent SDK directly and Codex on `codex app-server` directly. Another agent comes through
  the Agent Client Protocol, as its own adapter with its own spec.

## Why

- Two start methods kept two copies of one session's shape, and Plan could not run on Codex without a third.
  One `open` with a profile is the narrowest seam both owners need (research T1 §4,
  `docs/architecture/research/2026-11-11-sessions-research.md`).
- A UI that branches on the provider has to change for every new agent. Capabilities say what the agent can do,
  which is what the UI needs, so Gemini through OpenRouter or any later agent needs no UI change.
- Delivery counts an injected message delivered only by a receipt (spec §6.2 rule 3). An adapter that injects
  without receipts would lose messages, so the rule is a tested invariant, and an agent without receipts queues.
- The guard needs Claude Code's in-process hooks, and Codex's exactly-once receipts need app-server's
  `clientUserMessageId`. ACP v1 carries neither (research T2, T3), so the two built agents stay direct.
- Turned down: an id type separate from `Provider` (two names for one thing), and a `providerOf` kept as a switch
  (each new agent edits a function rather than adding a row).
```

- [ ] **Step 5: Update `apps/daemon/AGENTS.md`.**
  - `:105`: the routed adapter is a registry keyed by `providerOf`'s adapter id, and each adapter reports
    `capabilities` (`sessions/capabilities.ts`).
  - `:285`: a Shape conversation's session opens through `AgentAdapter.open` with the explore profile
    (`sessions/claude-session.ts`).

- [ ] **Step 6: Run the checks for what changed**

Run: `pnpm --filter @10db/contracts exec vitest run && pnpm --filter @10db/daemon exec vitest run src/sessions src/runner/read-back.test.ts && pnpm --filter @10db/daemon typecheck && pnpm exec eslint eslint.config.js apps/desktop/src apps/daemon/src/sessions apps/daemon/src/runner/read-back.ts packages/contracts/src && pnpm --filter ./tests/repo exec vitest run src/architecture-docs.test.ts`
Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add packages/contracts/src/accounts.ts apps/daemon/src/sessions/routed-adapter.ts apps/daemon/src/runner/read-back.ts apps/daemon/src/runner/read-back.test.ts eslint.config.js docs/architecture/decisions/./2026-11-12-one-adapter-seam-with-capabilities.md apps/daemon/AGENTS.md && git commit -m 'feat(daemon): providerOf is a table, the adapters a registry, and the UI may not import a provider

Value: protects=the UI never branching on a provider (S5); fails_when=a desktop file imports providerOf or Provider; why_new=no check stopped it; no_claim=that no UI copy names a provider in text (the M3 and M4 views own that)

Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>'
```

---

### Task 5: Run it, gate it, open the PR

**Files:** none new.

- [ ] **Step 1: Run Plan and the Workbench end to end on the fake**, since both now open sessions through `open`.

Run: `pnpm --filter @10db/desktop e2e -- shape.spec.ts workbench.spec.ts`
Expected: PASS.

- [ ] **Step 2: Run the knip and type checks across the repo**

Run: `pnpm knip && pnpm typecheck`
Expected: PASS. The removed `SessionSpec`, `ShapeSessionSpec` and `ShapeSessionHandle` are referenced nowhere.

- [ ] **Step 3: File the follow-up task** on the Board with the `10db-task` skill: "Account settings name the agent
  from capabilities". It covers `views/settings/accounts/identity-check.tsx:117,135` and `sign-in-steps.tsx:21`,
  which choose words by `AccountKind.CodexSignin`.

- [ ] **Step 4: Review.** Dispatch `code-reviewer` (opus) with this plan, Tasks 1-4 and the base commit. Round 1
  lists every finding. Round 2 checks only those findings and what the fixes broke. Allow at most two fix rounds.

- [ ] **Step 5: Gate**

Run: `make gate`
Expected: `GATE PASS`.

- [ ] **Step 6: Open the PR**

```bash
git push -u origin feat/sessions-m2b && gh pr create --base main --title 'feat(daemon): one AgentAdapter.open with capabilities and an open providerOf' --body 'Sessions M2b (docs/superpowers/specs/2026-11-11-10db-sessions-design.md §5.1, §5.3). No behaviour change: start and startShape become open over a lane or explore profile, each adapter reports capabilities, providerOf is a table, read-back reads a capability, and the desktop may not import a provider. Decision: docs/architecture/decisions/./2026-11-12-one-adapter-seam-with-capabilities.md.

Follow-up task (filed on the Board): the account settings still choose "Codex" or "Claude Code", and "Workspace" or "Organization", by account kind (views/settings/accounts/identity-check.tsx:117,135, sign-in-steps.tsx:21). Move them onto capabilities.label.

🤖 Generated with [Claude Code](https://claude.com/claude-code)'
```

---

## Review round 1: where each finding went

| Finding | Where |
| --- | --- |
| B1: `read-back.test.ts`'s hand stubs lack `capabilities` | Task 4, Step 3: the stubs widen and gain `capabilitiesOf`, a red proof by Claude `readBack: true`, the file is in the commit. Review Focus 4 is corrected. |
| B2: the routed and pinned rows have no value card | Task 2's commit carries a value card for them. |
| B3: the record overclaims labels, and the account settings still branch on kind | The decision record is narrowed to what ESLint enforces. A follow-up task is in Task 5, Step 3, and in the PR body. |
| B4: `fakeProviderSessionId` changes the fake Plan session's resumed id | Task 3's Interfaces and its commit body say so. |
| B5: some capabilities are not wired yet | The decision record says a capability is what the agent can do, and nothing reads `takeover`, `modelSwitch` or Codex `slashCommands` before their milestone. |
| Line refs | `codex-adapter.test.ts:211`. `codex-lane-config.ts:39` is listed under Task 2's files. |
