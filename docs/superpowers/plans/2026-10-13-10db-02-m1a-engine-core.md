# 10db M1a Engine Core Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** The 10db daemon runs the whole factory loop end to end against a scripted fake Claude adapter: tasks become workstreams, workstreams get lanes and claims, sessions hand off at a context threshold, questions and permissions become inbox cards whose answers resume the work, the gate verifies "done", and a `kill -9` mid-step recovers without duplicating any tool operation. An automated acceptance test proves each point.

**Architecture:** `packages/contracts` gains the domain vocabulary: IDs, states, the workstream state machine, DTOs, events, MCP tool schemas and the handoff schema. `packages/db` gains the full schema and synchronous repositories over better-sqlite3. Every write goes through `store.write()`, which updates rows and appends events in one transaction. The daemon is a set of flat modules, each imported only through its `index.ts`:
- `clock`, `log`, `events`, `guard`, `permissions`, `git`, `verify`, `sessions` (the adapter interface plus the fake), `inbox`, `briefing`, `mcp`, `api`, `runner`, `scheduler`, `recovery`, `backups`, `daemon` (the composition root).

M1b plugs the real Claude adapter into the same `SessionAdapter` interface.

**Tech Stack:** As in M0. New dependencies: `ulid` 3.0.2 (contracts), `@modelcontextprotocol/sdk` 1.32.1, `pino` 10.4.0, `ws` 8.22.0 with `@types/ws` 8.18.2 (daemon).

**Spec:** `docs/superpowers/specs/2026-10-13-10db-factory-loop-design.md`. This plan implements §3 (the daemon side), §4 (the tables M1 needs), §5 (the whole lifecycle except takeover and the picker's PM review), §6 (all ten tools), §7 (questions, permissions and flags), §8.1–8.3 (claims, the guard, git through 10db), §12 (testing, error handling, backups) and §1.3 (with the fake adapter). The watcher (§8.4), keep-awake, the Claude adapter, the env builder and the UI are M1b.

**Plan series:** `00-spikes`, `01-m0-scaffold` (must be merged), **`02-m1a-engine-core` (this file)**, `03-m1b-sessions-and-ui`.

## Global Constraints

Everything in M0's Global Constraints still applies. On top of that:
- **The daemon is the only database writer.** All writes go through `StateStore.write(fn)`. `fn` is synchronous, because better-sqlite3 transactions are, and it must not `await`.
- **Every state change updates its row and appends its event in one transaction.** Events are published to subscribers only after commit.
- **Workstream transitions go through `transitionWorkstream`.** It checks `canTransition` and the fencing token. A runner holding a stale fence stops itself.
- **Daemon modules import each other only through `index.ts`.** ESLint enforces this (Task 6).
- **`src/api/**` imports no `node:*` modules and nothing from `@10db/db`.** The desktop typechecks it.
- **Errors that cross the API are `DomainError` subclasses from `@10db/contracts`.** `NotFoundError` maps to 404, `ConflictError` to 409 and `InvalidError` to 400.
- **Assumption defaults are tunable starting heuristics** (spec §15): handoff at 40%, firm nudge at 50% (of a 1M window), long-wait park after 10 minutes, per-provider cap 4, global cap 4, 3 recovery attempts, 3 fix attempts. Each is a project field or a `DaemonOptions` field, never a literal inside logic.
- **The env var prefix is `TENDB_`.** `TENDB_FAKE_SCRIPTS` exists for tests and the M1a dev loop only.

## Review Focus

The five inputs or conditions most likely to bite a person, with the task that pins each:
1. **The answer arrives after the session was parked.** The builder answers a question 20 minutes later, after the long-wait timer ended the session. The answer must re-queue the workstream and reach the agent in the resumed session's prompt; it must not be lost or delivered to a dead waiter. That includes an answer that lands while the parked session is still stopping, and a permission card answered after parking, whose choice must still take effect. The tests are in Task 16 (runner) and Task 12 (inbox).
2. **Two workstreams ask the same question.** One card appears. Answering it resumes both. The test is in Task 12.
3. **The agent retries a `commit` after a crash with the same `opId`.** The tool returns the original SHA and creates no second commit, even if the daemon crashed between the git commit and recording the operation. The test is in Task 8 (git trailer lookup) and Task 14 (the tool).
4. **A file path that escapes the repo** (`../other/x`, an absolute path elsewhere, a symlinked parent). The guard denies it, and so does `commit`, which reuses the guard's symlink-aware `resolveInRepo`. The tests are in Task 6 (guard) and Task 8 (`commit`, including `link/x.ts` through a symlink to outside the repo).
5. **The UI reconnects after missing events.** The WebSocket opened with `?after=<seq>` first replays every event after `seq` and then streams live ones, with no gap and no duplicate at the seam. The test is in Task 15.

---

## File Structure

```
packages/contracts/src/
  ids.ts            branded prefixed ULIDs, mintId
  states.ts         as-const vocabularies (states, kinds, modes)
  workflow.ts       workstream transition table, canTransition, LANE_STATES
  entities.ts       DTO schemas (project, task, workstream, inbox, ...)
  handoff.ts        six-part handoff schema
  events.ts         event envelope
  mcp-tools.ts      the ten tool input/output schemas
  errors.ts         DomainError, NotFoundError, ConflictError, InvalidError
packages/db/src/
  schema.ts         all M1 tables
  store/            write() + events, then one repository file per area
packages/db/drizzle/ 0001_* generated, 0002_decisions_fts custom
apps/daemon/src/
  clock/  guard/  permissions/  git/  verify/  sessions/  inbox/
  briefing/  mcp/  events/  api/  runner/  scheduler/  recovery/
  log/  backups/  daemon/   main.ts  env.ts  paths.ts
apps/daemon/test/
  fixtures.ts                    temp git repo + project helpers
  acceptance.test.ts             §1.3 with the fake adapter, in process
  crash-recovery.test.ts         kill -9 a child daemon mid-step
```

---

### Task 1: Domain contracts

**Files:**
- Create: `packages/contracts/src/ids.ts`, `states.ts`, `workflow.ts`, `entities.ts`, `handoff.ts`, `events.ts`, `mcp-tools.ts`, `errors.ts`
- Modify: `packages/contracts/src/index.ts`, `src/json-schema.ts`, `package.json` (add `ulid`), `AGENTS.md` (allow `ulid`)
- Test: `packages/contracts/src/domain.test.ts`, `packages/contracts/src/workflow.test.ts`

**Interfaces:**
- Produces, all exported from `@10db/contracts`:
  - **IDs:**
    - `mintId(kind)` returns `IdOf<kind>`.
    - Branded ID schemas and types: `ProjectId`, `TaskId`, `WorkstreamId`, `SessionId`, `HandoffId`, `ClaimId`, `InboxItemId`, `ToolOpId`, `EvidenceId`, `DecisionId`, `DeviationId`, `SourceId`, `ProposalId`, `PermissionRuleId`.
  - **Vocabularies** (`as const` objects plus derived types): `WorkstreamState`, `InboxKind`, `InboxState`, `ClaimKind`, `BillingMode`, `Provider`, `Effort`, `TaskStatus`, `BoardStatus`, `PermissionChoice`, `Urgency`, `QuestionCategory`, `DECISION_CATEGORIES`, `ProposalKind`, `Severity`, `SourceKind`, `EvidenceKind`, `SessionMode`.
  - **Workflow:** `WORKSTREAM_TRANSITIONS`, `canTransition(from, to)`, `isTerminal(state)`, `LANE_STATES`, `ACTIVE_STATES`.
  - **Entities:**
    - Config schemas: `AreaDef`, `HazardDef`, `DEFAULT_HAZARDS`.
    - Projects and tasks: `ProjectInput`, `ProjectDto`, `TaskInput`, `TaskDto`.
    - Workstreams and inbox: `NextAction`, `WorkstreamDto`, `InboxOption`, `InboxAnswer`, `InboxTarget`, `InboxItemDto`.
    - Rules and evidence: `PermissionRuleDto`, `EvidenceDto`.
  - **Handoff and events:** `HandoffInput`, `HandoffDto`, `EventType`, `DaemonEvent`.
  - **MCP:** `McpToolName`, `McpToolInputs`, `McpToolOutputs`, `ContextPack`, `KnowledgeHit`.
  - **Errors:** `DomainError` (with `code: 'not_found' | 'conflict' | 'invalid'`), `NotFoundError`, `ConflictError`, `InvalidError`.

- [ ] **Step 1: Add the dependency and update the package rules**

```bash
pnpm add --filter @10db/contracts ulid@3.0.2
```
In `packages/contracts/AGENTS.md`, replace the line `- This package depends on zod only. It never imports another workspace package.` with:
```markdown
- This package depends on zod and ulid only. It never imports another workspace package, never
  imports `node:*` (the UI bundles it), and holds no I/O.
- Pure domain rules shared by the daemon and the UI live here too: the workstream state machine
  (`workflow.ts`) and the vocabularies (`states.ts`).
```

- [ ] **Step 2: Write the failing tests**

`packages/contracts/src/domain.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import {
  HandoffInput,
  McpToolInputs,
  mintId,
  NextAction,
  ProjectInput,
  TaskId,
  WorkstreamId,
} from './index';

describe('ids', () => {
  it('mints prefixed sortable IDs that parse back', () => {
    const a = mintId('Task');
    const b = mintId('Task');
    expect(a).toMatch(/^tsk_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(a < b).toBe(true);
    expect(TaskId.parse(a)).toBe(a);
  });

  it('rejects an ID with the wrong prefix', () => {
    expect(WorkstreamId.safeParse(mintId('Task')).success).toBe(false);
  });
});

describe('ProjectInput', () => {
  it('fills the starting-heuristic defaults', () => {
    const parsed = ProjectInput.parse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
    });
    expect(parsed).toMatchObject({ maxLanes: 2, handoffPct: 40, nudgePct: 50, humanWaitMinutes: 10, billingMode: 'subscription' });
    expect(parsed.hazards.map((h) => h.name)).toEqual(['migrations', 'deps', 'harness']);
  });

  it('rejects a nudge threshold at or below the handoff threshold', () => {
    const result = ProjectInput.safeParse({
      name: 'demo',
      repoPath: '/tmp/demo',
      gateCommand: 'make gate',
      areas: [{ name: 'src', globs: ['src/**'] }],
      handoffPct: 80,
      nudgePct: 80,
    });
    expect(result.success).toBe(false);
  });
});

describe('NextAction', () => {
  it.each([
    [{ kind: 'start' }],
    [{ kind: 'verify' }],
    [{ kind: 'resume', providerSessionId: 'abc', reason: 'daemon restarted' }],
  ])('accepts %j', (value) => {
    expect(NextAction.parse(value)).toEqual(value);
  });
});

describe('MCP tool inputs', () => {
  it('requires two to four options on ask_human', () => {
    const base = { opId: 'op-00000001', category: 'design', question: 'Which?' };
    expect(McpToolInputs.ask_human.safeParse({ ...base, options: [{ label: 'A', description: 'a' }] }).success).toBe(false);
    expect(
      McpToolInputs.ask_human.safeParse({ ...base, options: [{ label: 'A', description: 'a' }, { label: 'B', description: 'b' }] }).success,
    ).toBe(true);
  });

  it('requires a next action in the handoff', () => {
    const handoff = {
      objective: { task: 't', acceptanceCriteria: ['a'], nonGoals: [] },
      progress: { done: [], notDone: [], nextAction: '' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    expect(HandoffInput.safeParse(handoff).success).toBe(false);
  });
});
```

`packages/contracts/src/workflow.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { canTransition, isTerminal, WORKSTREAM_TRANSITIONS, WorkstreamState as S, type WorkstreamState } from './index';

const ALL = Object.values(S);

describe('workstream state machine', () => {
  it.each<[WorkstreamState, WorkstreamState]>([
    [S.Queued, S.Starting],
    [S.Starting, S.Running],
    [S.Starting, S.Verifying],
    [S.Running, S.HandingOff],
    [S.HandingOff, S.Running],
    [S.Running, S.Verifying],
    [S.Verifying, S.Done],
    [S.Verifying, S.Queued],
    [S.Running, S.WaitingHuman],
    [S.HandingOff, S.WaitingHuman],
    [S.WaitingHuman, S.Running],
    [S.WaitingHuman, S.HandingOff],
    [S.WaitingHuman, S.Queued],
    [S.Running, S.PausedLimit],
    [S.PausedLimit, S.Queued],
    [S.Running, S.Recovering],
    [S.Recovering, S.Queued],
    [S.Recovering, S.Failed],
    [S.Failed, S.Queued],
  ])('allows %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(true);
  });

  it.each<[WorkstreamState, WorkstreamState]>([
    [S.Queued, S.Running],
    [S.Queued, S.Done],
    [S.Running, S.Done],
    [S.PausedLimit, S.Running],
    [S.Done, S.Queued],
    [S.Cancelled, S.Queued],
    [S.Recovering, S.Running],
  ])('forbids %s -> %s', (from, to) => {
    expect(canTransition(from, to)).toBe(false);
  });

  it('lets every non-terminal state be cancelled', () => {
    const stuck = ALL.filter((s) => !isTerminal(s) && !canTransition(s, S.Cancelled));
    expect(stuck).toEqual([]);
  });

  it('gives DONE and CANCELLED no exits, and FAILED only a retry', () => {
    expect(WORKSTREAM_TRANSITIONS[S.Done]).toEqual([]);
    expect(WORKSTREAM_TRANSITIONS[S.Cancelled]).toEqual([]);
    expect(WORKSTREAM_TRANSITIONS[S.Failed]).toEqual([S.Queued]);
  });

  it('reaches DONE from QUEUED', () => {
    const seen = new Set<WorkstreamState>([S.Queued]);
    const frontier: WorkstreamState[] = [S.Queued];
    while (frontier.length > 0) {
      const next = frontier.pop();
      if (next === undefined) break;
      for (const to of WORKSTREAM_TRANSITIONS[next]) {
        if (!seen.has(to)) {
          seen.add(to);
          frontier.push(to);
        }
      }
    }
    expect(seen.has(S.Done)).toBe(true);
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm vitest run --project contracts
```
Expected: FAIL. `mintId`, `WorkstreamState` and the rest aren't exported.

- [ ] **Step 4: Implement**

`packages/contracts/src/ids.ts`:
```ts
import { monotonicFactory } from 'ulid';
import { z } from 'zod';

const ULID = '[0-9A-HJKMNP-TV-Z]{26}';

function idSchema<const B extends string>(prefix: string, brand: B) {
  return z.string().regex(new RegExp(`^${prefix}_${ULID}$`), `expected a ${brand} (${prefix}_…)`).brand<B>();
}

const ID_SCHEMAS = {
  Project: idSchema('prj', 'ProjectId'),
  Task: idSchema('tsk', 'TaskId'),
  Workstream: idSchema('ws', 'WorkstreamId'),
  Session: idSchema('ses', 'SessionId'),
  Handoff: idSchema('hof', 'HandoffId'),
  Claim: idSchema('clm', 'ClaimId'),
  InboxItem: idSchema('inb', 'InboxItemId'),
  ToolOp: idSchema('top', 'ToolOpId'),
  Evidence: idSchema('evd', 'EvidenceId'),
  Decision: idSchema('dec', 'DecisionId'),
  Deviation: idSchema('dvn', 'DeviationId'),
  Source: idSchema('src', 'SourceId'),
  Proposal: idSchema('prp', 'ProposalId'),
  PermissionRule: idSchema('prm', 'PermissionRuleId'),
} as const;

const ID_PREFIX = {
  Project: 'prj',
  Task: 'tsk',
  Workstream: 'ws',
  Session: 'ses',
  Handoff: 'hof',
  Claim: 'clm',
  InboxItem: 'inb',
  ToolOp: 'top',
  Evidence: 'evd',
  Decision: 'dec',
  Deviation: 'dvn',
  Source: 'src',
  Proposal: 'prp',
  PermissionRule: 'prm',
} as const satisfies Record<keyof typeof ID_SCHEMAS, string>;

export type IdKind = keyof typeof ID_SCHEMAS;
export type IdOf<K extends IdKind> = z.infer<(typeof ID_SCHEMAS)[K]>;

const nextUlid = monotonicFactory();

/** Mints a new ID. Outside of parsing, this is the only way to obtain one. */
export function mintId<K extends IdKind>(kind: K): IdOf<K> {
  // The schema for K parses a string it just built from K's prefix, so the cast is the boundary.
  return ID_SCHEMAS[kind].parse(`${ID_PREFIX[kind]}_${nextUlid()}`) as IdOf<K>;
}

export const ProjectId = ID_SCHEMAS.Project;
export type ProjectId = IdOf<'Project'>;
export const TaskId = ID_SCHEMAS.Task;
export type TaskId = IdOf<'Task'>;
export const WorkstreamId = ID_SCHEMAS.Workstream;
export type WorkstreamId = IdOf<'Workstream'>;
export const SessionId = ID_SCHEMAS.Session;
export type SessionId = IdOf<'Session'>;
export const HandoffId = ID_SCHEMAS.Handoff;
export type HandoffId = IdOf<'Handoff'>;
export const ClaimId = ID_SCHEMAS.Claim;
export type ClaimId = IdOf<'Claim'>;
export const InboxItemId = ID_SCHEMAS.InboxItem;
export type InboxItemId = IdOf<'InboxItem'>;
export const ToolOpId = ID_SCHEMAS.ToolOp;
export type ToolOpId = IdOf<'ToolOp'>;
export const EvidenceId = ID_SCHEMAS.Evidence;
export type EvidenceId = IdOf<'Evidence'>;
export const DecisionId = ID_SCHEMAS.Decision;
export type DecisionId = IdOf<'Decision'>;
export const DeviationId = ID_SCHEMAS.Deviation;
export type DeviationId = IdOf<'Deviation'>;
export const SourceId = ID_SCHEMAS.Source;
export type SourceId = IdOf<'Source'>;
export const ProposalId = ID_SCHEMAS.Proposal;
export type ProposalId = IdOf<'Proposal'>;
export const PermissionRuleId = ID_SCHEMAS.PermissionRule;
export type PermissionRuleId = IdOf<'PermissionRule'>;
```

`packages/contracts/src/states.ts`:
```ts
type ValueOf<T> = T[keyof T];

export const WorkstreamState = {
  Queued: 'QUEUED',
  Starting: 'STARTING',
  Running: 'RUNNING',
  HandingOff: 'HANDING_OFF',
  Verifying: 'VERIFYING',
  Done: 'DONE',
  WaitingHuman: 'WAITING_HUMAN',
  PausedLimit: 'PAUSED_LIMIT',
  Recovering: 'RECOVERING',
  TakenOver: 'TAKEN_OVER',
  Failed: 'FAILED',
  Cancelled: 'CANCELLED',
} as const;
export type WorkstreamState = ValueOf<typeof WorkstreamState>;

export const InboxKind = { Question: 'question', Permission: 'permission', Proposal: 'proposal', Review: 'review', Flag: 'flag' } as const;
export type InboxKind = ValueOf<typeof InboxKind>;

export const InboxState = {
  Open: 'OPEN',
  Answered: 'ANSWERED',
  Delivering: 'DELIVERING',
  Resolved: 'RESOLVED',
  Cancelled: 'CANCELLED',
  Expired: 'EXPIRED',
} as const;
export type InboxState = ValueOf<typeof InboxState>;

export const ClaimKind = { Area: 'area', Hazard: 'hazard' } as const;
export type ClaimKind = ValueOf<typeof ClaimKind>;

export const BillingMode = { Subscription: 'subscription', ApiKey: 'api_key', Bedrock: 'bedrock' } as const;
export type BillingMode = ValueOf<typeof BillingMode>;

export const Provider = { Claude: 'claude' } as const;
export type Provider = ValueOf<typeof Provider>;

export const Effort = { Low: 'low', Medium: 'medium', High: 'high', XHigh: 'xhigh', Max: 'max' } as const;
export type Effort = ValueOf<typeof Effort>;

export const TaskStatus = { Open: 'open', Done: 'done', Cancelled: 'cancelled' } as const;
export type TaskStatus = ValueOf<typeof TaskStatus>;

export const BoardStatus = { Backlog: 'backlog', Ready: 'ready', InProgress: 'in_progress', Blocked: 'blocked', Done: 'done' } as const;
export type BoardStatus = ValueOf<typeof BoardStatus>;

export const PermissionChoice = {
  AllowOnce: 'allow_once',
  AllowWorkstream: 'allow_workstream',
  AllowProject: 'allow_project',
  Deny: 'deny',
} as const;
export type PermissionChoice = ValueOf<typeof PermissionChoice>;

export const Urgency = { Low: 'low', Normal: 'normal', High: 'high' } as const;
export type Urgency = ValueOf<typeof Urgency>;

export const QuestionCategory = {
  Product: 'product',
  Design: 'design',
  Engineering: 'engineering',
  Environment: 'environment',
  Other: 'other',
} as const;
export type QuestionCategory = ValueOf<typeof QuestionCategory>;

/** Answers in these categories are recorded as decisions (spec §7). */
export const DECISION_CATEGORIES: readonly QuestionCategory[] = [
  QuestionCategory.Product,
  QuestionCategory.Design,
  QuestionCategory.Engineering,
];

export const ProposalKind = { NewTask: 'new_task', ChangeTask: 'change_task', Principle: 'principle', Note: 'note' } as const;
export type ProposalKind = ValueOf<typeof ProposalKind>;

export const Severity = { Info: 'info', Warn: 'warn', Error: 'error' } as const;
export type Severity = ValueOf<typeof Severity>;

export const SourceKind = { InboxAnswer: 'inbox_answer', Agent: 'agent', Daemon: 'daemon', Builder: 'builder' } as const;
export type SourceKind = ValueOf<typeof SourceKind>;

export const EvidenceKind = { Gate: 'gate', Agent: 'agent' } as const;
export type EvidenceKind = ValueOf<typeof EvidenceKind>;

export const SessionMode = { Managed: 'managed', Terminal: 'terminal' } as const;
export type SessionMode = ValueOf<typeof SessionMode>;
```

`packages/contracts/src/workflow.ts`:
```ts
import { WorkstreamState as S, type WorkstreamState } from './states';

/** Allowed workstream transitions (spec §5.1). Anything not listed is forbidden. */
export const WORKSTREAM_TRANSITIONS: Readonly<Record<WorkstreamState, readonly WorkstreamState[]>> = {
  [S.Queued]: [S.Starting, S.Cancelled],
  [S.Starting]: [S.Running, S.Verifying, S.Recovering, S.PausedLimit, S.Failed, S.Cancelled],
  [S.Running]: [S.HandingOff, S.Verifying, S.WaitingHuman, S.PausedLimit, S.Recovering, S.TakenOver, S.Failed, S.Cancelled],
  [S.HandingOff]: [S.Running, S.Verifying, S.WaitingHuman, S.PausedLimit, S.Recovering, S.Failed, S.Cancelled],
  [S.Verifying]: [S.Done, S.Queued, S.Failed, S.Recovering, S.Cancelled],
  [S.WaitingHuman]: [S.Running, S.HandingOff, S.Queued, S.Cancelled],
  [S.PausedLimit]: [S.Queued, S.Cancelled],
  [S.Recovering]: [S.Queued, S.Failed, S.Cancelled],
  [S.TakenOver]: [S.Recovering, S.Cancelled],
  [S.Done]: [],
  [S.Failed]: [S.Queued],
  [S.Cancelled]: [],
};

export function canTransition(from: WorkstreamState, to: WorkstreamState): boolean {
  return WORKSTREAM_TRANSITIONS[from].includes(to);
}

const TERMINAL: readonly WorkstreamState[] = [S.Done, S.Failed, S.Cancelled];

export function isTerminal(state: WorkstreamState): boolean {
  return TERMINAL.includes(state);
}

/** States that occupy a lane. WAITING_HUMAN also occupies one while its session is still live. */
export const LANE_STATES: readonly WorkstreamState[] = [S.Starting, S.Running, S.HandingOff, S.Verifying];

/** Every state except the three terminal ones. */
export const ACTIVE_STATES: readonly WorkstreamState[] = Object.values(S).filter((s) => !TERMINAL.includes(s));
```

`packages/contracts/src/handoff.ts`:
```ts
import { z } from 'zod';
import { HandoffId, SessionId, WorkstreamId } from './ids';

const Lines = z.array(z.string().min(1));

/** The six-part handoff the agent writes (spec §5.3). 10db adds the git-derived facts itself. */
export const HandoffInput = z.object({
  objective: z.object({ task: z.string().min(1), acceptanceCriteria: Lines, nonGoals: Lines }),
  progress: z.object({ done: Lines, notDone: Lines, nextAction: z.string().min(1) }),
  codeState: z.object({ uncommittedSummary: z.string() }),
  reasoning: z.object({ decisions: Lines, tradeOffs: Lines, rejected: Lines }),
  validation: z.object({
    checks: z.array(z.object({ command: z.string().min(1), result: z.string().min(1) })),
    environmentProblems: Lines,
  }),
  continuity: z.object({ blockers: Lines, pendingQuestions: Lines, backgroundJobs: Lines, notes: z.string() }),
});
export type HandoffInput = z.infer<typeof HandoffInput>;

export const HandoffDto = z.object({
  id: HandoffId,
  workstreamId: WorkstreamId,
  sessionId: SessionId,
  content: HandoffInput,
  gitHead: z.string(),
  gitChangedFiles: z.array(z.string()),
  gitCommits: z.array(z.string()),
  createdAt: z.iso.datetime(),
});
export type HandoffDto = z.infer<typeof HandoffDto>;
```

`packages/contracts/src/entities.ts`:
```ts
import { z } from 'zod';
import {
  EvidenceId,
  HandoffId,
  InboxItemId,
  PermissionRuleId,
  ProjectId,
  SessionId,
  TaskId,
  WorkstreamId,
} from './ids';
import {
  BillingMode,
  BoardStatus,
  Effort,
  EvidenceKind,
  InboxKind,
  InboxState,
  Provider,
  QuestionCategory,
  TaskStatus,
  Urgency,
  WorkstreamState,
} from './states';

const Name = z.string().regex(/^[a-z][a-z0-9-]*$/, 'lowercase letters, digits and hyphens');
const Timestamp = z.iso.datetime();

export const AreaDef = z.object({ name: Name, globs: z.array(z.string().min(1)).min(1) });
export type AreaDef = z.infer<typeof AreaDef>;

/**
 * A hazard is an exclusive claim. `commands` are command prefixes that need it, as words: the guard
 * drops flags (and the value of flags like `--filter`) before comparing, so `pnpm -w add x` and
 * `pnpm --filter y add x` both match `pnpm add`.
 */
export const HazardDef = AreaDef.extend({ commands: z.array(z.string().min(1)) });
export type HazardDef = z.infer<typeof HazardDef>;

export const DEFAULT_HAZARDS: readonly HazardDef[] = [
  { name: 'migrations', globs: ['**/migrations/**', '**/drizzle/**'], commands: ['drizzle-kit generate', 'pnpm db:migrate'] },
  {
    name: 'deps',
    globs: ['**/package.json', 'pnpm-lock.yaml', '**/Cargo.toml', '**/Cargo.lock'],
    commands: ['pnpm add', 'pnpm remove', 'pnpm rm', 'pnpm install', 'pnpm i', 'pnpm update', 'pnpm up', 'npm install', 'npm i', 'npm uninstall', 'cargo add', 'cargo remove'],
  },
  { name: 'harness', globs: ['AGENTS.md', '**/AGENTS.md', '.claude/**', '.codex/**'], commands: [] },
];

export const ProjectInput = z
  .object({
    name: z.string().min(1),
    repoPath: z.string().startsWith('/'),
    gateCommand: z.string().min(1),
    areas: z.array(AreaDef).min(1),
    hazards: z.array(HazardDef).default(() => [...DEFAULT_HAZARDS]),
    maxLanes: z.int().min(1).max(16).default(2),
    billingMode: z.enum(BillingMode).default(BillingMode.Subscription),
    model: z.string().min(1).default('sonnet'),
    effort: z.enum(Effort).default(Effort.Medium),
    // Defaults hand off at about 400k tokens on a 1M window (spikes summary). Low minimums let acceptance runs
    // force a handoff on a large context window.
    handoffPct: z.int().min(5).max(95).default(40),
    nudgePct: z.int().min(6).max(98).default(50),
    humanWaitMinutes: z.int().min(1).max(240).default(10),
  })
  .refine((p) => p.nudgePct > p.handoffPct, { message: 'nudgePct must be above handoffPct', path: ['nudgePct'] });
export type ProjectInput = z.input<typeof ProjectInput>;
export type ProjectConfig = z.output<typeof ProjectInput>;

export const ProjectDto = z.object({
  id: ProjectId,
  name: z.string(),
  repoPath: z.string(),
  gateCommand: z.string(),
  areas: z.array(AreaDef),
  hazards: z.array(HazardDef),
  maxLanes: z.int(),
  provider: z.enum(Provider),
  billingMode: z.enum(BillingMode),
  model: z.string(),
  effort: z.enum(Effort),
  handoffPct: z.int(),
  nudgePct: z.int(),
  humanWaitMinutes: z.int(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectDto = z.infer<typeof ProjectDto>;

export const TaskInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  areas: z.array(Name).min(1),
  dependsOn: z.array(TaskId).default([]),
});
export type TaskInput = z.input<typeof TaskInput>;
export type TaskConfig = z.output<typeof TaskInput>;

export const TaskDto = z.object({
  id: TaskId,
  projectId: ProjectId,
  title: z.string(),
  description: z.string(),
  acceptanceCriteria: z.array(z.string()),
  areas: z.array(z.string()),
  status: z.enum(TaskStatus),
  boardOrder: z.number(),
  dependsOn: z.array(TaskId),
  boardStatus: z.enum(BoardStatus),
  workstreamId: WorkstreamId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskDto = z.infer<typeof TaskDto>;

/** What the runner does the next time the workstream gets a lane. */
export const NextAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('continue_from_handoff'), handoffId: HandoffId }),
  z.object({ kind: z.literal('resume'), providerSessionId: z.string().min(1), reason: z.string().min(1) }),
  z.object({ kind: z.literal('answer'), inboxId: InboxItemId, providerSessionId: z.string().min(1).nullable() }),
  z.object({ kind: z.literal('fix'), evidenceId: EvidenceId }),
  z.object({ kind: z.literal('verify') }),
]);
export type NextAction = z.infer<typeof NextAction>;

export const WorkstreamDto = z.object({
  id: WorkstreamId,
  taskId: TaskId,
  projectId: ProjectId,
  state: z.enum(WorkstreamState),
  nextAction: NextAction,
  attempt: z.int(),
  recoveryAttempts: z.int(),
  model: z.string(),
  effort: z.enum(Effort),
  currentSessionId: SessionId.nullable(),
  sessionCount: z.int(),
  contextPct: z.number().nullable(),
  pausedUntil: Timestamp.nullable(),
  failureReason: z.string().nullable(),
  lastActivityAt: Timestamp.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type WorkstreamDto = z.infer<typeof WorkstreamDto>;

export const InboxOption = z.object({ label: z.string().min(1).max(80), description: z.string() });
export type InboxOption = z.infer<typeof InboxOption>;

export const InboxAnswer = z.object({ choice: z.string().min(1), note: z.string().max(4000).optional() });
export type InboxAnswer = z.infer<typeof InboxAnswer>;

export const InboxTarget = z.object({ workstreamId: WorkstreamId, sessionId: SessionId.nullable() });
export type InboxTarget = z.infer<typeof InboxTarget>;

export const InboxItemDto = z.object({
  id: InboxItemId,
  projectId: ProjectId,
  kind: z.enum(InboxKind),
  state: z.enum(InboxState),
  title: z.string(),
  body: z.string(),
  options: z.array(InboxOption),
  recommendation: z.string().nullable(),
  category: z.enum(QuestionCategory),
  urgency: z.enum(Urgency),
  assignee: z.string(),
  detail: z.record(z.string(), z.json()).nullable(),
  answer: InboxAnswer.nullable(),
  targets: z.array(InboxTarget),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type InboxItemDto = z.infer<typeof InboxItemDto>;

export const PermissionRuleDto = z.object({
  id: PermissionRuleId,
  projectId: ProjectId,
  workstreamId: WorkstreamId.nullable(),
  toolName: z.string(),
  pattern: z.string().nullable(),
  sourceInboxId: InboxItemId.nullable(),
  createdAt: Timestamp,
});
export type PermissionRuleDto = z.infer<typeof PermissionRuleDto>;

export const EvidenceDto = z.object({
  id: EvidenceId,
  workstreamId: WorkstreamId,
  kind: z.enum(EvidenceKind),
  command: z.string(),
  exitCode: z.int(),
  summary: z.string(),
  logPath: z.string().nullable(),
  commitShas: z.array(z.string()),
  createdAt: Timestamp,
});
export type EvidenceDto = z.infer<typeof EvidenceDto>;
```

`packages/contracts/src/events.ts`:
```ts
import { z } from 'zod';

export const EventType = {
  ProjectCreated: 'project.created',
  TaskCreated: 'task.created',
  TaskChanged: 'task.changed',
  WorkstreamCreated: 'workstream.created',
  WorkstreamChanged: 'workstream.changed',
  SessionStarted: 'session.started',
  SessionActivity: 'session.activity',
  SessionContext: 'session.context',
  SessionEnded: 'session.ended',
  ClaimAcquired: 'claim.acquired',
  ClaimReleased: 'claim.released',
  InboxOpened: 'inbox.opened',
  InboxChanged: 'inbox.changed',
  HandoffRecorded: 'handoff.recorded',
  EvidenceRecorded: 'evidence.recorded',
  CommitRecorded: 'commit.recorded',
  DecisionRecorded: 'decision.recorded',
  DeviationRecorded: 'deviation.recorded',
  ProposalCreated: 'proposal.created',
  ProposalResolved: 'proposal.resolved',
  ProviderPaused: 'provider.paused',
  ProviderResumed: 'provider.resumed',
  RecoveryStep: 'recovery.step',
} as const;
export type EventType = (typeof EventType)[keyof typeof EventType];

/** Persisted before it is pushed; `seq` is monotonic, so a client replays from the last one it saw. */
export const DaemonEvent = z.object({
  seq: z.int().positive(),
  type: z.enum(EventType),
  entityType: z.string(),
  entityId: z.string(),
  data: z.record(z.string(), z.json()),
  at: z.iso.datetime(),
});
export type DaemonEvent = z.infer<typeof DaemonEvent>;
```

`packages/contracts/src/mcp-tools.ts`:
```ts
import { z } from 'zod';
import { InboxOption } from './entities';
import { HandoffDto, HandoffInput } from './handoff';
import { ClaimId, DecisionId, DeviationId, EvidenceId, HandoffId, InboxItemId, ProposalId, WorkstreamId } from './ids';
import { ClaimKind, ProposalKind, QuestionCategory, Severity, Urgency } from './states';

const OpId = z
  .string()
  .regex(/^[A-Za-z0-9._:-]{8,100}$/)
  .describe('A unique ID for this call. Reuse it only when retrying the same call.');

export const McpToolName = {
  GetContext: 'get_context',
  FindKnowledge: 'find_knowledge',
  AskHuman: 'ask_human',
  RecordDecision: 'record_decision',
  Propose: 'propose',
  ReportDeviation: 'report_deviation',
  RequestClaim: 'request_claim',
  Commit: 'commit',
  RecordEvidence: 'record_evidence',
  WriteHandoff: 'write_handoff',
} as const;
export type McpToolName = (typeof McpToolName)[keyof typeof McpToolName];

export const KnowledgeHit = z.object({
  kind: z.literal('decision'),
  id: DecisionId,
  question: z.string(),
  choice: z.string(),
  rationale: z.string(),
});
export type KnowledgeHit = z.infer<typeof KnowledgeHit>;

export const ContextPack = z.object({
  task: z.object({ title: z.string(), description: z.string(), acceptanceCriteria: z.array(z.string()) }),
  claims: z.array(z.object({ kind: z.enum(ClaimKind), name: z.string() })),
  handoff: HandoffDto.nullable(),
  pendingAnswer: z.object({ question: z.string(), answer: z.string(), note: z.string().nullable() }).nullable(),
  knowledge: z.object({
    decisions: z.array(KnowledgeHit),
    budgetUsed: z.int(),
    droppedCount: z.int(),
    empty: z.boolean(),
  }),
});
export type ContextPack = z.infer<typeof ContextPack>;

export const McpToolInputs = {
  get_context: z.object({}),
  find_knowledge: z.object({ query: z.string().min(1), limit: z.int().min(1).max(20).default(5) }),
  ask_human: z.object({
    opId: OpId,
    category: z.enum(QuestionCategory),
    question: z.string().min(1).max(2000),
    options: z.array(InboxOption).min(2).max(4),
    recommendation: z.string().optional(),
    urgency: z.enum(Urgency).default(Urgency.Normal),
    consequences: z.string().optional(),
    affectedScope: z.string().optional(),
  }),
  record_decision: z.object({
    opId: OpId,
    question: z.string().min(1),
    choice: z.string().min(1),
    rationale: z.string().min(1),
    scope: z.enum(['project', 'area']),
    area: z.string().optional(),
  }),
  propose: z.object({ opId: OpId, kind: z.enum(ProposalKind), title: z.string().min(1), body: z.string().min(1) }),
  report_deviation: z.object({ opId: OpId, cause: z.string().min(1), severity: z.enum(Severity), reason: z.string().min(1) }),
  request_claim: z.object({ opId: OpId, kind: z.enum(ClaimKind), name: z.string().min(1), reason: z.string().min(1) }),
  commit: z.object({ opId: OpId, paths: z.array(z.string().min(1)).min(1).max(200), message: z.string().min(1).max(2000) }),
  record_evidence: z.object({ opId: OpId, command: z.string().min(1), exitCode: z.int(), summary: z.string().min(1) }),
  write_handoff: HandoffInput.extend({ opId: OpId }),
} as const satisfies Record<McpToolName, z.ZodType>;

export const McpToolOutputs = {
  get_context: ContextPack,
  find_knowledge: z.object({ results: z.array(KnowledgeHit), empty: z.boolean() }),
  ask_human: z.object({ inboxId: InboxItemId, answer: z.string(), note: z.string().nullable() }),
  record_decision: z.object({ decisionId: DecisionId }),
  propose: z.object({ proposalId: ProposalId }),
  report_deviation: z.object({ deviationId: DeviationId }),
  request_claim: z.discriminatedUnion('granted', [
    z.object({ granted: z.literal(true), claimId: ClaimId }),
    z.object({ granted: z.literal(false), heldBy: WorkstreamId.nullable(), inboxId: InboxItemId }),
  ]),
  commit: z.object({ sha: z.string().regex(/^[0-9a-f]{40}$/), alreadyCommitted: z.boolean() }),
  record_evidence: z.object({ evidenceId: EvidenceId }),
  write_handoff: z.object({ handoffId: HandoffId, instruction: z.string() }),
} as const satisfies Record<McpToolName, z.ZodType>;
```

`packages/contracts/src/errors.ts`:
```ts
export type DomainErrorCode = 'not_found' | 'conflict' | 'invalid';

/** An error the API maps to an HTTP status; its message is safe to show the builder. */
export class DomainError extends Error {
  override readonly name: string = 'DomainError';
  // A declared field, not a parameter property: M0's tsconfig sets `erasableSyntaxOnly`.
  readonly code: DomainErrorCode;
  constructor(code: DomainErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

export class NotFoundError extends DomainError {
  override readonly name = 'NotFoundError';
  constructor(entity: string, id: string) {
    super('not_found', `${entity} ${id} not found`);
  }
}

export class ConflictError extends DomainError {
  override readonly name = 'ConflictError';
  constructor(message: string) {
    super('conflict', message);
  }
}

export class InvalidError extends DomainError {
  override readonly name = 'InvalidError';
  constructor(message: string) {
    super('invalid', message);
  }
}
```

`packages/contracts/src/index.ts`:
```ts
export * from './entities';
export * from './errors';
export * from './events';
export * from './handoff';
export { HealthResponse } from './health';
export * from './ids';
export { CONTRACT_SCHEMAS, renderJsonSchemas } from './json-schema';
export * from './mcp-tools';
export { PROTOCOL_VERSION } from './protocol';
export * from './states';
export * from './workflow';
```

`packages/contracts/src/json-schema.ts`: register the externally visible schemas:
```ts
import { z } from 'zod';
import { InboxItemDto, ProjectDto, TaskDto, WorkstreamDto } from './entities';
import { DaemonEvent } from './events';
import { HandoffInput } from './handoff';
import { HealthResponse } from './health';
import { McpToolInputs, McpToolOutputs } from './mcp-tools';

const mcpSchemas: Record<string, z.ZodType> = Object.fromEntries(
  Object.entries(McpToolInputs).flatMap(([tool, input]): [string, z.ZodType][] => [
    [`mcp-${tool.replaceAll('_', '-')}-input`, input],
    [`mcp-${tool.replaceAll('_', '-')}-output`, McpToolOutputs[tool as keyof typeof McpToolOutputs]],
  ]),
);

/** Every schema visible outside the daemon, keyed by the file stem of its generated JSON Schema. */
export const CONTRACT_SCHEMAS: Record<string, z.ZodType> = {
  'health-response': HealthResponse,
  'daemon-event': DaemonEvent,
  'handoff-input': HandoffInput,
  'project-dto': ProjectDto,
  'task-dto': TaskDto,
  'workstream-dto': WorkstreamDto,
  'inbox-item-dto': InboxItemDto,
  ...mcpSchemas,
};

/** Renders each registered schema as JSON Schema text, keyed by file name. */
export function renderJsonSchemas(): Map<string, string> {
  return new Map(
    Object.entries(CONTRACT_SCHEMAS)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([stem, schema]) => [
        `${stem}.schema.json`,
        `${JSON.stringify(z.toJSONSchema(schema, { target: 'draft-2020-12', io: 'input', unrepresentable: 'any' }), null, 2)}\n`,
      ]),
  );
}
```
Branded strings and refinements are unrepresentable in JSON Schema. `unrepresentable: 'any'` renders them as their base type, and the zod schema stays the source of truth.

- [ ] **Step 5: Run the tests and regenerate**

```bash
pnpm vitest run --project contracts
pnpm --filter @10db/contracts generate
pnpm vitest run --project contracts
```
Expected: first the domain and workflow tests PASS while the drift test FAILS, because the new schema files don't exist yet. After `generate`, everything PASSES.

- [ ] **Step 6: Check and commit**

```bash
pnpm typecheck && pnpm lint && pnpm knip
pnpm format
git add packages/contracts pnpm-lock.yaml && git commit -m 'feat(contracts): add domain ids, states, workflow, entities, events and MCP tool schemas'
```

---

### Task 2: Database schema and migrations

**Files:**
- Modify: `packages/db/src/schema.ts`
- Create: `packages/db/drizzle/0001_*.sql` (generated), `packages/db/drizzle/0002_decisions_fts.sql` (custom)
- Modify: `packages/db/package.json` (add `@10db/contracts`)
- Test: `packages/db/src/schema.test.ts`

**Interfaces:**
- Consumes: the ID, vocabulary and DTO types from Task 1.
- Produces Drizzle tables: `projects`, `tasks`, `taskDeps`, `sources`, `proposals`, `workstreams`, `sessions`, `handoffs`, `claims`, `inboxItems`, `permissionRules`, `toolOps`, `evidence`, `decisions`, `deviations`, `events` (plus `appSettings`), and the FTS5 table `decisions_fts`, which triggers keep in sync.
- Invariant: at most one *active* claim per (project, kind, name), enforced by a partial unique index.
- Process identity: `sessions.pid_start` and `workstreams.gate_pid` / `gate_pid_start` hold a pid's OS start time (and the running gate's process group), so recovery never signals a reused pid (Tasks 16 and 18).

- [ ] **Step 1: Add the dependency and write the failing test**

```bash
pnpm add --filter @10db/db @10db/contracts@workspace:*
```

`packages/db/src/schema.test.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { migrateDatabase, openDatabase, schema, type TendbDatabase } from './index';

let dir: string;
let db: TendbDatabase;
const now = '2026-10-13T12:00:00.000Z';

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), '10db-schema-'));
  db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db);
});
afterEach(() => {
  db.$client.close();
  rmSync(dir, { recursive: true, force: true });
});

function seedProjectAndWorkstreams() {
  const projectId = mintId('Project');
  db.insert(schema.projects).values({
    id: projectId, name: 'p', repoPath: '/tmp/p', gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }],
    hazards: [], maxLanes: 2, provider: 'claude', billingMode: 'subscription', model: 'sonnet', effort: 'medium',
    handoffPct: 40, nudgePct: 50, humanWaitMinutes: 10, createdAt: now, updatedAt: now,
  }).run();
  const taskId = mintId('Task');
  db.insert(schema.tasks).values({
    id: taskId, projectId, title: 't', description: '', acceptanceCriteria: ['a'], areas: ['src'], status: 'open',
    boardOrder: 1, workspaceMode: 'shared', createdAt: now, updatedAt: now,
  }).run();
  const ws = () => {
    const id = mintId('Workstream');
    db.insert(schema.workstreams).values({
      id, taskId, projectId, state: 'QUEUED', nextAction: { kind: 'start' }, attempt: 0, recoveryAttempts: 0,
      model: 'sonnet', effort: 'medium', fence: 0, createdAt: now, updatedAt: now,
    }).run();
    return id;
  };
  return { projectId, ws1: ws(), ws2: ws() };
}

describe('schema', () => {
  it('allows only one active claim per project, kind and name', () => {
    const { projectId, ws1, ws2 } = seedProjectAndWorkstreams();
    const claim = (workstreamId: typeof ws1) => ({
      id: mintId('Claim'), projectId, workstreamId, kind: 'area' as const, name: 'src', exclusive: true,
      leaseExpiresAt: now, createdAt: now,
    });
    const first = claim(ws1);
    db.insert(schema.claims).values(first).run();
    expect(() => db.insert(schema.claims).values(claim(ws2)).run()).toThrow(/UNIQUE/);

    db.update(schema.claims).set({ releasedAt: now }).run();
    expect(() => db.insert(schema.claims).values(claim(ws2)).run()).not.toThrow();
  });

  it('indexes decisions for full-text search through triggers', () => {
    const { projectId } = seedProjectAndWorkstreams();
    const sourceId = mintId('Source');
    db.insert(schema.sources).values({ id: sourceId, kind: 'builder', ref: {}, createdAt: now }).run();
    db.insert(schema.decisions).values({
      id: mintId('Decision'), projectId, question: 'Which queue library?', choice: 'BullMQ',
      rationale: 'Redis is already deployed', decidedBy: 'me', scope: 'project', sourceId, createdAt: now, updatedAt: now,
    }).run();
    const hits = db.$client.prepare("SELECT choice FROM decisions_fts WHERE decisions_fts MATCH 'queue'").all();
    expect(hits).toEqual([{ choice: 'BullMQ' }]);
  });

  it('numbers events monotonically', () => {
    const insert = () =>
      db.insert(schema.events).values({ type: 'task.created', entityType: 'task', entityId: 'x', data: {}, at: now }).returning().get();
    expect(insert().seq).toBe(1);
    expect(insert().seq).toBe(2);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project db schema
```
Expected: FAIL. `schema.projects` is undefined.

- [ ] **Step 3: Write the schema**

`packages/db/src/schema.ts`:
```ts
import type {
  AreaDef,
  BillingMode,
  ClaimId,
  ClaimKind,
  DecisionId,
  DeviationId,
  Effort,
  EventType,
  EvidenceId,
  EvidenceKind,
  HandoffId,
  HandoffInput,
  HazardDef,
  InboxAnswer,
  InboxItemId,
  InboxKind,
  InboxOption,
  InboxState,
  InboxTarget,
  NextAction,
  PermissionRuleId,
  ProjectId,
  ProposalId,
  ProposalKind,
  Provider,
  QuestionCategory,
  SessionId,
  SessionMode,
  Severity,
  SourceId,
  SourceKind,
  TaskId,
  TaskStatus,
  ToolOpId,
  Urgency,
  WorkstreamId,
  WorkstreamState,
} from '@10db/contracts';
import { sql } from 'drizzle-orm';
import { index, integer, primaryKey, real, sqliteTable, text, uniqueIndex } from 'drizzle-orm/sqlite-core';

type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

const createdAt = () => text('created_at').notNull();
const updatedAt = () => text('updated_at').notNull();

/** App-wide settings keyed by name; values are JSON validated by their readers. */
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value', { mode: 'json' }).notNull(),
  updatedAt: text('updated_at').notNull(),
});

export const projects = sqliteTable('projects', {
  id: text('id').$type<ProjectId>().primaryKey(),
  name: text('name').notNull(),
  repoPath: text('repo_path').notNull().unique(),
  gateCommand: text('gate_command').notNull(),
  areas: text('areas', { mode: 'json' }).$type<AreaDef[]>().notNull(),
  hazards: text('hazards', { mode: 'json' }).$type<HazardDef[]>().notNull(),
  maxLanes: integer('max_lanes').notNull(),
  provider: text('provider').$type<Provider>().notNull(),
  billingMode: text('billing_mode').$type<BillingMode>().notNull(),
  model: text('model').notNull(),
  effort: text('effort').$type<Effort>().notNull(),
  handoffPct: integer('handoff_pct').notNull(),
  nudgePct: integer('nudge_pct').notNull(),
  humanWaitMinutes: integer('human_wait_minutes').notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const tasks = sqliteTable(
  'tasks',
  {
    id: text('id').$type<TaskId>().primaryKey(),
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    title: text('title').notNull(),
    description: text('description').notNull(),
    acceptanceCriteria: text('acceptance_criteria', { mode: 'json' }).$type<string[]>().notNull(),
    areas: text('areas', { mode: 'json' }).$type<string[]>().notNull(),
    status: text('status').$type<TaskStatus>().notNull(),
    boardOrder: real('board_order').notNull(),
    workspaceMode: text('workspace_mode').$type<'shared'>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('tasks_project_idx').on(t.projectId)],
);

export const taskDeps = sqliteTable(
  'task_deps',
  {
    taskId: text('task_id').$type<TaskId>().notNull().references(() => tasks.id),
    dependsOnId: text('depends_on_id').$type<TaskId>().notNull().references(() => tasks.id),
  },
  (t) => [primaryKey({ columns: [t.taskId, t.dependsOnId] })],
);

export const sources = sqliteTable('sources', {
  id: text('id').$type<SourceId>().primaryKey(),
  kind: text('kind').$type<SourceKind>().notNull(),
  ref: text('ref', { mode: 'json' }).$type<Record<string, Json>>().notNull(),
  createdAt: createdAt(),
});

export const proposals = sqliteTable('proposals', {
  id: text('id').$type<ProposalId>().primaryKey(),
  projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
  kind: text('kind').$type<ProposalKind>().notNull(),
  title: text('title').notNull(),
  body: text('body').notNull(),
  status: text('status').$type<'pending' | 'accepted' | 'rejected'>().notNull(),
  rationale: text('rationale'),
  sourceId: text('source_id').$type<SourceId>().notNull().references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const workstreams = sqliteTable(
  'workstreams',
  {
    id: text('id').$type<WorkstreamId>().primaryKey(),
    taskId: text('task_id').$type<TaskId>().notNull().references(() => tasks.id),
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    state: text('state').$type<WorkstreamState>().notNull(),
    nextAction: text('next_action', { mode: 'json' }).$type<NextAction>().notNull(),
    attempt: integer('attempt').notNull(),
    recoveryAttempts: integer('recovery_attempts').notNull(),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    baseHead: text('base_head'),
    leaseOwner: text('lease_owner'),
    leaseExpiresAt: text('lease_expires_at'),
    fence: integer('fence').notNull(),
    /** The running gate's process-group leader and its OS start time, so recovery can kill an orphaned gate. */
    gatePid: integer('gate_pid'),
    gatePidStart: text('gate_pid_start'),
    currentSessionId: text('current_session_id').$type<SessionId>(),
    contextPct: real('context_pct'),
    pausedUntil: text('paused_until'),
    failureReason: text('failure_reason'),
    lastActivityAt: text('last_activity_at'),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('workstreams_state_idx').on(t.state), index('workstreams_task_idx').on(t.taskId)],
);

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').$type<SessionId>().primaryKey(),
    workstreamId: text('workstream_id').$type<WorkstreamId>().notNull().references(() => workstreams.id),
    sequence: integer('sequence').notNull(),
    provider: text('provider').$type<Provider>().notNull(),
    providerSessionId: text('provider_session_id'),
    model: text('model').notNull(),
    effort: text('effort').$type<Effort>().notNull(),
    mode: text('mode').$type<SessionMode>().notNull(),
    mcpTokenHash: text('mcp_token_hash').notNull().unique(),
    pid: integer('pid'),
    /** The OS start time of `pid` (`ps -o lstart=`), so recovery never signals a reused PID. */
    pidStart: text('pid_start'),
    startedAt: text('started_at').notNull(),
    endedAt: text('ended_at'),
    exitReason: text('exit_reason'),
    inputTokens: integer('input_tokens').notNull(),
    outputTokens: integer('output_tokens').notNull(),
    costUsd: real('cost_usd').notNull(),
    contextPct: real('context_pct'),
  },
  (t) => [index('sessions_workstream_idx').on(t.workstreamId)],
);

export const handoffs = sqliteTable('handoffs', {
  id: text('id').$type<HandoffId>().primaryKey(),
  workstreamId: text('workstream_id').$type<WorkstreamId>().notNull().references(() => workstreams.id),
  sessionId: text('session_id').$type<SessionId>().notNull().references(() => sessions.id),
  content: text('content', { mode: 'json' }).$type<HandoffInput>().notNull(),
  gitHead: text('git_head').notNull(),
  gitChangedFiles: text('git_changed_files', { mode: 'json' }).$type<string[]>().notNull(),
  gitCommits: text('git_commits', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: createdAt(),
});

export const claims = sqliteTable(
  'claims',
  {
    id: text('id').$type<ClaimId>().primaryKey(),
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    workstreamId: text('workstream_id').$type<WorkstreamId>().notNull().references(() => workstreams.id),
    kind: text('kind').$type<ClaimKind>().notNull(),
    name: text('name').notNull(),
    exclusive: integer('exclusive', { mode: 'boolean' }).notNull(),
    leaseExpiresAt: text('lease_expires_at').notNull(),
    releasedAt: text('released_at'),
    createdAt: createdAt(),
  },
  (t) => [
    uniqueIndex('claims_active_unique').on(t.projectId, t.kind, t.name).where(sql`released_at IS NULL`),
    index('claims_workstream_idx').on(t.workstreamId),
  ],
);

export const inboxItems = sqliteTable(
  'inbox_items',
  {
    id: text('id').$type<InboxItemId>().primaryKey(),
    projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
    kind: text('kind').$type<InboxKind>().notNull(),
    state: text('state').$type<InboxState>().notNull(),
    title: text('title').notNull(),
    body: text('body').notNull(),
    options: text('options', { mode: 'json' }).$type<InboxOption[]>().notNull(),
    recommendation: text('recommendation'),
    category: text('category').$type<QuestionCategory>().notNull(),
    urgency: text('urgency').$type<Urgency>().notNull(),
    assignee: text('assignee').notNull(),
    detail: text('detail', { mode: 'json' }).$type<Record<string, Json>>(),
    answer: text('answer', { mode: 'json' }).$type<InboxAnswer>(),
    foldKey: text('fold_key'),
    targets: text('targets', { mode: 'json' }).$type<InboxTarget[]>().notNull(),
    createdAt: createdAt(),
    updatedAt: updatedAt(),
  },
  (t) => [index('inbox_state_idx').on(t.state), index('inbox_fold_idx').on(t.projectId, t.foldKey)],
);

export const permissionRules = sqliteTable('permission_rules', {
  id: text('id').$type<PermissionRuleId>().primaryKey(),
  projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
  workstreamId: text('workstream_id').$type<WorkstreamId>(),
  toolName: text('tool_name').notNull(),
  pattern: text('pattern'),
  sourceInboxId: text('source_inbox_id').$type<InboxItemId>(),
  createdAt: createdAt(),
});

export const toolOps = sqliteTable(
  'tool_ops',
  {
    id: text('id').$type<ToolOpId>().primaryKey(),
    workstreamId: text('workstream_id').$type<WorkstreamId>().notNull().references(() => workstreams.id),
    sessionId: text('session_id').$type<SessionId>().notNull(),
    opId: text('op_id').notNull(),
    tool: text('tool').notNull(),
    result: text('result', { mode: 'json' }).$type<Json>().notNull(),
    createdAt: createdAt(),
  },
  (t) => [uniqueIndex('tool_ops_unique').on(t.workstreamId, t.opId)],
);

export const evidence = sqliteTable('evidence', {
  id: text('id').$type<EvidenceId>().primaryKey(),
  workstreamId: text('workstream_id').$type<WorkstreamId>().notNull().references(() => workstreams.id),
  kind: text('kind').$type<EvidenceKind>().notNull(),
  command: text('command').notNull(),
  exitCode: integer('exit_code').notNull(),
  summary: text('summary').notNull(),
  logPath: text('log_path'),
  commitShas: text('commit_shas', { mode: 'json' }).$type<string[]>().notNull(),
  createdAt: createdAt(),
});

export const decisions = sqliteTable('decisions', {
  id: text('id').$type<DecisionId>().primaryKey(),
  projectId: text('project_id').$type<ProjectId>().references(() => projects.id),
  question: text('question').notNull(),
  choice: text('choice').notNull(),
  rationale: text('rationale').notNull(),
  decidedBy: text('decided_by').notNull(),
  scope: text('scope').$type<'you' | 'project' | 'area'>().notNull(),
  area: text('area'),
  supersedesId: text('supersedes_id').$type<DecisionId>(),
  sourceId: text('source_id').$type<SourceId>().notNull().references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const deviations = sqliteTable('deviations', {
  id: text('id').$type<DeviationId>().primaryKey(),
  projectId: text('project_id').$type<ProjectId>().notNull().references(() => projects.id),
  workstreamId: text('workstream_id').$type<WorkstreamId>(),
  cause: text('cause').notNull(),
  severity: text('severity').$type<Severity>().notNull(),
  signedReason: text('signed_reason').notNull(),
  resolution: text('resolution'),
  sourceId: text('source_id').$type<SourceId>().notNull().references(() => sources.id),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
});

export const events = sqliteTable('events', {
  seq: integer('seq').primaryKey({ autoIncrement: true }),
  type: text('type').$type<EventType>().notNull(),
  entityType: text('entity_type').notNull(),
  entityId: text('entity_id').notNull(),
  data: text('data', { mode: 'json' }).$type<Record<string, Json>>().notNull(),
  at: text('at').notNull(),
});
```

- [ ] **Step 4: Generate the migrations**

```bash
pnpm --filter @10db/db exec drizzle-kit generate --name factory_loop
pnpm --filter @10db/db exec drizzle-kit generate --custom --name decisions_fts
```
The second command creates an empty `drizzle/0002_decisions_fts.sql`. Fill it in:
```sql
-- The index keys on the implicit rowid of `decisions` (its primary key is TEXT). VACUUM may renumber
-- implicit rowids, so never VACUUM this database without rebuilding the index afterwards with
-- INSERT INTO decisions_fts(decisions_fts) VALUES ('rebuild'). Backups use .backup(), which is safe.
CREATE VIRTUAL TABLE decisions_fts USING fts5(question, choice, rationale, content='decisions', content_rowid='rowid');
--> statement-breakpoint
CREATE TRIGGER decisions_fts_insert AFTER INSERT ON decisions BEGIN
  INSERT INTO decisions_fts(rowid, question, choice, rationale) VALUES (new.rowid, new.question, new.choice, new.rationale);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_fts_delete AFTER DELETE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, question, choice, rationale) VALUES ('delete', old.rowid, old.question, old.choice, old.rationale);
END;
--> statement-breakpoint
CREATE TRIGGER decisions_fts_update AFTER UPDATE ON decisions BEGIN
  INSERT INTO decisions_fts(decisions_fts, rowid, question, choice, rationale) VALUES ('delete', old.rowid, old.question, old.choice, old.rationale);
  INSERT INTO decisions_fts(rowid, question, choice, rationale) VALUES (new.rowid, new.question, new.choice, new.rationale);
END;
```
Open `drizzle/0001_factory_loop.sql` and confirm that `claims_active_unique` has `WHERE released_at IS NULL`.

- [ ] **Step 5: Run the tests and the drift check**

```bash
pnpm vitest run --project db
git add packages/db && pnpm --filter @10db/db drift
```
Expected: all db tests PASS, and the drift check reports no schema changes. The drift check (M0's `scripts/check-clean.sh`) compares the working tree against the index and ignores staged files, so staging the new migrations first is what makes it pass.

- [ ] **Step 6: Commit**

```bash
pnpm typecheck && pnpm lint
pnpm format
git add packages/db pnpm-lock.yaml && git commit -m 'feat(db): add factory-loop schema, migrations and decisions FTS'
```

---

### Task 3: Store core, project and task repositories

**Files:**
- Create: `packages/db/src/store/store.ts`, `store/events.ts`, `store/projects.ts`, `store/tasks.ts`, `store/index.ts`
- Modify: `packages/db/src/index.ts`
- Test: `packages/db/src/store/projects-tasks.test.ts`
- Create: `packages/db/src/store/test-support.ts` (shared test setup)

**Interfaces:**
- Consumes: Task 2's tables; the contracts DTOs, `mintId`, `EventType` and errors.
- Produces, from `@10db/db`:
  - `type DbTx`: a Drizzle transaction.
  - `type DbReader = TendbDatabase | DbTx`.
  - `interface WriteContext { readonly tx: DbTx; readonly now: string; emit(e: EmitInput): void }`
  - `interface EmitInput { type: EventType; entityType: string; entityId: string; data?: Record<string, Json> }`
  - `interface Store { readonly db: TendbDatabase; now(): string; write<T>(fn: (ctx: WriteContext) => T): { value: T; events: DaemonEvent[] } }`
  - `createStore(db: TendbDatabase, clock?: () => Date): Store`
  - `listEventsAfter(db: DbReader, afterSeq: number, limit: number): DaemonEvent[]`
  - Projects: `insertProject(ctx, input: ProjectInput): ProjectDto` (throws `ConflictError` when another project already uses `repoPath`, so the API answers 409 instead of a raw UNIQUE error), `getProject(db, id): ProjectDto` (throws `NotFoundError`), `listProjects(db): ProjectDto[]`.
  - Tasks:
    - `insertTask(ctx, projectId, input: TaskInput): TaskDto`. Throws `InvalidError` when an area isn't in the project's areas or hazards, or when a dependency is missing or in another project.
    - `getTask(db, id): TaskDto`, `listTasks(db, projectId): TaskDto[]`, `setTaskStatus(ctx, id, status): void`.
    - `dependenciesDone(db, taskId): boolean`.
    - `deriveBoardStatus(input): BoardStatus`, a pure function.
- `packages/db/src/store/test-support.ts` exports `createTestStore(): { store: Store; close: () => void }`, which uses a temp file and is migrated, and `seedProject(store, overrides?)`. Later db tests use them.

- [ ] **Step 1: Write the test support and the failing test**

`packages/db/src/store/test-support.ts`:
```ts
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { ProjectDto, ProjectInput } from '@10db/contracts';
import { migrateDatabase, openDatabase } from '../database';
import { insertProject } from './projects';
import { createStore, type Store } from './store';

// `close` is a property, not a method, so tests can destructure it (typescript-eslint `unbound-method`).
export function createTestStore(clock?: () => Date): { store: Store; close: () => void } {
  const dir = mkdtempSync(join(tmpdir(), '10db-store-'));
  const db = openDatabase(join(dir, 'db.sqlite'));
  migrateDatabase(db);
  return {
    store: createStore(db, clock),
    close: () => {
      db.$client.close();
      rmSync(dir, { recursive: true, force: true });
    },
  };
}

export function seedProject(store: Store, overrides: Partial<ProjectInput> = {}): ProjectDto {
  return store.write((ctx) =>
    insertProject(ctx, {
      name: 'demo',
      repoPath: `/tmp/demo-${Math.random().toString(36).slice(2)}`,
      gateCommand: 'true',
      areas: [
        { name: 'api', globs: ['src/api/**'] },
        { name: 'ui', globs: ['src/ui/**'] },
      ],
      ...overrides,
    }),
  ).value;
}
```

`packages/db/src/store/projects-tasks.test.ts`:
```ts
import { BoardStatus, ConflictError, EventType, InvalidError, mintId, NotFoundError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { listEventsAfter } from './events';
import { getProject, insertProject, listProjects } from './projects';
import type { Store, WriteContext } from './store';
import { deriveBoardStatus, insertTask, listTasks, setTaskStatus } from './tasks';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => { close(); });

const insertMinimalProject = (ctx: WriteContext) =>
  insertProject(ctx, { name: 'x', repoPath: '/tmp/x', gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }] });

describe('store.write', () => {
  it('commits rows and events together and returns the persisted events', () => {
    const { value: project, events } = store.write(insertMinimalProject);
    expect(events.map((e) => e.type)).toEqual([EventType.ProjectCreated]);
    expect(events[0]?.entityId).toBe(project.id);
    expect(listEventsAfter(store.db, 0, 10)).toEqual(events);
  });

  it('rolls back rows and events when the function throws', () => {
    expect(() =>
      store.write((ctx) => {
        insertMinimalProject(ctx);
        throw new Error('boom');
      }),
    ).toThrow('boom');
    expect(listProjects(store.db)).toEqual([]);
    expect(listEventsAfter(store.db, 0, 10)).toEqual([]);
  });
});

describe('projects', () => {
  it('throws NotFoundError for an unknown project', () => {
    expect(() => getProject(store.db, mintId('Project'))).toThrow(NotFoundError);
  });

  it('rejects a second project on the same repository with ConflictError', () => {
    store.write(insertMinimalProject);
    expect(() => store.write(insertMinimalProject)).toThrow(ConflictError);
    expect(listProjects(store.db)).toHaveLength(1);
  });
});

describe('tasks', () => {
  it('lists tasks with dependencies and a derived board status', () => {
    const project = seedProject(store);
    const a = store.write((ctx) => insertTask(ctx, project.id, { title: 'A', acceptanceCriteria: ['a'], areas: ['api'] })).value;
    const b = store.write((ctx) =>
      insertTask(ctx, project.id, { title: 'B', acceptanceCriteria: ['b'], areas: ['ui'], dependsOn: [a.id] }),
    ).value;
    const byTitle = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(byTitle['A']?.boardStatus).toBe(BoardStatus.Ready);
    expect(byTitle['B']).toMatchObject({ boardStatus: BoardStatus.Backlog, dependsOn: [a.id] });

    store.write((ctx) => { setTaskStatus(ctx, a.id, 'done'); });
    const after = Object.fromEntries(listTasks(store.db, project.id).map((t) => [t.title, t]));
    expect(after['A']?.boardStatus).toBe(BoardStatus.Done);
    expect(after['B']?.boardStatus).toBe(BoardStatus.Ready);
    expect(b.id).toBe(after['B']?.id);
  });

  it('rejects an area the project does not define', () => {
    const project = seedProject(store);
    expect(() =>
      store.write((ctx) => insertTask(ctx, project.id, { title: 'X', acceptanceCriteria: ['x'], areas: ['nope'] })),
    ).toThrow(InvalidError);
  });

  it('rejects a dependency from another project', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    const other = store.write((ctx) => insertTask(ctx, p2.id, { title: 'O', acceptanceCriteria: ['o'], areas: ['api'] })).value;
    expect(() =>
      store.write((ctx) =>
        insertTask(ctx, p1.id, { title: 'X', acceptanceCriteria: ['x'], areas: ['api'], dependsOn: [other.id] }),
      ),
    ).toThrow(InvalidError);
  });
});

describe('deriveBoardStatus', () => {
  it.each([
    ['done task', { taskStatus: 'done', depsDone: true, workstreamState: null }, BoardStatus.Done],
    ['ready', { taskStatus: 'open', depsDone: true, workstreamState: null }, BoardStatus.Ready],
    ['waiting on deps', { taskStatus: 'open', depsDone: false, workstreamState: null }, BoardStatus.Backlog],
    ['running', { taskStatus: 'open', depsDone: true, workstreamState: 'RUNNING' }, BoardStatus.InProgress],
    ['waiting on a human', { taskStatus: 'open', depsDone: true, workstreamState: 'WAITING_HUMAN' }, BoardStatus.Blocked],
    ['failed', { taskStatus: 'open', depsDone: true, workstreamState: 'FAILED' }, BoardStatus.Blocked],
    ['cancelled run', { taskStatus: 'open', depsDone: true, workstreamState: 'CANCELLED' }, BoardStatus.Ready],
  ] as const)('%s', (_name, input, expected) => {
    expect(deriveBoardStatus(input)).toBe(expected);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project db projects-tasks
```
Expected: FAIL. `./store`, `./tasks` and the other store modules can't be resolved.

- [ ] **Step 3: Implement**

`packages/db/src/store/store.ts`:
```ts
import type { DaemonEvent, EventType } from '@10db/contracts';
import type { TendbDatabase } from '../database';
import * as schema from '../schema';

export type DbTx = Parameters<Parameters<TendbDatabase['transaction']>[0]>[0];
export type DbReader = TendbDatabase | DbTx;
export type Json = string | number | boolean | null | Json[] | { [key: string]: Json };

export interface EmitInput {
  readonly type: EventType;
  readonly entityType: string;
  readonly entityId: string;
  readonly data?: Record<string, Json>;
}

export interface WriteContext {
  readonly tx: DbTx;
  /** One timestamp for every row and event in this transaction. */
  readonly now: string;
  emit(event: EmitInput): void;
}

export interface Store {
  readonly db: TendbDatabase;
  now(): string;
  /** Runs `fn` in an IMMEDIATE transaction and appends its events in the same transaction. */
  write<T>(fn: (ctx: WriteContext) => T): { value: T; events: DaemonEvent[] };
}

export function toDaemonEvent(row: typeof schema.events.$inferSelect): DaemonEvent {
  return { seq: row.seq, type: row.type, entityType: row.entityType, entityId: row.entityId, data: row.data, at: row.at };
}

export function createStore(db: TendbDatabase, clock: () => Date = () => new Date()): Store {
  return {
    db,
    now: () => clock().toISOString(),
    write(fn) {
      return db.transaction(
        (tx) => {
          const now = clock().toISOString();
          const pending: EmitInput[] = [];
          const value = fn({ tx, now, emit: (event) => { pending.push(event); } });
          const events = pending.map((e) =>
            toDaemonEvent(
              tx.insert(schema.events)
                .values({ type: e.type, entityType: e.entityType, entityId: e.entityId, data: e.data ?? {}, at: now })
                .returning()
                .get(),
            ),
          );
          return { value, events };
        },
        { behavior: 'immediate' },
      );
    },
  };
}
```

`packages/db/src/store/events.ts`:
```ts
import type { DaemonEvent } from '@10db/contracts';
import { asc, gt } from 'drizzle-orm';
import * as schema from '../schema';
import { toDaemonEvent, type DbReader } from './store';

export function listEventsAfter(db: DbReader, afterSeq: number, limit: number): DaemonEvent[] {
  return db.select().from(schema.events).where(gt(schema.events.seq, afterSeq)).orderBy(asc(schema.events.seq)).limit(limit).all().map(toDaemonEvent);
}
```

`packages/db/src/store/projects.ts`:
```ts
import { ConflictError, EventType, mintId, NotFoundError, ProjectInput, Provider, type ProjectDto } from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function insertProject(ctx: WriteContext, input: ProjectInput): ProjectDto {
  const config = ProjectInput.parse(input);
  const existing = ctx.tx.select({ name: schema.projects.name }).from(schema.projects).where(eq(schema.projects.repoPath, config.repoPath)).get();
  if (existing) throw new ConflictError(`Project "${existing.name}" already uses ${config.repoPath}`);
  const row: ProjectDto = { id: mintId('Project'), ...config, provider: Provider.Claude, createdAt: ctx.now, updatedAt: ctx.now };
  ctx.tx.insert(schema.projects).values(row).run();
  ctx.emit({ type: EventType.ProjectCreated, entityType: 'project', entityId: row.id });
  return row;
}

export function getProject(db: DbReader, id: ProjectDto['id']): ProjectDto {
  const row = db.select().from(schema.projects).where(eq(schema.projects.id, id)).get();
  if (!row) throw new NotFoundError('project', id);
  return row;
}

export function listProjects(db: DbReader): ProjectDto[] {
  return db.select().from(schema.projects).orderBy(asc(schema.projects.name)).all();
}
```

`packages/db/src/store/tasks.ts`:
```ts
import {
  BoardStatus,
  EventType,
  InvalidError,
  isTerminal,
  mintId,
  NotFoundError,
  TaskInput,
  TaskStatus,
  WorkstreamState,
  type ProjectId,
  type TaskDto,
  type TaskId,
} from '@10db/contracts';
import { and, desc, eq, inArray, max } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';

export interface BoardStatusInput {
  readonly taskStatus: TaskStatus;
  readonly depsDone: boolean;
  readonly workstreamState: WorkstreamState | null;
}

/** Board column for a task (spec §5.1): Ready means deps done and nothing blocking. */
export function deriveBoardStatus({ taskStatus, depsDone, workstreamState }: BoardStatusInput): BoardStatus {
  if (taskStatus === TaskStatus.Done) return BoardStatus.Done;
  if (workstreamState === WorkstreamState.WaitingHuman || workstreamState === WorkstreamState.PausedLimit || workstreamState === WorkstreamState.Failed) {
    return BoardStatus.Blocked;
  }
  if (workstreamState !== null && !isTerminal(workstreamState)) return BoardStatus.InProgress;
  return depsDone ? BoardStatus.Ready : BoardStatus.Backlog;
}

export function insertTask(ctx: WriteContext, projectId: ProjectId, input: TaskInput): TaskDto {
  const project = getProject(ctx.tx, projectId);
  const config = TaskInput.parse(input);
  const known = new Set([...project.areas.map((a) => a.name), ...project.hazards.map((h) => h.name)]);
  const unknown = config.areas.filter((a) => !known.has(a));
  if (unknown.length > 0) throw new InvalidError(`Unknown areas for project ${project.name}: ${unknown.join(', ')}`);
  if (config.dependsOn.length > 0) {
    const deps = ctx.tx.select({ id: schema.tasks.id, projectId: schema.tasks.projectId }).from(schema.tasks).where(inArray(schema.tasks.id, config.dependsOn)).all();
    if (deps.length !== config.dependsOn.length || deps.some((d) => d.projectId !== projectId)) {
      throw new InvalidError('Every dependency must be an existing task in the same project');
    }
  }
  const order = ctx.tx.select({ value: max(schema.tasks.boardOrder) }).from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).get();
  const row = {
    id: mintId('Task'),
    projectId,
    title: config.title,
    description: config.description,
    acceptanceCriteria: config.acceptanceCriteria,
    areas: config.areas,
    status: TaskStatus.Open,
    boardOrder: (order?.value ?? 0) + 1,
    workspaceMode: 'shared' as const,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.tasks).values(row).run();
  for (const dependsOnId of config.dependsOn) ctx.tx.insert(schema.taskDeps).values({ taskId: row.id, dependsOnId }).run();
  ctx.emit({ type: EventType.TaskCreated, entityType: 'task', entityId: row.id, data: { projectId } });
  return getTask(ctx.tx, row.id);
}

export function setTaskStatus(ctx: WriteContext, id: TaskId, status: TaskStatus): void {
  const result = ctx.tx.update(schema.tasks).set({ status, updatedAt: ctx.now }).where(eq(schema.tasks.id, id)).run();
  if (result.changes === 0) throw new NotFoundError('task', id);
  ctx.emit({ type: EventType.TaskChanged, entityType: 'task', entityId: id, data: { status } });
}

export function dependenciesDone(db: DbReader, taskId: TaskId): boolean {
  const pending = db
    .select({ id: schema.tasks.id })
    .from(schema.taskDeps)
    .innerJoin(schema.tasks, eq(schema.tasks.id, schema.taskDeps.dependsOnId))
    .where(and(eq(schema.taskDeps.taskId, taskId), eq(schema.tasks.status, TaskStatus.Open)))
    .all();
  return pending.length === 0;
}

function toTaskDto(db: DbReader, row: typeof schema.tasks.$inferSelect): TaskDto {
  const deps = db.select({ id: schema.taskDeps.dependsOnId }).from(schema.taskDeps).where(eq(schema.taskDeps.taskId, row.id)).all();
  const latest = db
    .select({ id: schema.workstreams.id, state: schema.workstreams.state })
    .from(schema.workstreams)
    .where(eq(schema.workstreams.taskId, row.id))
    .orderBy(desc(schema.workstreams.createdAt))
    .limit(1)
    .get();
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    acceptanceCriteria: row.acceptanceCriteria,
    areas: row.areas,
    status: row.status,
    boardOrder: row.boardOrder,
    dependsOn: deps.map((d) => d.id),
    boardStatus: deriveBoardStatus({ taskStatus: row.status, depsDone: dependenciesDone(db, row.id), workstreamState: latest?.state ?? null }),
    workstreamId: latest?.id ?? null,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getTask(db: DbReader, id: TaskId): TaskDto {
  const row = db.select().from(schema.tasks).where(eq(schema.tasks.id, id)).get();
  if (!row) throw new NotFoundError('task', id);
  return toTaskDto(db, row);
}

export function listTasks(db: DbReader, projectId: ProjectId): TaskDto[] {
  return db.select().from(schema.tasks).where(eq(schema.tasks.projectId, projectId)).orderBy(schema.tasks.boardOrder).all().map((row) => toTaskDto(db, row));
}
```

`packages/db/src/store/index.ts`:
```ts
export * from './events';
export * from './projects';
export * from './store';
export * from './tasks';
```
Later tasks append their repository files here.

`packages/db/src/index.ts`: add `export * from './store';`

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project db
pnpm typecheck && pnpm lint && pnpm knip
pnpm format
git add packages/db && git commit -m 'feat(db): add transactional store with project and task repositories'
```
Expected: PASS. knip may report `test-support.ts` exports as unused until later tasks use them. They are used by this task's test, so add `"packages/db": { "entry": ["drizzle.config.ts", "src/**/*.test.ts"] }` if knip complains.

### Task 4: Execution repositories (workstreams, sessions, claims, handoffs, tool ops, evidence)

**Files:**
- Create: `packages/db/src/store/workstreams.ts`, `sessions.ts`, `claims.ts`, `handoffs.ts`, `tool-ops.ts`, `evidence.ts`
- Modify: `packages/db/src/store/index.ts` (export them)
- Test: `packages/db/src/store/execution.test.ts`

**Interfaces:**
- Consumes: Task 3's `WriteContext`, `DbReader`, `getProject`, `getTask` and test support.
- Produces:
  - **Workstreams** (`workstreams.ts`):
    - `class StaleFenceError extends Error { readonly workstreamId }`
    - `insertWorkstream(ctx, taskId): WorkstreamDto`. Throws `ConflictError` if the task isn't open or already has an active workstream.
    - `getWorkstream(db, id): WorkstreamDto`, plus `getWorkstreamRow(db, id)`, which returns the raw row and includes `fence`, `leaseOwner` and `baseHead`.
    - `listWorkstreams(db, filter: { states?: readonly WorkstreamState[]; projectId?: ProjectId }): WorkstreamDto[]`, oldest first.
    - `interface WorkstreamPatch { nextAction?; attempt?; recoveryAttempts?; currentSessionId?: SessionId | null; contextPct?: number | null; pausedUntil?: string | null; failureReason?: string | null; lastActivityAt?: string | null; baseHead?: string; gatePid?: number | null; gatePidStart?: string | null }`. `gatePid` and `gatePidStart` record a running gate's process group for recovery (Task 18).
    - `transitionWorkstream(ctx, id, { to, fence, patch?, reason? }): WorkstreamDto`. Throws `StaleFenceError` when `fence` is non-null and stale, and `ConflictError` when `canTransition` is false.
    - `patchWorkstream(ctx, id, fence: number | null, patch): void`. It emits no event, because activity has its own events.
    - `acquireLease(ctx, id, owner, expiresAt): number`, which returns the new fence; `renewLeases(ctx, owner, expiresAt): number`; `clearLease(ctx, id): void`.
    - `countLanes(db): { global: number; byProject: Map<ProjectId, number>; byProvider: Map<Provider, number> }`
  - **Sessions** (`sessions.ts`):
    - `type SessionRow`
    - `insertSession(ctx, { workstreamId, provider, model, effort, mode, mcpTokenHash }): SessionRow`. `sequence` is 1-based within the workstream.
    - `markSessionStarted(ctx, id, providerSessionId, pid, pidStart: string | null = null)`, which emits `session.started`. `pidStart` is the process's OS start time, which recovery compares before it signals the pid (Task 18).
    - `updateSessionUsage(ctx, id, patch)`, `endSession(ctx, id, exitReason)`.
    - `getSession(db, id)`, `getLiveSessionByTokenHash(db, hash)`, `listSessions(db, workstreamId)`.
  - **Claims** (`claims.ts`):
    - `type ClaimRow`, `interface ClaimRequest { kind: ClaimKind; name: string }`
    - `claimRequestsForTask(task, project): ClaimRequest[]`. A task area that names a hazard becomes a hazard claim.
    - `acquireClaims(ctx, { projectId, workstreamId, requests, leaseExpiresAt }): { ok: true; claims: ClaimRow[] } | { ok: false; conflict: { kind; name; heldBy: WorkstreamId } }`. It is all-or-nothing, and claims the same workstream already holds are kept.
    - `releaseClaims(ctx, workstreamId): number`, `activeClaims(db, workstreamId): ClaimRow[]`, `renewClaimLeases(ctx, workstreamIds, expiresAt)`.
  - **Handoffs** (`handoffs.ts`): `insertHandoff(ctx, {...}): HandoffDto`, `getHandoff(db, id)`, `latestHandoff(db, workstreamId): HandoffDto | null`, `handoffForSession(db, sessionId): HandoffDto | null`.
  - **Tool ops** (`tool-ops.ts`): `findToolOp(db, workstreamId, opId): { tool: string; result: Json } | undefined`, `insertToolOp(ctx, {...})`, `latestToolOp(db, workstreamId)`.
  - **Evidence** (`evidence.ts`): `insertEvidence(ctx, {...}): EvidenceDto`, `getEvidence(db, id)`, `listEvidence(db, workstreamId)`.

- [ ] **Step 1: Write the failing test**

`packages/db/src/store/execution.test.ts`:
```ts
import { ConflictError, mintId, WorkstreamState as S } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { acquireClaims, activeClaims, releaseClaims } from './claims';
import { findToolOp, insertToolOp } from './tool-ops';
import { getSession, insertSession, markSessionStarted } from './sessions';
import type { Store } from './store';
import { insertTask } from './tasks';
import { createTestStore, seedProject } from './test-support';
import {
  acquireLease,
  countLanes,
  getWorkstreamRow,
  insertWorkstream,
  patchWorkstream,
  StaleFenceError,
  transitionWorkstream,
} from './workstreams';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => { close(); });

function seedWorkstream(title = 'A', areas: string[] = ['api'], project = seedProject(store)) {
  const task = store.write((ctx) => insertTask(ctx, project.id, { title, acceptanceCriteria: ['x'], areas })).value;
  const ws = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { project, task, ws };
}

describe('workstreams', () => {
  it('refuses a second active workstream for the same task', () => {
    const { task } = seedWorkstream();
    expect(() => store.write((ctx) => insertWorkstream(ctx, task.id))).toThrow(ConflictError);
  });

  it('moves along allowed transitions and records each as an event', () => {
    const { ws } = seedWorkstream();
    const { events } = store.write((ctx) => {
      transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: null });
      return transitionWorkstream(ctx, ws.id, { to: S.Running, fence: null });
    });
    expect(events.map((e) => e.data)).toEqual([
      { from: 'QUEUED', to: 'STARTING', reason: null },
      { from: 'STARTING', to: 'RUNNING', reason: null },
    ]);
  });

  it('rejects a forbidden transition', () => {
    const { ws } = seedWorkstream();
    expect(() => store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Done, fence: null }))).toThrow(ConflictError);
  });

  it('fences off a runner holding an old lease', () => {
    const { ws } = seedWorkstream();
    const first = store.write((ctx) => acquireLease(ctx, ws.id, 'daemon-a', '2026-10-13T12:01:00.000Z')).value;
    const second = store.write((ctx) => acquireLease(ctx, ws.id, 'daemon-b', '2026-10-13T12:01:00.000Z')).value;
    expect(second).toBe(first + 1);
    expect(() => store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: first }))).toThrow(StaleFenceError);
    expect(() => store.write((ctx) => transitionWorkstream(ctx, ws.id, { to: S.Starting, fence: second }))).not.toThrow();
  });

  it('counts lanes for lane states and for a waiting workstream with a live session only', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['api']);
    store.write((ctx) => {
      transitionWorkstream(ctx, a.ws.id, { to: S.Starting, fence: null });
      transitionWorkstream(ctx, a.ws.id, { to: S.Running, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.Starting, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.Running, fence: null });
      transitionWorkstream(ctx, b.ws.id, { to: S.WaitingHuman, fence: null });
    });
    expect(countLanes(store.db).global).toBe(1);

    const session = store.write((ctx) =>
      insertSession(ctx, { workstreamId: b.ws.id, provider: 'claude', model: 'sonnet', effort: 'medium', mode: 'managed', mcpTokenHash: 'h1' }),
    ).value;
    store.write((ctx) => { patchWorkstream(ctx, b.ws.id, null, { currentSessionId: session.id }); });
    const lanes = countLanes(store.db);
    expect(lanes.global).toBe(2);
    expect(lanes.byProvider.get('claude')).toBe(2);
    expect(lanes.byProject.get(a.project.id)).toBe(1);
  });
});

describe('sessions', () => {
  it('numbers sessions within a workstream and records the provider session on start', () => {
    const { ws } = seedWorkstream();
    const mk = (hash: string) =>
      store.write((ctx) => insertSession(ctx, { workstreamId: ws.id, provider: 'claude', model: 'sonnet', effort: 'medium', mode: 'managed', mcpTokenHash: hash })).value;
    expect(mk('h1').sequence).toBe(1);
    const second = mk('h2');
    expect(second.sequence).toBe(2);
    const { events } = store.write((ctx) => { markSessionStarted(ctx, second.id, 'provider-123', null); });
    expect(events[0]).toMatchObject({ type: 'session.started', entityId: second.id, data: { providerSessionId: 'provider-123' } });
  });

  it('records the process start time beside the pid', () => {
    const { ws } = seedWorkstream();
    const s = store.write((ctx) => insertSession(ctx, { workstreamId: ws.id, provider: 'claude', model: 'sonnet', effort: 'medium', mode: 'managed', mcpTokenHash: 'h1' })).value;
    store.write((ctx) => { markSessionStarted(ctx, s.id, 'provider-1', 4242, 'Tue Oct 13 12:00:00 2026'); });
    expect(getSession(store.db, s.id)).toMatchObject({ pid: 4242, pidStart: 'Tue Oct 13 12:00:00 2026' });
  });
});

describe('claims', () => {
  it('is all-or-nothing and reports who holds a conflicting claim', () => {
    const a = seedWorkstream('A', ['api']);
    const b = seedWorkstream('B', ['api', 'ui'], a.project);
    const lease = '2026-10-13T12:01:00.000Z';
    const sameProject = a.project.id;
    const first = store.write((ctx) =>
      acquireClaims(ctx, { projectId: sameProject, workstreamId: a.ws.id, requests: [{ kind: 'area', name: 'api' }], leaseExpiresAt: lease }),
    ).value;
    expect(first.ok).toBe(true);

    const second = store.write((ctx) =>
      acquireClaims(ctx, {
        projectId: sameProject,
        workstreamId: b.ws.id,
        requests: [{ kind: 'area', name: 'ui' }, { kind: 'area', name: 'api' }],
        leaseExpiresAt: lease,
      }),
    ).value;
    expect(second).toEqual({ ok: false, conflict: { kind: 'area', name: 'api', heldBy: a.ws.id } });
    expect(activeClaims(store.db, b.ws.id)).toEqual([]);

    const again = store.write((ctx) =>
      acquireClaims(ctx, { projectId: sameProject, workstreamId: a.ws.id, requests: [{ kind: 'area', name: 'api' }], leaseExpiresAt: lease }),
    ).value;
    expect(again.ok).toBe(true);
    expect(activeClaims(store.db, a.ws.id)).toHaveLength(1);

    store.write((ctx) => releaseClaims(ctx, a.ws.id));
    const third = store.write((ctx) =>
      acquireClaims(ctx, { projectId: sameProject, workstreamId: b.ws.id, requests: [{ kind: 'area', name: 'api' }], leaseExpiresAt: lease }),
    ).value;
    expect(third.ok).toBe(true);
  });
});

describe('tool ops', () => {
  it('keeps the first result for an operation ID', () => {
    const { ws } = seedWorkstream();
    const sessionId = mintId('Session');
    store.write((ctx) => { insertToolOp(ctx, { workstreamId: ws.id, sessionId, opId: 'op-00000001', tool: 'commit', result: { sha: 'a' } }); });
    expect(() =>
      store.write((ctx) => { insertToolOp(ctx, { workstreamId: ws.id, sessionId, opId: 'op-00000001', tool: 'commit', result: { sha: 'b' } }); }),
    ).toThrow(/UNIQUE/);
    expect(findToolOp(store.db, ws.id, 'op-00000001')).toEqual({ tool: 'commit', result: { sha: 'a' } });
  });
});

describe('getWorkstreamRow', () => {
  it('exposes the fence for runners', () => {
    const { ws } = seedWorkstream();
    expect(getWorkstreamRow(store.db, ws.id).fence).toBe(0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project db execution
```
Expected: FAIL. `./workstreams` can't be resolved.

- [ ] **Step 3: Implement**

`packages/db/src/store/workstreams.ts`:
```ts
import {
  ACTIVE_STATES,
  canTransition,
  ConflictError,
  EventType,
  LANE_STATES,
  mintId,
  NotFoundError,
  TaskStatus,
  WorkstreamState,
  type NextAction,
  type ProjectId,
  type Provider,
  type SessionId,
  type TaskId,
  type WorkstreamDto,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, count, eq, inArray, isNotNull, or, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import { getProject } from './projects';
import type { DbReader, WriteContext } from './store';
import { getTask } from './tasks';

export class StaleFenceError extends Error {
  override readonly name = 'StaleFenceError';
  readonly workstreamId: WorkstreamId;
  constructor(workstreamId: WorkstreamId) {
    super(`Workstream ${workstreamId} is owned by a newer runner`);
    this.workstreamId = workstreamId;
  }
}

export type WorkstreamRow = typeof schema.workstreams.$inferSelect;

export interface WorkstreamPatch {
  readonly nextAction?: NextAction;
  readonly attempt?: number;
  readonly recoveryAttempts?: number;
  readonly currentSessionId?: SessionId | null;
  readonly contextPct?: number | null;
  readonly pausedUntil?: string | null;
  readonly failureReason?: string | null;
  readonly lastActivityAt?: string | null;
  readonly baseHead?: string;
  readonly gatePid?: number | null;
  readonly gatePidStart?: string | null;
}

export function getWorkstreamRow(db: DbReader, id: WorkstreamId): WorkstreamRow {
  const row = db.select().from(schema.workstreams).where(eq(schema.workstreams.id, id)).get();
  if (!row) throw new NotFoundError('workstream', id);
  return row;
}

function toDto(db: DbReader, row: WorkstreamRow): WorkstreamDto {
  const sessions = db.select({ n: count() }).from(schema.sessions).where(eq(schema.sessions.workstreamId, row.id)).get();
  return {
    id: row.id,
    taskId: row.taskId,
    projectId: row.projectId,
    state: row.state,
    nextAction: row.nextAction,
    attempt: row.attempt,
    recoveryAttempts: row.recoveryAttempts,
    model: row.model,
    effort: row.effort,
    currentSessionId: row.currentSessionId,
    sessionCount: sessions?.n ?? 0,
    contextPct: row.contextPct,
    pausedUntil: row.pausedUntil,
    failureReason: row.failureReason,
    lastActivityAt: row.lastActivityAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function getWorkstream(db: DbReader, id: WorkstreamId): WorkstreamDto {
  return toDto(db, getWorkstreamRow(db, id));
}

export function listWorkstreams(db: DbReader, filter: { states?: readonly WorkstreamState[]; projectId?: ProjectId } = {}): WorkstreamDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.workstreams.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.workstreams.projectId, filter.projectId));
  return db.select().from(schema.workstreams).where(and(...where)).orderBy(asc(schema.workstreams.createdAt)).all().map((r) => toDto(db, r));
}

export function insertWorkstream(ctx: WriteContext, taskId: TaskId): WorkstreamDto {
  const task = getTask(ctx.tx, taskId);
  if (task.status !== TaskStatus.Open) throw new ConflictError(`Task ${task.title} is ${task.status}`);
  const active = ctx.tx
    .select({ id: schema.workstreams.id })
    .from(schema.workstreams)
    .where(and(eq(schema.workstreams.taskId, taskId), inArray(schema.workstreams.state, [...ACTIVE_STATES])))
    .get();
  if (active) throw new ConflictError(`Task ${task.title} already has an active workstream`);
  const project = getProject(ctx.tx, task.projectId);
  const row: WorkstreamRow = {
    id: mintId('Workstream'),
    taskId,
    projectId: project.id,
    state: WorkstreamState.Queued,
    nextAction: { kind: 'start' },
    attempt: 0,
    recoveryAttempts: 0,
    model: project.model,
    effort: project.effort,
    baseHead: null,
    leaseOwner: null,
    leaseExpiresAt: null,
    fence: 0,
    gatePid: null,
    gatePidStart: null,
    currentSessionId: null,
    contextPct: null,
    pausedUntil: null,
    failureReason: null,
    lastActivityAt: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.workstreams).values(row).run();
  ctx.emit({ type: EventType.WorkstreamCreated, entityType: 'workstream', entityId: row.id, data: { taskId, projectId: project.id } });
  return toDto(ctx.tx, row);
}

function checkFence(row: WorkstreamRow, fence: number | null): void {
  if (fence !== null && row.fence !== fence) throw new StaleFenceError(row.id);
}

export function transitionWorkstream(
  ctx: WriteContext,
  id: WorkstreamId,
  opts: { readonly to: WorkstreamState; readonly fence: number | null; readonly patch?: WorkstreamPatch; readonly reason?: string },
): WorkstreamDto {
  const row = getWorkstreamRow(ctx.tx, id);
  checkFence(row, opts.fence);
  if (!canTransition(row.state, opts.to)) throw new ConflictError(`Cannot move workstream from ${row.state} to ${opts.to}`);
  ctx.tx.update(schema.workstreams).set({ ...opts.patch, state: opts.to, updatedAt: ctx.now }).where(eq(schema.workstreams.id, id)).run();
  ctx.emit({
    type: EventType.WorkstreamChanged,
    entityType: 'workstream',
    entityId: id,
    data: { from: row.state, to: opts.to, reason: opts.reason ?? null },
  });
  return getWorkstream(ctx.tx, id);
}

export function patchWorkstream(ctx: WriteContext, id: WorkstreamId, fence: number | null, patch: WorkstreamPatch): void {
  checkFence(getWorkstreamRow(ctx.tx, id), fence);
  ctx.tx.update(schema.workstreams).set({ ...patch, updatedAt: ctx.now }).where(eq(schema.workstreams.id, id)).run();
}

export function acquireLease(ctx: WriteContext, id: WorkstreamId, owner: string, expiresAt: string): number {
  const fence = getWorkstreamRow(ctx.tx, id).fence + 1;
  ctx.tx.update(schema.workstreams).set({ leaseOwner: owner, leaseExpiresAt: expiresAt, fence, updatedAt: ctx.now }).where(eq(schema.workstreams.id, id)).run();
  return fence;
}

export function renewLeases(ctx: WriteContext, owner: string, expiresAt: string): number {
  return ctx.tx.update(schema.workstreams).set({ leaseExpiresAt: expiresAt }).where(eq(schema.workstreams.leaseOwner, owner)).run().changes;
}

export function clearLease(ctx: WriteContext, id: WorkstreamId): void {
  ctx.tx.update(schema.workstreams).set({ leaseOwner: null, leaseExpiresAt: null }).where(eq(schema.workstreams.id, id)).run();
}

export interface LaneCounts {
  readonly global: number;
  readonly byProject: ReadonlyMap<ProjectId, number>;
  readonly byProvider: ReadonlyMap<Provider, number>;
}

export function countLanes(db: DbReader): LaneCounts {
  const rows = db
    .select({ projectId: schema.workstreams.projectId, provider: schema.projects.provider })
    .from(schema.workstreams)
    .innerJoin(schema.projects, eq(schema.projects.id, schema.workstreams.projectId))
    .where(
      or(
        inArray(schema.workstreams.state, [...LANE_STATES]),
        and(eq(schema.workstreams.state, WorkstreamState.WaitingHuman), isNotNull(schema.workstreams.currentSessionId)),
      ),
    )
    .all();
  const byProject = new Map<ProjectId, number>();
  const byProvider = new Map<Provider, number>();
  for (const r of rows) {
    byProject.set(r.projectId, (byProject.get(r.projectId) ?? 0) + 1);
    byProvider.set(r.provider, (byProvider.get(r.provider) ?? 0) + 1);
  }
  return { global: rows.length, byProject, byProvider };
}
```

`packages/db/src/store/sessions.ts`:
```ts
import { EventType, mintId, NotFoundError, type Effort, type Provider, type SessionId, type SessionMode, type WorkstreamId } from '@10db/contracts';
import { and, asc, count, eq, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type SessionRow = typeof schema.sessions.$inferSelect;

export interface NewSession {
  readonly workstreamId: WorkstreamId;
  readonly provider: Provider;
  readonly model: string;
  readonly effort: Effort;
  readonly mode: SessionMode;
  readonly mcpTokenHash: string;
}

export function insertSession(ctx: WriteContext, input: NewSession): SessionRow {
  const prior = ctx.tx.select({ n: count() }).from(schema.sessions).where(eq(schema.sessions.workstreamId, input.workstreamId)).get();
  const row: SessionRow = {
    id: mintId('Session'),
    ...input,
    sequence: (prior?.n ?? 0) + 1,
    providerSessionId: null,
    pid: null,
    pidStart: null,
    startedAt: ctx.now,
    endedAt: null,
    exitReason: null,
    inputTokens: 0,
    outputTokens: 0,
    costUsd: 0,
    contextPct: null,
  };
  ctx.tx.insert(schema.sessions).values(row).run();
  return row;
}

/** `pidStart` is the OS start time of `pid`; recovery signals the pid only while it still matches. */
export function markSessionStarted(ctx: WriteContext, id: SessionId, providerSessionId: string, pid: number | null, pidStart: string | null = null): void {
  ctx.tx.update(schema.sessions).set({ providerSessionId, pid, pidStart }).where(eq(schema.sessions.id, id)).run();
  ctx.emit({ type: EventType.SessionStarted, entityType: 'session', entityId: id, data: { providerSessionId } });
}

export function updateSessionUsage(
  ctx: WriteContext,
  id: SessionId,
  patch: Partial<Pick<SessionRow, 'inputTokens' | 'outputTokens' | 'costUsd' | 'contextPct'>>,
): void {
  ctx.tx.update(schema.sessions).set(patch).where(eq(schema.sessions.id, id)).run();
}

export function endSession(ctx: WriteContext, id: SessionId, exitReason: string): void {
  const result = ctx.tx.update(schema.sessions).set({ endedAt: ctx.now, exitReason }).where(and(eq(schema.sessions.id, id), isNull(schema.sessions.endedAt))).run();
  if (result.changes > 0) ctx.emit({ type: EventType.SessionEnded, entityType: 'session', entityId: id, data: { exitReason } });
}

export function getSession(db: DbReader, id: SessionId): SessionRow {
  const row = db.select().from(schema.sessions).where(eq(schema.sessions.id, id)).get();
  if (!row) throw new NotFoundError('session', id);
  return row;
}

/** The session an MCP token belongs to, if that session is still live. */
export function getLiveSessionByTokenHash(db: DbReader, hash: string): SessionRow | undefined {
  return db.select().from(schema.sessions).where(and(eq(schema.sessions.mcpTokenHash, hash), isNull(schema.sessions.endedAt))).get();
}

export function listSessions(db: DbReader, workstreamId: WorkstreamId): SessionRow[] {
  return db.select().from(schema.sessions).where(eq(schema.sessions.workstreamId, workstreamId)).orderBy(asc(schema.sessions.sequence)).all();
}
```

`packages/db/src/store/claims.ts`:
```ts
import { ClaimKind, EventType, mintId, type ProjectDto, type ProjectId, type TaskDto, type WorkstreamId } from '@10db/contracts';
import { and, eq, inArray, isNull } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export type ClaimRow = typeof schema.claims.$inferSelect;

export interface ClaimRequest {
  readonly kind: ClaimKind;
  readonly name: string;
}

export type AcquireResult =
  | { readonly ok: true; readonly claims: ClaimRow[] }
  | { readonly ok: false; readonly conflict: { readonly kind: ClaimKind; readonly name: string; readonly heldBy: WorkstreamId } };

/** A task's areas become area claims, except names that are project hazards, which are exclusive hazard claims. */
export function claimRequestsForTask(task: Pick<TaskDto, 'areas'>, project: Pick<ProjectDto, 'hazards'>): ClaimRequest[] {
  const hazards = new Set(project.hazards.map((h) => h.name));
  return task.areas.map((name) => ({ kind: hazards.has(name) ? ClaimKind.Hazard : ClaimKind.Area, name }));
}

function activeHolder(db: DbReader, projectId: ProjectId, request: ClaimRequest): ClaimRow | undefined {
  return db
    .select()
    .from(schema.claims)
    .where(and(eq(schema.claims.projectId, projectId), eq(schema.claims.kind, request.kind), eq(schema.claims.name, request.name), isNull(schema.claims.releasedAt)))
    .get();
}

/** Grants every requested claim or none. Active claims never overlap (spec §8.1). */
export function acquireClaims(
  ctx: WriteContext,
  input: { readonly projectId: ProjectId; readonly workstreamId: WorkstreamId; readonly requests: readonly ClaimRequest[]; readonly leaseExpiresAt: string },
): AcquireResult {
  const toInsert: ClaimRequest[] = [];
  for (const request of input.requests) {
    const holder = activeHolder(ctx.tx, input.projectId, request);
    if (holder && holder.workstreamId !== input.workstreamId) {
      return { ok: false, conflict: { kind: request.kind, name: request.name, heldBy: holder.workstreamId } };
    }
    if (!holder) toInsert.push(request);
  }
  for (const request of toInsert) {
    const id = mintId('Claim');
    ctx.tx.insert(schema.claims).values({
      id,
      projectId: input.projectId,
      workstreamId: input.workstreamId,
      kind: request.kind,
      name: request.name,
      exclusive: true,
      leaseExpiresAt: input.leaseExpiresAt,
      releasedAt: null,
      createdAt: ctx.now,
    }).run();
    ctx.emit({ type: EventType.ClaimAcquired, entityType: 'claim', entityId: id, data: { workstreamId: input.workstreamId, kind: request.kind, name: request.name } });
  }
  return { ok: true, claims: activeClaims(ctx.tx, input.workstreamId) };
}

export function releaseClaims(ctx: WriteContext, workstreamId: WorkstreamId): number {
  const held = activeClaims(ctx.tx, workstreamId);
  for (const claim of held) {
    ctx.tx.update(schema.claims).set({ releasedAt: ctx.now }).where(eq(schema.claims.id, claim.id)).run();
    ctx.emit({ type: EventType.ClaimReleased, entityType: 'claim', entityId: claim.id, data: { workstreamId, kind: claim.kind, name: claim.name } });
  }
  return held.length;
}

export function activeClaims(db: DbReader, workstreamId: WorkstreamId): ClaimRow[] {
  return db.select().from(schema.claims).where(and(eq(schema.claims.workstreamId, workstreamId), isNull(schema.claims.releasedAt))).all();
}

export function renewClaimLeases(ctx: WriteContext, workstreamIds: readonly WorkstreamId[], expiresAt: string): void {
  if (workstreamIds.length === 0) return;
  ctx.tx.update(schema.claims).set({ leaseExpiresAt: expiresAt }).where(and(inArray(schema.claims.workstreamId, [...workstreamIds]), isNull(schema.claims.releasedAt))).run();
}
```

`packages/db/src/store/handoffs.ts`:
```ts
import { EventType, mintId, NotFoundError, type HandoffDto, type HandoffId, type HandoffInput, type SessionId, type WorkstreamId } from '@10db/contracts';
import { desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewHandoff {
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly content: HandoffInput;
  readonly gitHead: string;
  readonly gitChangedFiles: readonly string[];
  readonly gitCommits: readonly string[];
}

export function insertHandoff(ctx: WriteContext, input: NewHandoff): HandoffDto {
  const row: HandoffDto = {
    id: mintId('Handoff'),
    ...input,
    gitChangedFiles: [...input.gitChangedFiles],
    gitCommits: [...input.gitCommits],
    createdAt: ctx.now,
  };
  ctx.tx.insert(schema.handoffs).values(row).run();
  ctx.emit({ type: EventType.HandoffRecorded, entityType: 'handoff', entityId: row.id, data: { workstreamId: input.workstreamId, sessionId: input.sessionId } });
  return row;
}

export function getHandoff(db: DbReader, id: HandoffId): HandoffDto {
  const row = db.select().from(schema.handoffs).where(eq(schema.handoffs.id, id)).get();
  if (!row) throw new NotFoundError('handoff', id);
  return row;
}

export function latestHandoff(db: DbReader, workstreamId: WorkstreamId): HandoffDto | null {
  return db.select().from(schema.handoffs).where(eq(schema.handoffs.workstreamId, workstreamId)).orderBy(desc(schema.handoffs.createdAt), desc(schema.handoffs.id)).limit(1).get() ?? null;
}

export function handoffForSession(db: DbReader, sessionId: SessionId): HandoffDto | null {
  return db.select().from(schema.handoffs).where(eq(schema.handoffs.sessionId, sessionId)).orderBy(desc(schema.handoffs.id)).limit(1).get() ?? null;
}
```

`packages/db/src/store/tool-ops.ts`:
```ts
import { mintId, type SessionId, type WorkstreamId } from '@10db/contracts';
import { and, desc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, Json, WriteContext } from './store';

export function findToolOp(db: DbReader, workstreamId: WorkstreamId, opId: string): { tool: string; result: Json } | undefined {
  return db
    .select({ tool: schema.toolOps.tool, result: schema.toolOps.result })
    .from(schema.toolOps)
    .where(and(eq(schema.toolOps.workstreamId, workstreamId), eq(schema.toolOps.opId, opId)))
    .get();
}

export function insertToolOp(
  ctx: WriteContext,
  input: { readonly workstreamId: WorkstreamId; readonly sessionId: SessionId; readonly opId: string; readonly tool: string; readonly result: Json },
): void {
  ctx.tx.insert(schema.toolOps).values({ id: mintId('ToolOp'), ...input, createdAt: ctx.now }).run();
}

export function latestToolOp(db: DbReader, workstreamId: WorkstreamId): { opId: string; tool: string; createdAt: string } | undefined {
  return db
    .select({ opId: schema.toolOps.opId, tool: schema.toolOps.tool, createdAt: schema.toolOps.createdAt })
    .from(schema.toolOps)
    .where(eq(schema.toolOps.workstreamId, workstreamId))
    .orderBy(desc(schema.toolOps.id))
    .limit(1)
    .get();
}
```
`desc(id)` orders by creation, because IDs are monotonic ULIDs.

`packages/db/src/store/evidence.ts`:
```ts
import { EventType, mintId, NotFoundError, type EvidenceDto, type EvidenceId, type EvidenceKind, type WorkstreamId } from '@10db/contracts';
import { asc, eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export interface NewEvidence {
  readonly workstreamId: WorkstreamId;
  readonly kind: EvidenceKind;
  readonly command: string;
  readonly exitCode: number;
  readonly summary: string;
  readonly logPath: string | null;
  readonly commitShas: readonly string[];
}

export function insertEvidence(ctx: WriteContext, input: NewEvidence): EvidenceDto {
  const row: EvidenceDto = { id: mintId('Evidence'), ...input, commitShas: [...input.commitShas], createdAt: ctx.now };
  ctx.tx.insert(schema.evidence).values(row).run();
  ctx.emit({ type: EventType.EvidenceRecorded, entityType: 'evidence', entityId: row.id, data: { workstreamId: input.workstreamId, exitCode: input.exitCode, kind: input.kind } });
  return row;
}

export function getEvidence(db: DbReader, id: EvidenceId): EvidenceDto {
  const row = db.select().from(schema.evidence).where(eq(schema.evidence.id, id)).get();
  if (!row) throw new NotFoundError('evidence', id);
  return row;
}

export function listEvidence(db: DbReader, workstreamId: WorkstreamId): EvidenceDto[] {
  return db.select().from(schema.evidence).where(eq(schema.evidence.workstreamId, workstreamId)).orderBy(asc(schema.evidence.id)).all();
}
```

Add the six files to `packages/db/src/store/index.ts`:
```ts
export * from './claims';
export * from './events';
export * from './evidence';
export * from './handoffs';
export * from './projects';
export * from './sessions';
export * from './store';
export * from './tasks';
export * from './tool-ops';
export * from './workstreams';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project db
pnpm typecheck && pnpm lint
pnpm format
git add packages/db/src/store && git commit -m 'feat(db): add workstream, session, claim, handoff, tool-op and evidence repositories'
```
Expected: PASS.

---

### Task 5: Inbox and knowledge repositories

**Files:**
- Create: `packages/db/src/store/inbox.ts`, `permission-rules.ts`, `knowledge.ts`
- Modify: `packages/db/src/store/index.ts`
- Test: `packages/db/src/store/inbox-knowledge.test.ts`

**Interfaces:**
- Produces:
  - **Inbox** (`inbox.ts`):
    - `interface NewInboxItem { projectId; kind; title; body; options; recommendation: string | null; category; urgency; detail: Record<string, Json> | null; foldKey: string | null; targets: InboxTarget[] }`
    - `insertInboxItem(ctx, item): InboxItemDto`, which emits `inbox.opened`.
    - `getInboxItem(db, id)`.
    - `listInbox(db, { states?, projectId? })`, sorted by urgency (high first), then oldest first.
    - `findOpenByFoldKey(db, projectId, foldKey)`.
    - `updateInboxItem(ctx, id, { state?, answer?, targets? }): InboxItemDto`, which emits `inbox.changed`.
    - `openItemsForWorkstream(db, workstreamId): InboxItemDto[]`, which returns items in `OPEN`, `ANSWERED` or `DELIVERING` that target the workstream.
  - **Permission rules** (`permission-rules.ts`): `insertPermissionRule(ctx, { projectId, workstreamId, toolName, pattern, sourceInboxId }): PermissionRuleDto` and `listPermissionRules(db, projectId, workstreamId): PermissionRuleDto[]`. The list holds the project's rules plus those of that workstream.
  - **Knowledge** (`knowledge.ts`):
    - `insertSource(ctx, kind, ref): SourceId`
    - `insertDecision(ctx, { projectId, question, choice, rationale, decidedBy, scope, area, sourceId }): DecisionId`
    - `insertDeviation(ctx, { projectId, workstreamId, cause, severity, signedReason, sourceId }): DeviationId`
    - `insertProposal(ctx, { projectId, kind, title, body, sourceId }): ProposalId`
    - `type ProposalStatus = 'pending' | 'accepted' | 'rejected'`, `getProposal(db, id): ProposalRow`, and `resolveProposal(ctx, id, { status, rationale }): void`, which emits `proposal.resolved`. The inbox calls it when a proposal card is answered (Task 12).
    - `searchDecisions(db, projectId, query, limit): KnowledgeHit[]`. It covers project-scoped and `you`-scoped decisions (`project_id IS NULL`), and any query text is safe to pass.
    - `listRecentDecisions(db, projectId, limit): KnowledgeHit[]`

- [ ] **Step 1: Write the failing test**

`packages/db/src/store/inbox-knowledge.test.ts`:
```ts
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { findOpenByFoldKey, insertInboxItem, listInbox, openItemsForWorkstream, updateInboxItem } from './inbox';
import { getProposal, insertDecision, insertProposal, insertSource, listRecentDecisions, resolveProposal, searchDecisions } from './knowledge';
import { insertPermissionRule, listPermissionRules } from './permission-rules';
import type { Store } from './store';
import { createTestStore, seedProject } from './test-support';

let store: Store;
let close: () => void;
beforeEach(() => ({ store, close } = createTestStore()));
afterEach(() => { close(); });

const question = (projectId: ReturnType<typeof seedProject>['id'], overrides: Partial<Parameters<typeof insertInboxItem>[1]> = {}) => ({
  projectId,
  kind: 'question' as const,
  title: 'Which color?',
  body: 'Pick one',
  options: [{ label: 'Teal', description: '' }, { label: 'Red', description: '' }],
  recommendation: null,
  category: 'design' as const,
  urgency: 'normal' as const,
  detail: null,
  foldKey: 'fold-1',
  targets: [{ workstreamId: mintId('Workstream'), sessionId: null }],
  ...overrides,
});

describe('inbox', () => {
  it('finds an open item by fold key and stops finding it once answered', () => {
    const project = seedProject(store);
    const item = store.write((ctx) => insertInboxItem(ctx, question(project.id))).value;
    expect(findOpenByFoldKey(store.db, project.id, 'fold-1')?.id).toBe(item.id);
    store.write((ctx) => updateInboxItem(ctx, item.id, { state: 'ANSWERED', answer: { choice: 'Teal' } }));
    expect(findOpenByFoldKey(store.db, project.id, 'fold-1')).toBeUndefined();
  });

  it('finds items targeting a workstream', () => {
    const project = seedProject(store);
    const target = mintId('Workstream');
    store.write((ctx) => insertInboxItem(ctx, question(project.id, { targets: [{ workstreamId: target, sessionId: null }] })));
    store.write((ctx) => insertInboxItem(ctx, question(project.id, { foldKey: 'fold-2' })));
    expect(openItemsForWorkstream(store.db, target)).toHaveLength(1);
  });

  it('sorts high urgency first', () => {
    const project = seedProject(store);
    store.write((ctx) => insertInboxItem(ctx, question(project.id, { title: 'normal', foldKey: 'a' })));
    store.write((ctx) => insertInboxItem(ctx, question(project.id, { title: 'high', urgency: 'high', foldKey: 'b' })));
    expect(listInbox(store.db, { states: ['OPEN'] }).map((i) => i.title)).toEqual(['high', 'normal']);
  });
});

describe('permission rules', () => {
  it('returns project rules plus the workstream rules, not other workstreams', () => {
    const project = seedProject(store);
    const mine = mintId('Workstream');
    const other = mintId('Workstream');
    store.write((ctx) => {
      insertPermissionRule(ctx, { projectId: project.id, workstreamId: null, toolName: 'Bash', pattern: 'docker compose', sourceInboxId: null });
      insertPermissionRule(ctx, { projectId: project.id, workstreamId: mine, toolName: 'WebFetch', pattern: null, sourceInboxId: null });
      insertPermissionRule(ctx, { projectId: project.id, workstreamId: other, toolName: 'WebSearch', pattern: null, sourceInboxId: null });
    });
    expect(listPermissionRules(store.db, project.id, mine).map((r) => r.toolName).sort()).toEqual(['Bash', 'WebFetch']);
  });
});

describe('knowledge', () => {
  function record(projectId: ReturnType<typeof seedProject>['id'] | null, q: string, choice: string) {
    return store.write((ctx) => {
      const sourceId = insertSource(ctx, 'builder', { note: 'test' });
      return insertDecision(ctx, { projectId, question: q, choice, rationale: 'because', decidedBy: 'me', scope: projectId ? 'project' : 'you', area: null, sourceId });
    }).value;
  }

  it('reads every write back through search', () => {
    const project = seedProject(store);
    const id = record(project.id, 'Which queue library?', 'BullMQ');
    expect(searchDecisions(store.db, project.id, 'queue', 5).map((h) => h.id)).toEqual([id]);
  });

  it('includes decisions scoped to you in every project', () => {
    const p1 = seedProject(store);
    const p2 = seedProject(store);
    record(null, 'Preferred commit style?', 'Imperative mood');
    record(p1.id, 'Commit hooks?', 'None');
    expect(searchDecisions(store.db, p2.id, 'commit', 5).map((h) => h.choice)).toEqual(['Imperative mood']);
  });

  it('treats search text as data, not FTS syntax', () => {
    const project = seedProject(store);
    record(project.id, "What's the deal with quotes?", 'Escape them');
    expect(() => searchDecisions(store.db, project.id, `what's -the "deal" (NEAR OR`, 5)).not.toThrow();
    expect(searchDecisions(store.db, project.id, `what's "deal"`, 5)).toHaveLength(1);
    expect(searchDecisions(store.db, project.id, '***', 5)).toEqual([]);
  });

  it('lists recent decisions newest first', () => {
    const project = seedProject(store);
    record(project.id, 'first?', 'a');
    record(project.id, 'second?', 'b');
    expect(listRecentDecisions(store.db, project.id, 1).map((d) => d.question)).toEqual(['second?']);
  });

  it('records a verdict and its rationale on a proposal', () => {
    const project = seedProject(store);
    const id = store.write((ctx) => {
      const sourceId = insertSource(ctx, 'agent', {});
      return insertProposal(ctx, { projectId: project.id, kind: 'new_task', title: 'Add caching', body: 'b', sourceId });
    }).value;
    expect(getProposal(store.db, id).status).toBe('pending');
    const { events } = store.write((ctx) => { resolveProposal(ctx, id, { status: 'rejected', rationale: 'not now' }); });
    expect(getProposal(store.db, id)).toMatchObject({ status: 'rejected', rationale: 'not now' });
    expect(events.map((e) => e.type)).toEqual(['proposal.resolved']);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project db inbox-knowledge
```
Expected: FAIL with unresolved modules.

- [ ] **Step 3: Implement**

`packages/db/src/store/inbox.ts`:
```ts
import {
  EventType,
  InboxState,
  mintId,
  NotFoundError,
  type InboxAnswer,
  type InboxItemDto,
  type InboxItemId,
  type InboxKind,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type QuestionCategory,
  type Urgency,
  type WorkstreamId,
} from '@10db/contracts';
import { and, asc, eq, inArray, sql, type SQL } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, Json, WriteContext } from './store';

export interface NewInboxItem {
  readonly projectId: ProjectId;
  readonly kind: InboxKind;
  readonly title: string;
  readonly body: string;
  readonly options: readonly InboxOption[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
  readonly urgency: Urgency;
  readonly detail: Record<string, Json> | null;
  readonly foldKey: string | null;
  readonly targets: readonly InboxTarget[];
}

const LIVE_STATES = [InboxState.Open, InboxState.Answered, InboxState.Delivering];

/** Every column except `foldKey`, which stays internal to folding. */
function toDto(row: typeof schema.inboxItems.$inferSelect): InboxItemDto {
  return {
    id: row.id,
    projectId: row.projectId,
    kind: row.kind,
    state: row.state,
    title: row.title,
    body: row.body,
    options: row.options,
    recommendation: row.recommendation,
    category: row.category,
    urgency: row.urgency,
    assignee: row.assignee,
    detail: row.detail,
    answer: row.answer,
    targets: row.targets,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

export function insertInboxItem(ctx: WriteContext, item: NewInboxItem): InboxItemDto {
  const row = {
    id: mintId('InboxItem'),
    ...item,
    options: [...item.options],
    targets: [...item.targets],
    state: InboxState.Open,
    assignee: 'me',
    answer: null,
    createdAt: ctx.now,
    updatedAt: ctx.now,
  };
  ctx.tx.insert(schema.inboxItems).values(row).run();
  ctx.emit({ type: EventType.InboxOpened, entityType: 'inbox', entityId: row.id, data: { kind: item.kind, projectId: item.projectId } });
  return toDto(row);
}

export function getInboxItem(db: DbReader, id: InboxItemId): InboxItemDto {
  const row = db.select().from(schema.inboxItems).where(eq(schema.inboxItems.id, id)).get();
  if (!row) throw new NotFoundError('inbox item', id);
  return toDto(row);
}

const URGENCY_ORDER = sql`CASE ${schema.inboxItems.urgency} WHEN 'high' THEN 0 WHEN 'normal' THEN 1 ELSE 2 END`;

export function listInbox(db: DbReader, filter: { states?: readonly InboxState[]; projectId?: ProjectId } = {}): InboxItemDto[] {
  const where: SQL[] = [];
  if (filter.states) where.push(inArray(schema.inboxItems.state, [...filter.states]));
  if (filter.projectId) where.push(eq(schema.inboxItems.projectId, filter.projectId));
  return db.select().from(schema.inboxItems).where(and(...where)).orderBy(URGENCY_ORDER, asc(schema.inboxItems.createdAt)).all().map(toDto);
}

export function findOpenByFoldKey(db: DbReader, projectId: ProjectId, foldKey: string): InboxItemDto | undefined {
  const row = db
    .select()
    .from(schema.inboxItems)
    .where(and(eq(schema.inboxItems.projectId, projectId), eq(schema.inboxItems.foldKey, foldKey), eq(schema.inboxItems.state, InboxState.Open)))
    .get();
  return row ? toDto(row) : undefined;
}

export function updateInboxItem(
  ctx: WriteContext,
  id: InboxItemId,
  patch: { readonly state?: InboxState; readonly answer?: InboxAnswer; readonly targets?: readonly InboxTarget[] },
): InboxItemDto {
  // Drizzle's `.set()` wants a mutable array, so `targets` is copied rather than spread through.
  const { targets, ...rest } = patch;
  const set = { ...rest, ...(targets ? { targets: [...targets] } : {}), updatedAt: ctx.now };
  const result = ctx.tx.update(schema.inboxItems).set(set).where(eq(schema.inboxItems.id, id)).run();
  if (result.changes === 0) throw new NotFoundError('inbox item', id);
  const item = getInboxItem(ctx.tx, id);
  ctx.emit({ type: EventType.InboxChanged, entityType: 'inbox', entityId: id, data: { state: item.state } });
  return item;
}

export function openItemsForWorkstream(db: DbReader, workstreamId: WorkstreamId): InboxItemDto[] {
  return db
    .select()
    .from(schema.inboxItems)
    .where(
      and(
        inArray(schema.inboxItems.state, LIVE_STATES),
        sql`EXISTS (SELECT 1 FROM json_each(${schema.inboxItems.targets}) WHERE json_extract(value, '$.workstreamId') = ${workstreamId})`,
      ),
    )
    .orderBy(asc(schema.inboxItems.createdAt))
    .all()
    .map(toDto);
}
```

`packages/db/src/store/permission-rules.ts`:
```ts
import { mintId, type InboxItemId, type PermissionRuleDto, type ProjectId, type WorkstreamId } from '@10db/contracts';
import { and, eq, isNull, or } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, WriteContext } from './store';

export function insertPermissionRule(
  ctx: WriteContext,
  input: { readonly projectId: ProjectId; readonly workstreamId: WorkstreamId | null; readonly toolName: string; readonly pattern: string | null; readonly sourceInboxId: InboxItemId | null },
): PermissionRuleDto {
  const row: PermissionRuleDto = { id: mintId('PermissionRule'), ...input, createdAt: ctx.now };
  ctx.tx.insert(schema.permissionRules).values(row).run();
  return row;
}

export function listPermissionRules(db: DbReader, projectId: ProjectId, workstreamId: WorkstreamId): PermissionRuleDto[] {
  return db
    .select()
    .from(schema.permissionRules)
    .where(and(eq(schema.permissionRules.projectId, projectId), or(isNull(schema.permissionRules.workstreamId), eq(schema.permissionRules.workstreamId, workstreamId))))
    .all();
}
```

`packages/db/src/store/knowledge.ts`:
```ts
import {
  EventType,
  mintId,
  NotFoundError,
  type DecisionId,
  type DeviationId,
  type KnowledgeHit,
  type ProjectId,
  type ProposalId,
  type ProposalKind,
  type Severity,
  type SourceId,
  type SourceKind,
  type WorkstreamId,
} from '@10db/contracts';
import { desc, eq, isNull, or, sql } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, Json, WriteContext } from './store';

export function insertSource(ctx: WriteContext, kind: SourceKind, ref: Record<string, Json>): SourceId {
  const id = mintId('Source');
  ctx.tx.insert(schema.sources).values({ id, kind, ref, createdAt: ctx.now }).run();
  return id;
}

export interface NewDecision {
  readonly projectId: ProjectId | null;
  readonly question: string;
  readonly choice: string;
  readonly rationale: string;
  readonly decidedBy: string;
  readonly scope: 'you' | 'project' | 'area';
  readonly area: string | null;
  readonly sourceId: SourceId;
}

export function insertDecision(ctx: WriteContext, input: NewDecision): DecisionId {
  const id = mintId('Decision');
  ctx.tx.insert(schema.decisions).values({ id, ...input, supersedesId: null, createdAt: ctx.now, updatedAt: ctx.now }).run();
  ctx.emit({ type: EventType.DecisionRecorded, entityType: 'decision', entityId: id, data: { projectId: input.projectId, question: input.question } });
  return id;
}

export function insertDeviation(
  ctx: WriteContext,
  input: { readonly projectId: ProjectId; readonly workstreamId: WorkstreamId | null; readonly cause: string; readonly severity: Severity; readonly signedReason: string; readonly sourceId: SourceId },
): DeviationId {
  const id = mintId('Deviation');
  ctx.tx.insert(schema.deviations).values({ id, ...input, resolution: null, createdAt: ctx.now, updatedAt: ctx.now }).run();
  ctx.emit({ type: EventType.DeviationRecorded, entityType: 'deviation', entityId: id, data: { workstreamId: input.workstreamId, cause: input.cause } });
  return id;
}

export function insertProposal(
  ctx: WriteContext,
  input: { readonly projectId: ProjectId; readonly kind: ProposalKind; readonly title: string; readonly body: string; readonly sourceId: SourceId },
): ProposalId {
  const id = mintId('Proposal');
  ctx.tx.insert(schema.proposals).values({ id, ...input, status: 'pending', rationale: null, createdAt: ctx.now, updatedAt: ctx.now }).run();
  ctx.emit({ type: EventType.ProposalCreated, entityType: 'proposal', entityId: id, data: { kind: input.kind, title: input.title } });
  return id;
}

export type ProposalRow = typeof schema.proposals.$inferSelect;
export type ProposalStatus = ProposalRow['status'];

export function getProposal(db: DbReader, id: ProposalId): ProposalRow {
  const row = db.select().from(schema.proposals).where(eq(schema.proposals.id, id)).get();
  if (!row) throw new NotFoundError('proposal', id);
  return row;
}

/** Records the builder's verdict on a proposal (spec §4: status plus the accept/reject rationale). */
export function resolveProposal(ctx: WriteContext, id: ProposalId, verdict: { readonly status: Exclude<ProposalStatus, 'pending'>; readonly rationale: string | null }): void {
  const result = ctx.tx.update(schema.proposals).set({ ...verdict, updatedAt: ctx.now }).where(eq(schema.proposals.id, id)).run();
  if (result.changes === 0) throw new NotFoundError('proposal', id);
  ctx.emit({ type: EventType.ProposalResolved, entityType: 'proposal', entityId: id, data: { status: verdict.status } });
}

/** Turns free text into an FTS5 query of quoted terms joined by OR, so user text is never parsed as syntax. */
function ftsQuery(text: string): string | null {
  const terms = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return terms.length === 0 ? null : terms.map((t) => `"${t}"`).join(' OR ');
}

export function searchDecisions(db: DbReader, projectId: ProjectId, query: string, limit: number): KnowledgeHit[] {
  const match = ftsQuery(query);
  if (match === null) return [];
  const rows = db.all<{ id: DecisionId; question: string; choice: string; rationale: string }>(sql`
    SELECT d.id AS id, d.question AS question, d.choice AS choice, d.rationale AS rationale
    FROM decisions_fts f JOIN decisions d ON d.rowid = f.rowid
    WHERE decisions_fts MATCH ${match} AND (d.project_id = ${projectId} OR d.project_id IS NULL)
    ORDER BY bm25(decisions_fts)
    LIMIT ${limit}
  `);
  return rows.map((r) => ({ kind: 'decision', ...r }));
}

export function listRecentDecisions(db: DbReader, projectId: ProjectId, limit: number): KnowledgeHit[] {
  return db
    .select({ id: schema.decisions.id, question: schema.decisions.question, choice: schema.decisions.choice, rationale: schema.decisions.rationale })
    .from(schema.decisions)
    .where(or(eq(schema.decisions.projectId, projectId), isNull(schema.decisions.projectId)))
    .orderBy(desc(schema.decisions.id))
    .limit(limit)
    .all()
    .map((r) => ({ kind: 'decision', ...r }));
}
```

Add `export * from './inbox';`, `export * from './knowledge';` and `export * from './permission-rules';` to `store/index.ts`.

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project db
pnpm typecheck && pnpm lint
pnpm format
git add packages/db/src/store && git commit -m 'feat(db): add inbox, permission rule and knowledge repositories with safe FTS search'
```
Expected: PASS.

### Task 6: Daemon module layout, clock and the workspace guard

**Files:**
- Create: `apps/daemon/src/clock/index.ts`, `clock/manual-clock.ts`
- Create: `apps/daemon/src/guard/index.ts`, `guard/shell-words.ts`, `guard/paths.ts`, `guard/judge.ts`
- Create: `apps/daemon/test/fixtures.ts`, `apps/daemon/src/api/index.ts`
- Modify: `eslint.config.js` (daemon module boundaries), `apps/daemon/AGENTS.md`, `apps/daemon/tsconfig.json` (include `test`), `apps/daemon/src/index.ts` and `apps/daemon/src/main.ts` (import `./api`, not `./api/app`). `apps/daemon/package.json` already has `@10db/db`; M1b adds `@10db/harness`.
- Test: `apps/daemon/src/clock/manual-clock.test.ts`, `apps/daemon/src/guard/judge.test.ts`

**Interfaces:**
- Produces:
  - **Clock** (`clock/index.ts`):
    - `interface Clock { now(): Date; setTimeout(fn: () => void, ms: number): Timer }`, `interface Timer { cancel(): void }`
    - `systemClock: Clock`
    - `class ManualClock implements Clock { advance(ms: number): void; pendingTimers(): number }`
  - **Shell parsing** (`guard/index.ts`): `splitCommand(command: string): ShellSegment[]`, where `ShellSegment = { raw: string; words: string[]; separator: string }`. Command substitutions `$(…)` and backticks become segments of their own. `stripCommandPrefixes(words): string[]` drops leading `VAR=x`, `env`, `command`, `nohup` and `time`.
  - **Paths** (`guard/index.ts`):
    - `resolveInRepo(repoPath, filePath): { inside: true; rel: string } | { inside: false }`. It is symlink-aware.
    - `classifyPath(rel, areas, hazards): { areas: string[]; hazards: string[] }`
  - **Guard** (`guard/index.ts`):
    - `interface GuardInput { toolName; toolInput: unknown; repoPath; areas; hazards; claims: readonly { kind: ClaimKind; name: string }[] }`
    - `type GuardVerdict = { decision: 'allow' } | { decision: 'deny'; reason: string }`
    - `judgeToolUse(input: GuardInput): GuardVerdict`
  - **Test fixtures** (`apps/daemon/test/fixtures.ts`):
    - `createTempRepo(): Promise<{ path: string; cleanup(): void }>`. It runs `git init -b main`, sets the user config and makes one initial commit.
    - `tempDir(prefix): { path: string; cleanup(): void }`

- [ ] **Step 1: Enforce module boundaries inside the daemon**

Add these blocks to `eslint.config.js` after the main TypeScript block and before `prettier`:
```js
  {
    // Daemon modules (src/<module>/) import each other only through index.ts.
    files: ['apps/daemon/src/*/**/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@10db/[^/]+/.+', message: 'Import a workspace package through its entry point only.' },
            // `(?!\\.\\.)` lets tests reach `../../test/fixtures`; only sibling modules are restricted.
            { regex: '^\\.\\./(?!\\.\\.)[^/]+/.+', message: 'Import another daemon module through its index.ts only.' },
          ],
        },
      ],
    },
  },
  {
    files: ['apps/daemon/src/*.ts'],
    rules: {
      'no-restricted-imports': [
        'error',
        {
          patterns: [
            { regex: '^@10db/[^/]+/.+', message: 'Import a workspace package through its entry point only.' },
            { regex: '^\\./[^/]+/.+', message: 'Import a daemon module through its index.ts only.' },
          ],
        },
      ],
    },
  },
```
Append to `apps/daemon/AGENTS.md`:
```markdown
## Modules

`src/<module>/` directories are flat; each exports its public surface from `index.ts`, and other
modules import only that (ESLint enforces it). Dependencies point one way:

`clock`, `log`, `events`, `guard`, `permissions`, `git`, `verify` → `sessions`, `inbox`, `briefing` →
`mcp` → `runner` → `scheduler`, `recovery` → `daemon` (composition root) → `main.ts`.
`api` depends only on `@10db/contracts` and its own `ApiServices` interface.

Time comes from an injected `Clock`; never call `Date.now()` or `setTimeout` directly in logic.
```
Add `"test"` to the `include` array in `apps/daemon/tsconfig.json`.

M0's `src/main.ts` and `src/index.ts` import `./api/app`, which the second block now rejects. Give `api` its entry file, `apps/daemon/src/api/index.ts`:
```ts
export { createApp, type ApiDeps, type AppType } from './app';
```
Then change `import { createApp } from './api/app';` in `src/main.ts` to `import { createApp } from './api';`, and `export type { AppType } from './api/app';` in `src/index.ts` to `export type { AppType } from './api';`.

Check the rule before moving on. Both commands below must exit 0, and the probe must report `no-restricted-imports`:
```bash
pnpm lint
printf "import { ManualClock } from '../clock/manual-clock';\nexport const c = ManualClock;\n" > apps/daemon/src/guard/probe.ts
pnpm exec eslint apps/daemon/src/guard/probe.ts | grep -q 'no-restricted-imports'
rm apps/daemon/src/guard/probe.ts
```

- [ ] **Step 2: Write the test fixtures**

`apps/daemon/test/fixtures.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export function tempDir(prefix: string): { path: string; cleanup(): void } {
  const path = mkdtempSync(join(tmpdir(), `10db-${prefix}-`));
  return { path, cleanup: () => { rmSync(path, { recursive: true, force: true }); } };
}

/** A real git repository with one commit on main, for tests that touch git or files. */
export async function createTempRepo(): Promise<{ path: string; cleanup(): void }> {
  const dir = tempDir('repo');
  const git = (...args: string[]) => execFileSync('git', ['-C', dir.path, ...args], { stdio: 'pipe' });
  git('init', '-q', '-b', 'main');
  git('config', 'user.name', '10db test');
  git('config', 'user.email', 'test@10db.invalid');
  git('config', 'commit.gpgsign', 'false');
  writeFileSync(join(dir.path, 'README.md'), '# fixture\n');
  git('add', 'README.md');
  git('commit', '-q', '-m', 'Initial commit');
  return Promise.resolve(dir);
}
```

- [ ] **Step 3: Write the failing tests**

`apps/daemon/src/clock/manual-clock.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { ManualClock } from './index';

describe('ManualClock', () => {
  it('fires due timers in time order and leaves later ones pending', () => {
    const clock = new ManualClock(new Date('2026-10-13T12:00:00.000Z'));
    const fired: string[] = [];
    clock.setTimeout(() => fired.push('b'), 2000);
    clock.setTimeout(() => fired.push('a'), 1000);
    clock.setTimeout(() => fired.push('c'), 5000);
    clock.advance(2500);
    expect(fired).toEqual(['a', 'b']);
    expect(clock.now().toISOString()).toBe('2026-10-13T12:00:02.500Z');
    expect(clock.pendingTimers()).toBe(1);
  });

  it('does not fire a cancelled timer', () => {
    const clock = new ManualClock();
    let fired = false;
    clock.setTimeout(() => { fired = true; }, 10).cancel();
    clock.advance(100);
    expect(fired).toBe(false);
  });
});
```

`apps/daemon/src/guard/judge.test.ts`:
```ts
import { mkdirSync, symlinkSync } from 'node:fs';
import { join } from 'node:path';
import { DEFAULT_HAZARDS, type ClaimKind } from '@10db/contracts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { judgeToolUse, splitCommand } from './index';

const repo = tempDir('guard-repo');
const outside = tempDir('guard-outside');
beforeAll(() => {
  mkdirSync(join(repo.path, 'src/api'), { recursive: true });
  symlinkSync(outside.path, join(repo.path, 'link'));
});
afterAll(() => {
  repo.cleanup();
  outside.cleanup();
});

const AREAS = [
  { name: 'api', globs: ['src/api/**'] },
  { name: 'ui', globs: ['src/ui/**'] },
];

function judge(toolName: string, toolInput: unknown, claims: { kind: ClaimKind; name: string }[] = [{ kind: 'area', name: 'api' }]) {
  return judgeToolUse({ toolName, toolInput, repoPath: repo.path, areas: AREAS, hazards: DEFAULT_HAZARDS, claims });
}
const bash = (command: string, claims?: { kind: ClaimKind; name: string }[]) => judge('Bash', { command }, claims);

describe('file edits', () => {
  it.each<[string, string, string, 'allow' | 'deny', string?]>([
    ['claimed area', 'Edit', 'src/api/a.ts', 'allow'],
    ['absolute path inside a claimed area', 'Write', '<repo>/src/api/b.ts', 'allow'],
    ['unclaimed area', 'Edit', 'src/ui/a.ts', 'deny', 'request_claim'],
    ['file in no area', 'Write', 'scratch.txt', 'deny', 'request_claim'],
    ['escapes with ..', 'Edit', '../other/x.ts', 'deny', 'outside the repository'],
    ['absolute path elsewhere', 'Write', '/etc/hosts', 'deny', 'outside the repository'],
    ['through a symlink that leaves the repo', 'Write', 'link/x.ts', 'deny', 'outside the repository'],
    ['hazard file without the hazard claim', 'Edit', 'package.json', 'deny', 'hazard'],
  ])('%s', (_name, tool, path, decision, reasonPart) => {
    const filePath = path.replace('<repo>', repo.path);
    const verdict = judge(tool, { file_path: filePath, content: 'x', old_string: 'a', new_string: 'b' });
    expect(verdict.decision).toBe(decision);
    if (reasonPart && verdict.decision === 'deny') expect(verdict.reason).toContain(reasonPart);
  });

  it('allows a hazard file when the hazard is claimed', () => {
    expect(judge('Edit', { file_path: 'package.json' }, [{ kind: 'hazard', name: 'deps' }]).decision).toBe('allow');
  });

  it('leaves reads alone', () => {
    expect(judge('Read', { file_path: '/etc/hosts' }).decision).toBe('allow');
  });
});

describe('shell commands', () => {
  it.each<[string, 'allow' | 'deny']>([
    ['git status --short', 'allow'],
    ['git diff HEAD~1 -- src', 'allow'],
    ['git log --oneline -5', 'allow'],
    ['git branch', 'allow'],
    ['git push origin feat/x', 'allow'],
    ['pnpm vitest run', 'allow'],
    ['rm -rf build', 'allow'],
    ["git commit -m 'x'", 'deny'],
    ['git add .', 'deny'],
    ['git add src/api/a.ts', 'deny'],
    ['git checkout main', 'deny'],
    ['git switch -c x', 'deny'],
    ['git stash', 'deny'],
    ['git reset --hard', 'deny'],
    ['git branch -D old', 'deny'],
    ['git pull', 'deny'],
    ['git push --force origin feat/x', 'deny'],
    ['git push origin main', 'deny'],
    ['git push origin HEAD:master', 'deny'],
    ['git -C ../other commit -m x', 'deny'],
    ["cd src && git commit -m 'x'", 'deny'],
    ['bash -c "git reset --hard"', 'deny'],
    ['echo $(git checkout .)', 'deny'],
    ['echo `git stash`', 'deny'],
    ['FOO=1 env git checkout .', 'deny'],
    ['rm -rf /tmp/x', 'deny'],
    ['rm -rf ~/projects', 'deny'],
    ['rm -rf .', 'deny'],
    ['rm -rf ../sibling', 'deny'],
    ['vercel deploy --prod', 'deny'],
    ['pnpm publish', 'deny'],
    ['terraform apply', 'deny'],
    ['sudo ls', 'deny'],
    ['pnpm add zod', 'deny'],
    ['pnpm -w add zod', 'deny'],
    ['pnpm --filter @10db/db add zod', 'deny'],
    ['pnpm --filter=@10db/db remove zod', 'deny'],
    ['pnpm i', 'deny'],
    ['pnpm install --frozen-lockfile', 'deny'],
    ['npm i left-pad', 'deny'],
    ['pnpm exec drizzle-kit generate', 'deny'],
    ['pnpm --filter @10db/db db:migrate', 'deny'],
    ['pnpm --filter @10db/db test', 'allow'],
    ['pnpm addons', 'allow'],
  ])('%s -> %s', (command, decision) => {
    expect(bash(command).decision).toBe(decision);
  });

  it('allows a hazard command when the hazard is claimed', () => {
    expect(bash('pnpm add zod', [{ kind: 'hazard', name: 'deps' }]).decision).toBe('allow');
  });

  it('points direct commits at the commit tool', () => {
    const verdict = bash("git commit -m 'x'");
    expect(verdict.decision === 'deny' && verdict.reason).toContain('commit tool');
  });

  it('allows when the Bash input has no command (the CLI rejects it anyway)', () => {
    expect(judge('Bash', {}).decision).toBe('allow');
  });
});

describe('splitCommand', () => {
  it('splits on operators outside quotes and extracts substitutions', () => {
    expect(splitCommand(`a 'b && c' && d "$(e f)" | g`).map((s) => s.words)).toEqual([
      ['a', 'b && c'],
      ['d', '$(e f)'],
      ['g'],
      ['e', 'f'],
    ]);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

```bash
pnpm vitest run --project daemon clock guard
```
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 5: Implement the clock**

`apps/daemon/src/clock/manual-clock.ts`:
```ts
import type { Clock, Timer } from './index';

interface Pending {
  readonly at: number;
  readonly order: number;
  readonly fn: () => void;
}

/** Test clock: time moves only when `advance` is called, and due timers fire in order. */
export class ManualClock implements Clock {
  private current: number;
  private timers: Pending[] = [];
  private order = 0;

  constructor(start: Date = new Date('2026-10-13T12:00:00.000Z')) {
    this.current = start.getTime();
  }

  now(): Date {
    return new Date(this.current);
  }

  setTimeout(fn: () => void, ms: number): Timer {
    const timer: Pending = { at: this.current + ms, order: this.order++, fn };
    this.timers.push(timer);
    return { cancel: () => { this.timers = this.timers.filter((t) => t !== timer); } };
  }

  advance(ms: number): void {
    const target = this.current + ms;
    for (;;) {
      const due = this.timers.filter((t) => t.at <= target).sort((a, b) => a.at - b.at || a.order - b.order)[0];
      if (!due) break;
      this.timers = this.timers.filter((t) => t !== due);
      this.current = due.at;
      due.fn();
    }
    this.current = target;
  }

  pendingTimers(): number {
    return this.timers.length;
  }
}
```

`apps/daemon/src/clock/index.ts`:
```ts
export interface Timer {
  cancel(): void;
}

export interface Clock {
  now(): Date;
  setTimeout(fn: () => void, ms: number): Timer;
}

export const systemClock: Clock = {
  now: () => new Date(),
  setTimeout(fn, ms) {
    const handle = setTimeout(fn, ms);
    return { cancel: () => { clearTimeout(handle); } };
  },
};

export { ManualClock } from './manual-clock';
```

- [ ] **Step 6: Implement the guard**

`apps/daemon/src/guard/shell-words.ts`:
```ts
export interface ShellSegment {
  /** The segment's text with quotes kept, for quote-aware checks. */
  readonly raw: string;
  /** Words with quotes removed. */
  readonly words: string[];
  /** The operator that ended the segment: `&&`, `||`, `;`, `|`, newline, or empty at the end. */
  readonly separator: string;
}

/**
 * Splits a shell command at unquoted `&&`, `||`, `;`, `|` and newlines. The bodies of `$(…)` and
 * backtick substitutions (outside single quotes) are split too and appended as their own
 * segments, because they run as commands.
 */
export function splitCommand(command: string): ShellSegment[] {
  const out: ShellSegment[] = [];
  const nested: string[] = [];
  let raw = '';
  let word = '';
  let words: string[] = [];
  let quote: "'" | '"' | null = null;

  const flushWord = (): void => {
    if (word !== '') words.push(word);
    word = '';
  };
  const flushSegment = (separator: string): void => {
    flushWord();
    if (raw.trim() !== '') out.push({ raw: raw.trim(), words, separator });
    raw = '';
    words = [];
  };

  for (let i = 0; i < command.length; i += 1) {
    const ch = command.charAt(i);
    const next = command.charAt(i + 1);
    if (quote !== "'" && ch === '$' && next === '(') {
      let depth = 1;
      let j = i + 2;
      while (j < command.length && depth > 0) {
        if (command.charAt(j) === '(') depth += 1;
        if (command.charAt(j) === ')') depth -= 1;
        j += 1;
      }
      const body = command.slice(i + 2, j - 1);
      nested.push(body);
      raw += command.slice(i, j);
      word += command.slice(i, j);
      i = j - 1;
      continue;
    }
    if (quote !== "'" && ch === '`') {
      const end = command.indexOf('`', i + 1);
      const close = end === -1 ? command.length : end;
      nested.push(command.slice(i + 1, close));
      raw += command.slice(i, close + 1);
      word += command.slice(i, close + 1);
      i = close;
      continue;
    }
    if (quote) {
      raw += ch;
      if (ch === quote) quote = null;
      else word += ch;
      continue;
    }
    if (ch === "'" || ch === '"') {
      quote = ch;
      raw += ch;
      continue;
    }
    if ((ch === '&' && next === '&') || (ch === '|' && next === '|')) {
      flushSegment(ch + next);
      i += 1;
      continue;
    }
    if (ch === ';' || ch === '|' || ch === '\n') {
      flushSegment(ch);
      continue;
    }
    raw += ch;
    if (ch === ' ' || ch === '\t') flushWord();
    else word += ch;
  }
  flushSegment('');
  for (const body of nested) out.push(...splitCommand(body));
  return out;
}

const PREFIX_COMMANDS = new Set(['env', 'command', 'nohup', 'time', 'exec']);

/** Drops leading `VAR=value` assignments and pass-through wrappers such as `env` and `nohup`. */
export function stripCommandPrefixes(words: readonly string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const w = words[i] ?? '';
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(w) || PREFIX_COMMANDS.has(w)) i += 1;
    else break;
  }
  return words.slice(i);
}
```

`apps/daemon/src/guard/paths.ts`:
```ts
import { existsSync, realpathSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, matchesGlob, relative, resolve } from 'node:path';
import type { AreaDef, HazardDef } from '@10db/contracts';

/** Resolves symlinks on the longest existing prefix of `p`, so a symlinked parent can't escape. */
function realpathOfNearest(p: string): string {
  let current = p;
  const rest: string[] = [];
  while (!existsSync(current)) {
    const parent = dirname(current);
    if (parent === current) return p;
    rest.unshift(basename(current));
    current = parent;
  }
  return join(realpathSync(current), ...rest);
}

export function resolveInRepo(repoPath: string, filePath: string): { inside: true; rel: string } | { inside: false } {
  const root = realpathSync(repoPath);
  const target = realpathOfNearest(isAbsolute(filePath) ? filePath : resolve(repoPath, filePath));
  const rel = relative(root, target);
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return { inside: false };
  return { inside: true, rel };
}

export function classifyPath(rel: string, areas: readonly AreaDef[], hazards: readonly HazardDef[]): { areas: string[]; hazards: string[] } {
  const hits = (defs: readonly AreaDef[]) => defs.filter((d) => d.globs.some((g) => matchesGlob(rel, g))).map((d) => d.name);
  return { areas: hits(areas), hazards: hits(hazards) };
}
```

`apps/daemon/src/guard/judge.ts`:
```ts
import { homedir } from 'node:os';
import { isAbsolute, resolve } from 'node:path';
import { ClaimKind, type AreaDef, type HazardDef } from '@10db/contracts';
import { classifyPath, resolveInRepo } from './paths';
import { splitCommand, stripCommandPrefixes } from './shell-words';

export interface GuardInput {
  readonly toolName: string;
  readonly toolInput: unknown;
  readonly repoPath: string;
  readonly areas: readonly AreaDef[];
  readonly hazards: readonly HazardDef[];
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
}

export type GuardVerdict = { readonly decision: 'allow' } | { readonly decision: 'deny'; readonly reason: string };

const ALLOW: GuardVerdict = { decision: 'allow' };
const deny = (reason: string): GuardVerdict => ({ decision: 'deny', reason });

const FILE_TOOLS = new Set(['Edit', 'Write', 'MultiEdit', 'NotebookEdit']);
const READ_ONLY_GIT = new Set(['status', 'diff', 'log', 'show', 'blame', 'rev-parse', 'ls-files', 'grep', 'describe', 'shortlog', 'cat-file', 'ls-tree', 'rev-list']);
const BANNED_GIT = new Set([
  'checkout', 'switch', 'reset', 'stash', 'commit', 'add', 'rm', 'mv', 'restore', 'clean', 'rebase', 'merge',
  'cherry-pick', 'revert', 'pull', 'am', 'apply', 'filter-branch', 'update-ref', 'worktree', 'gc', 'prune',
]);
const PROTECTED_BRANCHES = new Set(['main', 'master']);
const DEPLOY = [
  /^(vercel|netlify)\b.*\b(deploy|--prod)\b/,
  /^fly (deploy|launch)\b/,
  /^kubectl (apply|delete|rollout)\b/,
  /^terraform (apply|destroy)\b/,
  /^(npm|pnpm|yarn) publish\b/,
  /^cargo publish\b/,
  /^gh release create\b/,
];
const SHELLS = new Set(['sh', 'bash', 'zsh']);
/** Flags whose next word is their value, so it is not mistaken for the subcommand. */
const VALUE_FLAGS = new Set(['--filter', '-F', '--dir', '-C', '--prefix', '--workspace', '--manifest-path', '-p', '--package', '--config']);
/** Runners whose remaining words are themselves a command (`pnpm exec drizzle-kit generate`). */
const RUNNERS: readonly (readonly string[])[] = [['npx'], ['pnpm', 'exec'], ['pnpm', 'dlx'], ['npm', 'exec'], ['yarn', 'dlx']];

/** The command's words without flags or flag values: `pnpm --filter x add zod` → `pnpm add zod`. */
function withoutFlags(words: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < words.length; i += 1) {
    const w = words[i] ?? '';
    if (!w.startsWith('-')) out.push(w);
    else if (VALUE_FLAGS.has(w)) i += 1;
  }
  return out;
}

/** The command itself, plus what it runs when it is a runner such as `npx` or `pnpm exec`. */
function commandForms(words: readonly string[]): string[][] {
  const bare = withoutFlags(words);
  const runner = RUNNERS.find((r) => startsWithWords(bare, r));
  return runner ? [bare, bare.slice(runner.length)] : [bare];
}

function startsWithWords(words: readonly string[], prefix: readonly string[]): boolean {
  return prefix.length > 0 && prefix.every((p, i) => words[i] === p);
}

function stringField(input: unknown, key: string): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)[key];
  return typeof value === 'string' ? value : null;
}

function claimed(input: GuardInput, kind: ClaimKind, name: string): boolean {
  return input.claims.some((c) => c.kind === kind && c.name === name);
}

function judgeFile(input: GuardInput, filePath: string): GuardVerdict {
  const where = resolveInRepo(input.repoPath, filePath);
  if (!where.inside) return deny(`${filePath} is outside the repository. Edit files inside ${input.repoPath} only.`);
  const hit = classifyPath(where.rel, input.areas, input.hazards);
  const missingHazard = hit.hazards.find((h) => !claimed(input, ClaimKind.Hazard, h));
  if (missingHazard) {
    return deny(`${where.rel} is in the "${missingHazard}" hazard. Call the request_claim tool with kind "hazard" and name "${missingHazard}" first.`);
  }
  if (hit.hazards.length > 0) return ALLOW;
  if (hit.areas.some((a) => claimed(input, ClaimKind.Area, a))) return ALLOW;
  const which = hit.areas.length > 0 ? `area "${hit.areas.join('", "')}"` : 'no area';
  return deny(`${where.rel} is outside your claims (it is in ${which}). Call the request_claim tool for the area you need.`);
}

function gitVerdict(words: readonly string[]): GuardVerdict | null {
  let i = 1;
  while (i < words.length && (words[i] ?? '').startsWith('-')) i += words[i] === '-C' || words[i] === '-c' ? 2 : 1;
  const verb = words[i] ?? '';
  const args = words.slice(i + 1);
  if (verb === '' || READ_ONLY_GIT.has(verb)) return null;
  if (verb === 'commit') return deny('Direct git commit is not allowed. Use the 10db commit tool with explicit paths.');
  if (BANNED_GIT.has(verb)) return deny(`git ${verb} changes the shared checkout and is not allowed. Only read-only git is allowed; commit through the 10db commit tool.`);
  if (verb === 'branch' && args.some((a) => !['-a', '-r', '--list', '-v', '-vv', '--show-current'].includes(a))) {
    return deny('Creating or deleting branches is not allowed in the shared checkout.');
  }
  if (verb === 'push') {
    if (args.some((a) => a === '-f' || a.startsWith('--force') || a === '--delete' || a.startsWith('+'))) return deny('Force pushes and remote deletes are never allowed.');
    const targets = args.filter((a) => !a.startsWith('-')).slice(1).map((ref) => ref.split(':').at(-1) ?? ref);
    if (targets.some((t) => PROTECTED_BRANCHES.has(t.replace(/^refs\/heads\//, '')))) return deny('Pushing to a protected branch is never allowed.');
  }
  return null;
}

function rmVerdict(input: GuardInput, words: readonly string[]): GuardVerdict | null {
  const flags = words.filter((w) => w.startsWith('-')).join('');
  if (!/[rR]/.test(flags)) return null;
  for (const arg of words.slice(1).filter((w) => !w.startsWith('-'))) {
    const expanded = arg.startsWith('~') ? arg.replace(/^~/, homedir()) : arg;
    const where = resolveInRepo(input.repoPath, isAbsolute(expanded) ? expanded : resolve(input.repoPath, expanded));
    if (!where.inside) return deny(`rm -r of ${arg} reaches outside the repository (or is the repository itself).`);
  }
  return null;
}

function judgeShell(input: GuardInput, command: string, depth = 0): GuardVerdict {
  for (const segment of splitCommand(command)) {
    const words = stripCommandPrefixes(segment.words);
    const head = words[0] ?? '';
    const line = words.join(' ');
    if (head === 'sudo') return deny('sudo is never allowed.');
    if (SHELLS.has(head) && words.includes('-c') && depth < 3) {
      const inner = words[words.indexOf('-c') + 1];
      if (inner !== undefined) {
        const verdict = judgeShell(input, inner, depth + 1);
        if (verdict.decision === 'deny') return verdict;
      }
    }
    if (head === 'eval' && depth < 3) {
      const verdict = judgeShell(input, words.slice(1).join(' '), depth + 1);
      if (verdict.decision === 'deny') return verdict;
    }
    if (head === 'git') {
      const verdict = gitVerdict(words);
      if (verdict) return verdict;
    }
    if (head === 'rm') {
      const verdict = rmVerdict(input, words);
      if (verdict) return verdict;
    }
    if (DEPLOY.some((re) => re.test(line))) return deny('Deploy and publish commands are never run by agents.');
    const forms = commandForms(words);
    for (const hazard of input.hazards) {
      if (hazard.commands.some((c) => forms.some((f) => startsWithWords(f, c.split(' ')))) && !claimed(input, ClaimKind.Hazard, hazard.name)) {
        return deny(`"${line}" needs the "${hazard.name}" hazard claim. Call request_claim with kind "hazard" and name "${hazard.name}" first.`);
      }
    }
  }
  return ALLOW;
}

/** The PreToolUse decision for a managed session (spec §8.2). Rules only; never an LLM. */
export function judgeToolUse(input: GuardInput): GuardVerdict {
  if (FILE_TOOLS.has(input.toolName)) {
    const filePath = stringField(input.toolInput, 'file_path') ?? stringField(input.toolInput, 'notebook_path');
    return filePath === null ? ALLOW : judgeFile(input, filePath);
  }
  if (input.toolName === 'Bash') {
    const command = stringField(input.toolInput, 'command');
    return command === null ? ALLOW : judgeShell(input, command);
  }
  return ALLOW;
}
```

`apps/daemon/src/guard/index.ts`:
```ts
export { judgeToolUse, type GuardInput, type GuardVerdict } from './judge';
export { classifyPath, resolveInRepo } from './paths';
export { splitCommand, stripCommandPrefixes, type ShellSegment } from './shell-words';
```

- [ ] **Step 7: Run, check, commit**

```bash
pnpm vitest run --project daemon clock guard
pnpm typecheck && pnpm lint
pnpm format
git add eslint.config.js apps/daemon && git commit -m 'feat(daemon): add clock, module boundaries and workspace guard'
```
Expected: PASS. If `node:path`'s `matchesGlob` prints an ExperimentalWarning on this Node version, leave it; if it's missing, stop and report, because it is in Node 26.

---

### Task 7: Permission rules

**Files:**
- Create: `apps/daemon/src/permissions/rules.ts`, `permissions/index.ts`
- Test: `apps/daemon/src/permissions/rules.test.ts`

**Interfaces:**
- Consumes: `splitCommand` and `stripCommandPrefixes` from `guard`.
- Produces, from `permissions/index.ts`:
  - `baseAllowedTools(project: Pick<ProjectDto, 'gateCommand'>): string[]`. These are the injected allow rules (spec §7), in Claude Code's allow-rule syntax.
  - `matchesAllowedTool(toolName, input: unknown, allowed: readonly string[]): boolean`. It understands `Name`, `prefix*` and `Bash(cmd)` / `Bash(prefix:*)`.
  - `commandPrefix(command: string): string`. This is the pattern stored by "allow for workstream or project": the first word, plus the subcommand when there is one.
  - `matchPermissionRule(req: { toolName: string; input: unknown }, rules: readonly PermissionRuleDto[]): PermissionRuleDto | undefined`

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/permissions/rules.test.ts`:
```ts
import { mintId, type PermissionRuleDto } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { baseAllowedTools, commandPrefix, matchesAllowedTool, matchPermissionRule } from './index';

const allowed = baseAllowedTools({ gateCommand: 'make gate' });

describe('matchesAllowedTool', () => {
  it.each<[string, unknown, boolean]>([
    ['Read', { file_path: 'a' }, true],
    ['Edit', { file_path: 'a' }, true],
    ['mcp__10db__commit', {}, true],
    ['mcp__other__x', {}, false],
    ['Bash', { command: 'make gate' }, true],
    ['Bash', { command: 'make gate-fast' }, false],
    ['Bash', { command: 'git status --short' }, true],
    ['Bash', { command: 'git push' }, false],
    ['Bash', { command: 'git status && curl evil.example' }, false],
    ['WebFetch', { url: 'https://example.com' }, false],
    ['AskUserQuestion', {}, false],
  ])('%s %j -> %s', (tool, input, expected) => {
    expect(matchesAllowedTool(tool, input, allowed)).toBe(expected);
  });
});

describe('commandPrefix', () => {
  it.each([
    ['docker compose up -d', 'docker compose'],
    ['FOO=1 pnpm test --watch', 'pnpm test'],
    ['curl -s https://x', 'curl'],
    ['ls', 'ls'],
  ])('%s -> %s', (command, prefix) => {
    expect(commandPrefix(command)).toBe(prefix);
  });
});

describe('matchPermissionRule', () => {
  const rule = (toolName: string, pattern: string | null): PermissionRuleDto => ({
    id: mintId('PermissionRule'), projectId: mintId('Project'), workstreamId: null, toolName, pattern, sourceInboxId: null, createdAt: '2026-10-13T12:00:00.000Z',
  });

  it('matches a tool rule without a pattern', () => {
    expect(matchPermissionRule({ toolName: 'WebFetch', input: {} }, [rule('WebFetch', null)])).toBeDefined();
  });

  it('matches a Bash rule by command prefix, for every segment', () => {
    const rules = [rule('Bash', 'docker compose')];
    expect(matchPermissionRule({ toolName: 'Bash', input: { command: 'docker compose up' } }, rules)).toBeDefined();
    expect(matchPermissionRule({ toolName: 'Bash', input: { command: 'docker compose up && rm -rf build' } }, rules)).toBeUndefined();
    expect(matchPermissionRule({ toolName: 'Bash', input: { command: 'docker run x' } }, rules)).toBeUndefined();
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon permissions
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/permissions/rules.ts`:
```ts
import type { PermissionRuleDto, ProjectDto } from '@10db/contracts';
import { splitCommand, stripCommandPrefixes } from '../guard';

/** Allow rules injected into every managed session (spec §7). The guard still checks claims. */
export function baseAllowedTools(project: Pick<ProjectDto, 'gateCommand'>): string[] {
  return [
    'Read', 'Glob', 'Grep', 'LS', 'Edit', 'Write', 'MultiEdit', 'NotebookEdit', 'TodoWrite',
    'mcp__10db__*',
    `Bash(${project.gateCommand})`,
    'Bash(git status:*)', 'Bash(git diff:*)', 'Bash(git log:*)', 'Bash(git show:*)',
    'Bash(ls:*)', 'Bash(pwd)',
  ];
}

function commandOf(input: unknown): string | null {
  if (typeof input !== 'object' || input === null) return null;
  const value = (input as Record<string, unknown>)['command'];
  return typeof value === 'string' ? value : null;
}

function segmentLines(command: string): string[] {
  return splitCommand(command).map((s) => stripCommandPrefixes(s.words).join(' '));
}

function bashRuleMatches(rule: string, line: string): boolean {
  if (rule.endsWith(':*')) {
    const prefix = rule.slice(0, -2);
    return line === prefix || line.startsWith(`${prefix} `);
  }
  return line === rule;
}

export function matchesAllowedTool(toolName: string, input: unknown, allowed: readonly string[]): boolean {
  for (const entry of allowed) {
    const bash = /^Bash\((.+)\)$/.exec(entry);
    if (bash?.[1] !== undefined) {
      const command = toolName === 'Bash' ? commandOf(input) : null;
      if (command !== null && segmentLines(command).every((line) => bashRuleMatches(bash[1] ?? '', line))) return true;
      continue;
    }
    if (entry.endsWith('*') ? toolName.startsWith(entry.slice(0, -1)) : toolName === entry) return true;
  }
  return false;
}

/** First word, plus the subcommand when the second word is not a flag: "docker compose", "curl". */
export function commandPrefix(command: string): string {
  const words = stripCommandPrefixes(splitCommand(command)[0]?.words ?? []);
  const [first = '', second] = words;
  return second !== undefined && !second.startsWith('-') && !second.includes('/') && !second.includes(':') ? `${first} ${second}` : first;
}

export function matchPermissionRule(req: { readonly toolName: string; readonly input: unknown }, rules: readonly PermissionRuleDto[]): PermissionRuleDto | undefined {
  return rules.find((rule) => {
    if (rule.toolName !== req.toolName) return false;
    if (rule.pattern === null) return true;
    const command = commandOf(req.input);
    return command !== null && segmentLines(command).every((line) => line === rule.pattern || line.startsWith(`${rule.pattern ?? ''} `));
  });
}
```

`apps/daemon/src/permissions/index.ts`:
```ts
export { baseAllowedTools, commandPrefix, matchesAllowedTool, matchPermissionRule } from './rules';
```
The permission broker that uses these rules arrives in Task 12.

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon permissions
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/permissions && git commit -m 'feat(daemon): add permission allow rules and rule matching'
```

---

### Task 8: Git through 10db

**Files:**
- Create: `apps/daemon/src/git/git.ts`, `git/index.ts`
- Test: `apps/daemon/src/git/git.test.ts`

**Interfaces:**
- Produces, from `git/index.ts`:
  - `interface Git`:
    - `head(repo): Promise<string>`, `status(repo): Promise<{ code: string; path: string }[]>`.
    - `changedFilesSince(repo, base): Promise<string[]>`, which covers committed and uncommitted changes, sorted and unique. `commitsSince(repo, base): Promise<string[]>`.
    - `commit(input: { repo: string; paths: readonly string[]; message: string; opId: string }): Promise<{ sha: string; alreadyCommitted: boolean }>`
  - `createGit(): Git`. Commits are serialized per repo through an in-process lock.
  - Every commit carries the trailer `10db-Op: <opId>`. A retry with the same `opId` finds that commit in the last 200 commits and returns its SHA.
  - Errors: `InvalidError` for a path outside the repo (checked lexically and then with the guard's symlink-aware `resolveInRepo`) or "nothing to commit"; `GitError` (exported) when git itself fails. A rejected path rejects the returned promise; `commit` never throws synchronously.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/git/git.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { InvalidError } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, tempDir } from '../../test/fixtures';
import { createGit } from './index';

const git = createGit();
let repo: { path: string; cleanup(): void };
beforeEach(async () => { repo = await createTempRepo(); });
afterEach(() => { repo.cleanup(); });

const write = (rel: string, text: string) => { writeFileSync(join(repo.path, rel), text); };
const commitCount = () => Number(execFileSync('git', ['-C', repo.path, 'rev-list', '--count', 'HEAD']).toString().trim());

describe('commit', () => {
  it('commits only the named paths and leaves other changes alone', async () => {
    write('a.txt', 'a');
    write('b.txt', 'b');
    const { sha, alreadyCommitted } = await git.commit({ repo: repo.path, paths: ['a.txt'], message: 'Add a', opId: 'op-commit-a1' });
    expect(sha).toMatch(/^[0-9a-f]{40}$/);
    expect(alreadyCommitted).toBe(false);
    expect((await git.status(repo.path)).map((s) => s.path)).toEqual(['b.txt']);
  });

  it('returns the original commit when the same operation is retried', async () => {
    write('a.txt', 'a');
    const first = await git.commit({ repo: repo.path, paths: ['a.txt'], message: 'Add a', opId: 'op-retry-001' });
    write('a.txt', 'changed after the first commit');
    const retry = await git.commit({ repo: repo.path, paths: ['a.txt'], message: 'Add a', opId: 'op-retry-001' });
    expect(retry).toEqual({ sha: first.sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it.each([['../escape.txt'], ['/etc/hosts'], ['']])('rejects the path %j', async (path) => {
    await expect(git.commit({ repo: repo.path, paths: [path], message: 'x', opId: 'op-badpath-1' })).rejects.toThrow(InvalidError);
  });

  it('rejects a path through a symlinked parent that leaves the repo', async () => {
    const outside = tempDir('git-outside');
    try {
      writeFileSync(join(outside.path, 'x.ts'), 'x');
      symlinkSync(outside.path, join(repo.path, 'link'));
      await expect(git.commit({ repo: repo.path, paths: ['link/x.ts'], message: 'x', opId: 'op-symlink-1' })).rejects.toThrow(InvalidError);
    } finally {
      outside.cleanup();
    }
  });

  it('reports nothing to commit as an InvalidError', async () => {
    await expect(git.commit({ repo: repo.path, paths: ['README.md'], message: 'x', opId: 'op-nothing-1' })).rejects.toThrow(/Nothing to commit/);
  });

  it('records deletions of a named path', async () => {
    rmSync(join(repo.path, 'README.md'));
    await git.commit({ repo: repo.path, paths: ['README.md'], message: 'Remove readme', opId: 'op-delete-01' });
    expect(await git.status(repo.path)).toEqual([]);
  });

  it('serializes concurrent commits in one repo', async () => {
    write('x.txt', 'x');
    write('y.txt', 'y');
    const [x, y] = await Promise.all([
      git.commit({ repo: repo.path, paths: ['x.txt'], message: 'x', opId: 'op-parallel-x' }),
      git.commit({ repo: repo.path, paths: ['y.txt'], message: 'y', opId: 'op-parallel-y' }),
    ]);
    expect(x.sha).not.toBe(y.sha);
    expect(commitCount()).toBe(3);
  });
});

describe('history queries', () => {
  it('lists changed files and commits since a base', async () => {
    const base = await git.head(repo.path);
    write('a.txt', 'a');
    const { sha } = await git.commit({ repo: repo.path, paths: ['a.txt'], message: 'a', opId: 'op-history-1' });
    write('b.txt', 'b');
    expect(await git.changedFilesSince(repo.path, base)).toEqual(['a.txt', 'b.txt']);
    expect(await git.commitsSince(repo.path, base)).toEqual([sha]);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon git
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/git/git.ts`:
```ts
import { execFile } from 'node:child_process';
import { isAbsolute, normalize } from 'node:path';
import { promisify } from 'node:util';
import { InvalidError } from '@10db/contracts';
import { resolveInRepo } from '../guard';

const run = promisify(execFile);

export class GitError extends Error {
  override readonly name = 'GitError';
  readonly args: readonly string[];
  readonly stderr: string;
  constructor(args: readonly string[], stderr: string) {
    super(`git ${args.join(' ')} failed: ${stderr.trim().slice(0, 500)}`);
    this.args = args;
    this.stderr = stderr;
  }
}

export interface Git {
  head(repo: string): Promise<string>;
  status(repo: string): Promise<{ code: string; path: string }[]>;
  changedFilesSince(repo: string, base: string): Promise<string[]>;
  commitsSince(repo: string, base: string): Promise<string[]>;
  commit(input: { repo: string; paths: readonly string[]; message: string; opId: string }): Promise<{ sha: string; alreadyCommitted: boolean }>;
}

const OP_TRAILER = '10db-Op';

async function git(repo: string, args: readonly string[]): Promise<string> {
  try {
    const { stdout } = await run('git', ['-C', repo, ...args], {
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
      maxBuffer: 16 * 1024 * 1024,
    });
    return stdout;
  } catch (error) {
    const stderr = typeof error === 'object' && error !== null && 'stderr' in error ? String(error.stderr) : String(error);
    const stdout = typeof error === 'object' && error !== null && 'stdout' in error ? String(error.stdout) : '';
    throw new GitError(args, `${stderr}\n${stdout}`);
  }
}

/** Lexical checks first, then the guard's symlink-aware check, so `link/x` can't commit outside the repo. */
function checkPaths(repo: string, paths: readonly string[]): string[] {
  return paths.map((p) => {
    const clean = normalize(p);
    const lexicallyBad = p === '' || isAbsolute(p) || clean.startsWith('..') || clean === '.';
    if (lexicallyBad || !resolveInRepo(repo, clean).inside) throw new InvalidError(`Path ${JSON.stringify(p)} must be relative and inside the repository`);
    return clean;
  });
}

export function createGit(): Git {
  const locks = new Map<string, Promise<unknown>>();

  /** Runs `fn` after every earlier locked call for the same repo has settled. */
  function withRepoLock<T>(repo: string, fn: () => Promise<T>): Promise<T> {
    const previous = locks.get(repo) ?? Promise.resolve();
    const next = previous.then(fn, fn);
    locks.set(repo, next.catch(() => undefined));
    return next;
  }

  async function findCommitByOp(repo: string, opId: string): Promise<string | null> {
    const out = await git(repo, ['log', '-n', '200', `--format=%H%x1f%(trailers:key=${OP_TRAILER},valueonly,separator=%x2c)%x1e`]);
    for (const record of out.split('\x1e')) {
      const [sha, ops] = record.trim().split('\x1f');
      if (sha && ops?.split(',').map((o) => o.trim()).includes(opId)) return sha;
    }
    return null;
  }

  return {
    async head(repo) {
      return (await git(repo, ['rev-parse', 'HEAD'])).trim();
    },
    async status(repo) {
      const out = await git(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all']);
      return out.split('\0').filter(Boolean).map((entry) => ({ code: entry.slice(0, 2), path: entry.slice(3) }));
    },
    async changedFilesSince(repo, base) {
      const committed = (await git(repo, ['diff', '--name-only', `${base}..HEAD`])).split('\n').filter(Boolean);
      const working = (await this.status(repo)).map((s) => s.path);
      return [...new Set([...committed, ...working])].sort();
    },
    async commitsSince(repo, base) {
      return (await git(repo, ['rev-list', '--reverse', `${base}..HEAD`])).split('\n').filter(Boolean);
    },
    // async, so a rejected path becomes a rejected promise rather than a synchronous throw.
    async commit({ repo, paths, message, opId }) {
      const clean = checkPaths(repo, paths);
      return withRepoLock(repo, async () => {
        const existing = await findCommitByOp(repo, opId);
        if (existing) return { sha: existing, alreadyCommitted: true };
        await git(repo, ['add', '-A', '--', ...clean]);
        try {
          await git(repo, ['commit', '-q', '-m', message, '--trailer', `${OP_TRAILER}: ${opId}`, '--', ...clean]);
        } catch (error) {
          if (error instanceof GitError && /nothing (added )?to commit|no changes added/i.test(error.stderr)) {
            throw new InvalidError(`Nothing to commit in ${clean.join(', ')}`);
          }
          throw error;
        }
        return { sha: (await git(repo, ['rev-parse', 'HEAD'])).trim(), alreadyCommitted: false };
      });
    },
  };
}
```

`apps/daemon/src/git/index.ts`:
```ts
export { createGit, GitError, type Git } from './git';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon git
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/git apps/daemon/test/fixtures.ts && git commit -m 'feat(daemon): add path-scoped git commits under a repo lock with op trailers'
```
Expected: PASS. The deletion test deletes the tracked `README.md`, so the commit must record a deletion.

---

### Task 9: Gate runner

**Files:**
- Create: `apps/daemon/src/verify/gate-runner.ts`, `verify/index.ts`
- Test: `apps/daemon/src/verify/gate-runner.test.ts`

**Interfaces:**
- Produces, from `verify/index.ts`:
  - `interface GateResult { exitCode: number; durationMs: number; tail: string; logPath: string; timedOut: boolean; aborted: boolean }`. `tail` is the last 4 KiB of combined output.
  - `interface GateRunner { run(input: { repo: string; command: string; logPath: string; timeoutMs: number; env: Readonly<Record<string, string | undefined>>; signal?: AbortSignal; onSpawn?: (pid: number) => void }): Promise<GateResult> }`
  - `createGateRunner(): GateRunner`. It runs `/bin/sh -c <command>` in the repo, in its own process group, and kills the whole group on timeout (exit code 124) or when `signal` aborts (exit code 130, `aborted: true`). `onSpawn` receives the group leader's pid, so the runner can record it for recovery. A group that already exited is not an error.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/verify/gate-runner.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { createGateRunner } from './index';

const runner = createGateRunner();
let dir: { path: string; cleanup(): void };
beforeEach(() => { dir = tempDir('gate'); });
afterEach(() => { dir.cleanup(); });

const run = (command: string, timeoutMs = 10_000) =>
  runner.run({ repo: dir.path, command, logPath: join(dir.path, 'logs', 'gate.log'), timeoutMs, env: process.env });

describe('gate runner', () => {
  it('records a passing gate with its output in the log and the tail', async () => {
    const result = await run('echo checks-ok');
    expect(result).toMatchObject({ exitCode: 0, timedOut: false });
    expect(result.tail).toContain('checks-ok');
    expect(readFileSync(result.logPath, 'utf8')).toContain('checks-ok');
  });

  it('records the exit code of a failing gate and stderr', async () => {
    const result = await run('echo broken >&2; exit 3');
    expect(result.exitCode).toBe(3);
    expect(result.tail).toContain('broken');
  });

  it('kills the whole process group on timeout', async () => {
    const result = await run(`sh -c 'sleep 30' & echo started; wait`, 300);
    expect(result).toMatchObject({ exitCode: 124, timedOut: true });
    expect(result.durationMs).toBeLessThan(5_000);
  });

  it('kills the process group when aborted, and reports the spawned pid', async () => {
    const abort = new AbortController();
    const pids: number[] = [];
    const pending = runner.run({
      repo: dir.path, command: `sh -c 'sleep 30' & echo started; wait`, logPath: join(dir.path, 'logs', 'gate.log'), timeoutMs: 10_000, env: process.env,
      signal: abort.signal, onSpawn: (pid) => { pids.push(pid); },
    });
    setTimeout(() => { abort.abort(); }, 200);
    const result = await pending;
    expect(result).toMatchObject({ exitCode: 130, aborted: true, timedOut: false });
    expect(result.durationMs).toBeLessThan(5_000);
    expect(pids).toHaveLength(1);
  });

  it('keeps only the end of very long output in the tail', async () => {
    const result = await run(`yes line | head -n 5000; echo LAST-LINE`);
    expect(result.tail.length).toBeLessThanOrEqual(4096);
    expect(result.tail).toContain('LAST-LINE');
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon gate-runner
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/verify/gate-runner.ts`:
```ts
import { spawn } from 'node:child_process';
import { createWriteStream, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export interface GateResult {
  readonly exitCode: number;
  readonly durationMs: number;
  readonly tail: string;
  readonly logPath: string;
  readonly timedOut: boolean;
  readonly aborted: boolean;
}

export interface GateRunner {
  run(input: {
    readonly repo: string;
    readonly command: string;
    readonly logPath: string;
    readonly timeoutMs: number;
    readonly env: Readonly<Record<string, string | undefined>>;
    /** Aborting kills the whole process group (stop and cancel use this). */
    readonly signal?: AbortSignal;
    /** Receives the process-group leader's pid as soon as it exists. */
    readonly onSpawn?: (pid: number) => void;
  }): Promise<GateResult>;
}

const TAIL_BYTES = 4096;
const TIMEOUT_EXIT = 124;
const ABORT_EXIT = 130;

/** 10db runs the project's gate itself; done means this passed (spec §5.4). */
export function createGateRunner(): GateRunner {
  return {
    run({ repo, command, logPath, timeoutMs, env, signal, onSpawn }) {
      mkdirSync(dirname(logPath), { recursive: true });
      const log = createWriteStream(logPath);
      const started = performance.now();
      let tail = '';
      let timedOut = false;
      let aborted = false;
      const child = spawn('/bin/sh', ['-c', command], { cwd: repo, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
      if (child.pid !== undefined) onSpawn?.(child.pid);
      const onData = (chunk: Buffer): void => {
        log.write(chunk);
        tail = (tail + chunk.toString('utf8')).slice(-TAIL_BYTES);
      };
      child.stdout.on('data', onData);
      child.stderr.on('data', onData);
      const killGroup = (): void => {
        try {
          if (child.pid !== undefined) process.kill(-child.pid, 'SIGKILL');
        } catch {
          // ESRCH: the group already exited. Throwing here would be an uncaught exception in a timer.
        }
      };
      const timer = setTimeout(() => {
        timedOut = true;
        killGroup();
      }, timeoutMs);
      const onAbort = (): void => {
        aborted = true;
        killGroup();
      };
      if (signal?.aborted) onAbort();
      else signal?.addEventListener('abort', onAbort, { once: true });
      return new Promise<GateResult>((resolve, reject) => {
        child.on('error', (error) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          log.end();
          reject(error);
        });
        child.on('close', (code) => {
          clearTimeout(timer);
          signal?.removeEventListener('abort', onAbort);
          log.end(() => {
            resolve({
              exitCode: timedOut ? TIMEOUT_EXIT : aborted ? ABORT_EXIT : (code ?? 1),
              durationMs: Math.round(performance.now() - started),
              tail,
              logPath,
              timedOut,
              aborted,
            });
          });
        });
      });
    },
  };
}
```
The timeout uses the real `setTimeout` on purpose. It bounds a real child process, so the injected clock doesn't apply.

`apps/daemon/src/verify/index.ts`:
```ts
export { createGateRunner, type GateResult, type GateRunner } from './gate-runner';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon gate-runner
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/verify && git commit -m 'feat(daemon): add gate runner with process-group timeout, abort and output tail'
```

---

### Task 10: The session adapter interface and the fake adapter

**Files:**
- Create: `apps/daemon/src/sessions/types.ts`, `sessions/channel.ts`, `sessions/fake-adapter.ts`, `sessions/index.ts`
- Modify: `apps/daemon/package.json` (add `@modelcontextprotocol/sdk`)
- Test: `apps/daemon/src/sessions/fake-adapter.test.ts`

**Interfaces:**
- Consumes: `GuardVerdict` from `guard`; `matchesAllowedTool` from `permissions`.
- Produces, from `sessions/index.ts`. These are the exact shapes the M1b Claude adapter implements:
  - **Tool requests:**
    - `interface ToolRequest { toolName: string; input: Record<string, unknown>; toolUseId: string | null; signal: AbortSignal }`
    - `type ToolDecision = { behavior: 'allow'; updatedInput?: Record<string, unknown> } | { behavior: 'deny'; message: string; interrupt?: boolean }`
  - **`interface SessionSpec`**:
    - Identity: `sessionId`, `workstreamId`, `sequence: number` (1-based within the workstream).
    - Session setup: `cwd`, `prompt`, `model`, `effort`, `resumeProviderSessionId: string | null`, `env: Readonly<Record<string, string>>`, `allowedTools: readonly string[]`.
    - MCP: `mcp: { url: string; token: string; toolTimeoutMs: number }`.
    - Callbacks: `preToolUse(req: { toolName: string; input: unknown }): GuardVerdict` and `canUseTool(req: ToolRequest): Promise<ToolDecision>`.
  - **`type SessionEvent`**:
    - `{ type: 'started'; providerSessionId; pid: number | null }`
    - `{ type: 'activity'; kind: 'text' | 'tool'; summary }`
    - `{ type: 'context'; percentage; totalTokens; maxTokens }`
    - `{ type: 'turn_complete'; inputTokens; outputTokens; costUsd }`
    - `{ type: 'rate_limit'; status: 'allowed' | 'allowed_warning' | 'rejected'; resetsAt: Date | null }`
    - `{ type: 'compacted'; trigger: 'manual' | 'auto' }`
    - `{ type: 'ended'; reason: 'completed' | 'stopped' | 'error' | 'rate_limited'; message: string | null }`
  - `interface SessionHandle { readonly events: AsyncIterable<SessionEvent>; send(text: string): void; stop(): Promise<void> }`. `ended` is always the last event, exactly once.
  - `interface SessionAdapter { readonly provider: Provider; start(spec: SessionSpec): SessionHandle }`
  - **Fake scripts:** `FakeStep` and `FakeScriptBook` (zod). The book maps a task title to one step list per session sequence: `Record<string, FakeStep[][]>`.
  - **`class FakeAdapter implements SessionAdapter`**:
    - Constructor: `constructor(book: FakeScriptBook)`.
    - Recorded state: `readonly observations: FakeObservation[]` and `readonly prompts: { sessionId; sequence; title; prompt; resume: string | null }[]`.
    - `loadFakeScriptBook(path): FakeScriptBook`
  - **Fake behavior:**
    - The fake finds its script by the line `Task: <title>` in the prompt.
    - A `tool` step emulates Claude Code. `preToolUse` runs first. Then an allow rule applies, or `canUseTool` is called; `AskUserQuestion` always goes to `canUseTool`. An allowed `Write` or `Edit` is applied to the file under `cwd`.
    - An `mcp` step calls the daemon's real MCP endpoint over HTTP with the session token.

- [ ] **Step 1: Add the dependency and write the failing test**

```bash
pnpm add --filter @10db/daemon @modelcontextprotocol/sdk@1.32.1
```

`apps/daemon/src/sessions/fake-adapter.test.ts`:
```ts
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { mintId } from '@10db/contracts';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { FakeAdapter, type FakeScriptBook, type SessionEvent, type SessionSpec, type ToolRequest } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => { dir = tempDir('fake'); });
afterEach(() => { dir.cleanup(); });

function spec(overrides: Partial<SessionSpec> = {}): SessionSpec {
  return {
    sessionId: mintId('Session'),
    workstreamId: mintId('Workstream'),
    sequence: 1,
    cwd: dir.path,
    prompt: 'Task: Alpha\nDo it.',
    model: 'sonnet',
    effort: 'medium',
    resumeProviderSessionId: null,
    env: {},
    allowedTools: ['Write'],
    mcp: { url: 'http://127.0.0.1:1/mcp', token: 't', toolTimeoutMs: 1000 },
    preToolUse: () => ({ decision: 'allow' }),
    canUseTool: () => Promise.resolve({ behavior: 'allow' }),
    ...overrides,
  };
}

async function collect(events: AsyncIterable<SessionEvent>): Promise<SessionEvent[]> {
  const out: SessionEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

describe('FakeAdapter', () => {
  it('emits started, the scripted events, then ended exactly once', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'context', percentage: 40 }, { do: 'turn_complete' }]] });
    const events = await collect(adapter.start(spec()).events);
    expect(events.map((e) => e.type)).toEqual(['started', 'context', 'turn_complete', 'ended']);
    expect(events.at(-1)).toEqual({ type: 'ended', reason: 'completed', message: null });
  });

  it('picks the script for the session sequence', async () => {
    const book: FakeScriptBook = { Alpha: [[{ do: 'end' }], [{ do: 'activity', summary: 'second session' }]] };
    const adapter = new FakeAdapter(book);
    const events = await collect(adapter.start(spec({ sequence: 2 })).events);
    expect(events).toContainEqual({ type: 'activity', kind: 'text', summary: 'second session' });
  });

  it('crashes a session that has no script', async () => {
    const events = await collect(new FakeAdapter({}).start(spec()).events);
    expect(events.at(-1)).toMatchObject({ type: 'ended', reason: 'error' });
  });

  it('applies an allowed Write and skips canUseTool for allow-listed tools', async () => {
    const canUseTool = vi.fn<SessionSpec['canUseTool']>(() => Promise.resolve({ behavior: 'allow' }));
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'out.txt', content: 'hello' } }]] });
    await collect(adapter.start(spec({ canUseTool })).events);
    expect(readFileSync(join(dir.path, 'out.txt'), 'utf8')).toBe('hello');
    expect(canUseTool).not.toHaveBeenCalled();
  });

  it('records a guard denial without calling canUseTool or writing', async () => {
    const canUseTool = vi.fn<SessionSpec['canUseTool']>(() => Promise.resolve({ behavior: 'allow' }));
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'tool', toolName: 'Write', input: { file_path: 'x.txt', content: 'x' } }]] });
    await collect(adapter.start(spec({ canUseTool, preToolUse: () => ({ decision: 'deny', reason: 'outside claims' }) })).events);
    expect(canUseTool).not.toHaveBeenCalled();
    expect(adapter.observations).toContainEqual(expect.objectContaining({ kind: 'denied_by_guard', detail: { reason: 'outside claims' } }));
  });

  it('routes AskUserQuestion through canUseTool and records the answers', async () => {
    const canUseTool = vi.fn((req: ToolRequest) => Promise.resolve({ behavior: 'allow' as const, updatedInput: { ...req.input, answers: { 'Which?': 'A' } } }));
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'tool', toolName: 'AskUserQuestion', input: { questions: [] } }]] });
    await collect(adapter.start(spec({ canUseTool, allowedTools: ['AskUserQuestion'] })).events);
    expect(canUseTool).toHaveBeenCalledOnce();
    expect(adapter.observations).toContainEqual(
      expect.objectContaining({ kind: 'tool_allowed', detail: { toolName: 'AskUserQuestion', answers: { 'Which?': 'A' } } }),
    );
  });

  it('waits for a message containing the expected text', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'await_message', contains: 'write_handoff' }, { do: 'activity', summary: 'got it' }]] });
    const handle = adapter.start(spec());
    const done = collect(handle.events);
    handle.send('unrelated');
    handle.send('please call write_handoff now');
    expect((await done).map((e) => e.type)).toEqual(['started', 'activity', 'ended']);
  });

  it('ends with stopped when stopped during a hang', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'hang' }]] });
    const handle = adapter.start(spec());
    const done = collect(handle.events);
    await handle.stop();
    expect((await done).at(-1)).toEqual({ type: 'ended', reason: 'stopped', message: null });
  });

  it('records the prompt it was started with', async () => {
    const adapter = new FakeAdapter({ Alpha: [[{ do: 'end' }]] });
    await collect(adapter.start(spec({ resumeProviderSessionId: 'prov-1' })).events);
    expect(adapter.prompts[0]).toMatchObject({ title: 'Alpha', resume: 'prov-1' });
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon fake-adapter
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/sessions/types.ts`:
```ts
import type { Effort, Provider, SessionId, WorkstreamId } from '@10db/contracts';
import type { GuardVerdict } from '../guard';

export interface ToolRequest {
  readonly toolName: string;
  readonly input: Record<string, unknown>;
  readonly toolUseId: string | null;
  readonly signal: AbortSignal;
}

export type ToolDecision =
  | { readonly behavior: 'allow'; readonly updatedInput?: Record<string, unknown> }
  | { readonly behavior: 'deny'; readonly message: string; readonly interrupt?: boolean };

export interface SessionSpec {
  readonly sessionId: SessionId;
  readonly workstreamId: WorkstreamId;
  readonly sequence: number;
  readonly cwd: string;
  readonly prompt: string;
  readonly model: string;
  readonly effort: Effort;
  readonly resumeProviderSessionId: string | null;
  readonly env: Readonly<Record<string, string>>;
  readonly allowedTools: readonly string[];
  readonly mcp: { readonly url: string; readonly token: string; readonly toolTimeoutMs: number };
  /** The workspace guard: runs before every tool call, before permission rules. */
  preToolUse(req: { readonly toolName: string; readonly input: unknown }): GuardVerdict;
  /** Called for questions and for tool calls no allow rule covers. */
  canUseTool(req: ToolRequest): Promise<ToolDecision>;
}

export type SessionEvent =
  | { readonly type: 'started'; readonly providerSessionId: string; readonly pid: number | null }
  | { readonly type: 'activity'; readonly kind: 'text' | 'tool'; readonly summary: string }
  | { readonly type: 'context'; readonly percentage: number; readonly totalTokens: number; readonly maxTokens: number }
  | { readonly type: 'turn_complete'; readonly inputTokens: number; readonly outputTokens: number; readonly costUsd: number }
  | { readonly type: 'rate_limit'; readonly status: 'allowed' | 'allowed_warning' | 'rejected'; readonly resetsAt: Date | null }
  | { readonly type: 'compacted'; readonly trigger: 'manual' | 'auto' }
  | { readonly type: 'ended'; readonly reason: 'completed' | 'stopped' | 'error' | 'rate_limited'; readonly message: string | null };

export interface SessionHandle {
  /** Ends with exactly one `ended` event. */
  readonly events: AsyncIterable<SessionEvent>;
  /** Queues a user message; the agent sees it at its next opportunity. */
  send(text: string): void;
  /** Ends the session cleanly; resolves once `ended` has been emitted. */
  stop(): Promise<void>;
}

export interface SessionAdapter {
  readonly provider: Provider;
  start(spec: SessionSpec): SessionHandle;
}
```

`apps/daemon/src/sessions/channel.ts`:
```ts
/** A single-consumer async queue: push values, then end; iterate with for-await. */
export interface Channel<T> extends AsyncIterable<T> {
  push(value: T): void;
  end(): void;
}

export function createChannel<T>(): Channel<T> {
  const buffer: T[] = [];
  let ended = false;
  let wake: (() => void) | null = null;
  const notify = (): void => {
    wake?.();
    wake = null;
  };
  return {
    push(value) {
      if (ended) return;
      buffer.push(value);
      notify();
    },
    end() {
      ended = true;
      notify();
    },
    async *[Symbol.asyncIterator]() {
      for (;;) {
        const next = buffer.shift();
        if (next !== undefined) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => { wake = resolve; });
      }
    },
  };
}
```

`apps/daemon/src/sessions/fake-adapter.ts`:
```ts
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { Provider, type SessionId } from '@10db/contracts';
import { z } from 'zod';
import { matchesAllowedTool } from '../permissions';
import { createChannel } from './channel';
import type { SessionAdapter, SessionEvent, SessionHandle, SessionSpec, ToolDecision } from './types';

const Json: z.ZodType = z.json();

export const FakeStep = z.discriminatedUnion('do', [
  z.object({ do: z.literal('context'), percentage: z.number().min(0).max(100) }),
  z.object({ do: z.literal('activity'), summary: z.string() }),
  z.object({ do: z.literal('tool'), toolName: z.string(), input: z.record(z.string(), Json) }),
  z.object({ do: z.literal('mcp'), tool: z.string(), args: z.record(z.string(), Json) }),
  z.object({ do: z.literal('await_message'), contains: z.string() }),
  z.object({ do: z.literal('turn_complete') }),
  z.object({ do: z.literal('rate_limit'), status: z.enum(['allowed', 'allowed_warning', 'rejected']), resetsInSeconds: z.number().nullable() }),
  z.object({ do: z.literal('compact') }),
  z.object({ do: z.literal('crash'), message: z.string() }),
  z.object({ do: z.literal('hang') }),
  z.object({ do: z.literal('end') }),
]);
export type FakeStep = z.infer<typeof FakeStep>;

/** Task title → one step list per session, indexed by the session's sequence within its workstream. */
export const FakeScriptBook = z.record(z.string(), z.array(z.array(FakeStep)));
export type FakeScriptBook = z.infer<typeof FakeScriptBook>;

export function loadFakeScriptBook(path: string): FakeScriptBook {
  return FakeScriptBook.parse(JSON.parse(readFileSync(path, 'utf8')));
}

export interface FakeObservation {
  readonly sessionId: SessionId;
  readonly sequence: number;
  readonly title: string;
  readonly step: number;
  readonly kind: 'denied_by_guard' | 'tool_allowed' | 'tool_denied' | 'mcp_result';
  readonly detail: Record<string, unknown>;
}

/** Stands in for Claude Code at the adapter boundary; scripts drive every event. */
export class FakeAdapter implements SessionAdapter {
  readonly provider = Provider.Claude;
  readonly observations: FakeObservation[] = [];
  readonly prompts: { sessionId: SessionId; sequence: number; title: string; prompt: string; resume: string | null }[] = [];

  private readonly book: FakeScriptBook;

  constructor(book: FakeScriptBook) {
    this.book = book;
  }

  start(spec: SessionSpec): SessionHandle {
    const title = Object.keys(this.book).find((t) => spec.prompt.includes(`Task: ${t}\n`)) ?? '';
    const steps = this.book[title]?.[spec.sequence - 1];
    this.prompts.push({ sessionId: spec.sessionId, sequence: spec.sequence, title, prompt: spec.prompt, resume: spec.resumeProviderSessionId });

    const channel = createChannel<SessionEvent>();
    const abort = new AbortController();
    const messages: string[] = [];
    let messageWaiter: (() => void) | null = null;
    let ended = false;
    let mcp: Client | null = null;
    let finished: () => void = () => undefined;
    const done = new Promise<void>((r) => { finished = r; });

    const end = (reason: 'completed' | 'stopped' | 'error' | 'rate_limited', message: string | null): void => {
      if (ended) return;
      ended = true;
      channel.push({ type: 'ended', reason, message });
      channel.end();
      void mcp?.close();
      finished();
    };
    const untilStopped = new Promise<'stopped'>((r) => { abort.signal.addEventListener('abort', () => { r('stopped'); }); });
    const observe = (step: number, kind: FakeObservation['kind'], detail: Record<string, unknown>): void => {
      this.observations.push({ sessionId: spec.sessionId, sequence: spec.sequence, title, step, kind, detail });
    };

    const applyFileEffect = (toolName: string, input: Record<string, unknown>): void => {
      const file = typeof input['file_path'] === 'string' ? resolve(spec.cwd, input['file_path']) : null;
      if (!file) return;
      if (toolName === 'Write' && typeof input['content'] === 'string') {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, input['content']);
      }
      if (toolName === 'Edit' && typeof input['old_string'] === 'string' && typeof input['new_string'] === 'string') {
        writeFileSync(file, readFileSync(file, 'utf8').replace(input['old_string'], input['new_string']));
      }
    };

    const callMcp = async (tool: string, args: Record<string, unknown>): Promise<{ isError: boolean; text: string }> => {
      if (!mcp) {
        mcp = new Client({ name: 'fake-claude', version: '0.0.0' });
        const transport = new StreamableHTTPClientTransport(new URL(spec.mcp.url), { requestInit: { headers: { Authorization: `Bearer ${spec.mcp.token}` } } });
        // The SDK class declares `sessionId?: string`, which `Transport` rejects under exactOptionalPropertyTypes.
        await mcp.connect(transport as Transport);
      }
      const result = await mcp.callTool({ name: tool, arguments: args }, undefined, { timeout: spec.mcp.toolTimeoutMs, signal: abort.signal });
      const content = Array.isArray(result.content) ? result.content : [];
      const text = content.map((c: { type?: string; text?: string }) => (c.type === 'text' ? (c.text ?? '') : '')).join('');
      return { isError: result.isError === true, text };
    };

    const runStep = async (step: FakeStep, index: number): Promise<'continue' | 'halt'> => {
      switch (step.do) {
        case 'context':
          channel.push({ type: 'context', percentage: step.percentage, totalTokens: step.percentage * 2000, maxTokens: 200_000 });
          return 'continue';
        case 'activity':
          channel.push({ type: 'activity', kind: 'text', summary: step.summary });
          return 'continue';
        case 'tool': {
          const input = step.input;
          channel.push({ type: 'activity', kind: 'tool', summary: step.toolName });
          const verdict = spec.preToolUse({ toolName: step.toolName, input });
          if (verdict.decision === 'deny') {
            observe(index, 'denied_by_guard', { reason: verdict.reason });
            return 'continue';
          }
          let decision: ToolDecision = { behavior: 'allow' };
          if (step.toolName === 'AskUserQuestion' || !matchesAllowedTool(step.toolName, input, spec.allowedTools)) {
            const asked = await Promise.race([spec.canUseTool({ toolName: step.toolName, input, toolUseId: `fake-tool-${String(index)}`, signal: abort.signal }), untilStopped]);
            if (asked === 'stopped') return 'halt';
            decision = asked;
          }
          if (decision.behavior === 'deny') {
            observe(index, 'tool_denied', { toolName: step.toolName, message: decision.message });
            return 'continue';
          }
          const effective = decision.updatedInput ?? input;
          applyFileEffect(step.toolName, effective);
          observe(index, 'tool_allowed', { toolName: step.toolName, ...(effective['answers'] ? { answers: effective['answers'] } : {}) });
          return 'continue';
        }
        case 'mcp': {
          const result = await Promise.race([callMcp(step.tool, step.args), untilStopped]);
          if (result === 'stopped') return 'halt';
          observe(index, 'mcp_result', { tool: step.tool, isError: result.isError, text: result.text });
          return 'continue';
        }
        case 'await_message': {
          for (;;) {
            if (messages.some((m) => m.includes(step.contains))) return 'continue';
            const woke = await Promise.race([new Promise<'message'>((r) => { messageWaiter = () => { r('message'); }; }), untilStopped]);
            if (woke === 'stopped') return 'halt';
          }
        }
        case 'turn_complete':
          channel.push({ type: 'turn_complete', inputTokens: 1000, outputTokens: 200, costUsd: 0.01 });
          return 'continue';
        case 'rate_limit':
          channel.push({ type: 'rate_limit', status: step.status, resetsAt: step.resetsInSeconds === null ? null : new Date(Date.now() + step.resetsInSeconds * 1000) });
          if (step.status === 'rejected') {
            end('rate_limited', 'usage limit reached');
            return 'halt';
          }
          return 'continue';
        case 'compact':
          channel.push({ type: 'compacted', trigger: 'auto' });
          return 'continue';
        case 'crash':
          end('error', step.message);
          return 'halt';
        case 'hang':
          await untilStopped;
          return 'halt';
        case 'end':
          end('completed', null);
          return 'halt';
      }
    };

    void (async () => {
      channel.push({ type: 'started', providerSessionId: spec.resumeProviderSessionId ?? `fake-${spec.sessionId}`, pid: null });
      if (!steps) {
        end('error', `No fake script for "${title}" session ${String(spec.sequence)}`);
        return;
      }
      try {
        // Every step that ends the session returns 'halt', so only a stop needs checking here.
        for (const [index, step] of steps.entries()) {
          if (abort.signal.aborted) break;
          if ((await runStep(step, index)) === 'halt') break;
        }
        end(abort.signal.aborted ? 'stopped' : 'completed', null);
      } catch (error) {
        end(abort.signal.aborted ? 'stopped' : 'error', error instanceof Error ? error.message : String(error));
      }
    })();

    return {
      events: channel,
      send(text) {
        messages.push(text);
        messageWaiter?.();
        messageWaiter = null;
      },
      async stop() {
        abort.abort();
        end('stopped', null);
        await done;
      },
    };
  }
}
```
The fake's rate-limit `resetsAt` uses wall-clock `Date.now()`. Tests that need a deterministic reset compare it against the runner's injected clock with tolerance, or they use `resetsInSeconds: null`.

`apps/daemon/src/sessions/index.ts`:
```ts
export { createChannel, type Channel } from './channel';
export { FakeAdapter, FakeScriptBook, FakeStep, loadFakeScriptBook, type FakeObservation } from './fake-adapter';
export type { SessionAdapter, SessionEvent, SessionHandle, SessionSpec, ToolDecision, ToolRequest } from './types';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon fake-adapter
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/sessions apps/daemon/package.json pnpm-lock.yaml && git commit -m 'feat(daemon): add session adapter interface and scripted fake adapter'
```
Expected: PASS.

### Task 11: Event bus, StateStore and logger

**Files:**
- Create: `apps/daemon/src/events/index.ts`, `events/bus.ts`, `events/state-store.ts`
- Create: `apps/daemon/src/log/index.ts`
- Modify: `apps/daemon/package.json` (add `pino`), `packages/db/src/index.ts` (export test support)
- Test: `apps/daemon/src/events/events.test.ts`, `apps/daemon/src/log/log.test.ts`

**Interfaces:**
- Consumes: `createStore`, `Store`, `WriteContext` and `TendbDatabase` from `@10db/db`.
- Produces:
  - **Event bus** (`events/index.ts`): `interface EventBus { publish(events: readonly DaemonEvent[]): void; subscribe(listener): () => void }` and `createEventBus(onListenerError?)`.
  - **StateStore** (`events/index.ts`):
    - `interface StateStore { readonly db: TendbDatabase; now(): string; write<T>(fn: (ctx: WriteContext) => T): T }`. `write` commits, then publishes the transaction's events.
    - `createStateStore(store: Store, bus: EventBus): StateStore`
  - **Logger** (`log/index.ts`):
    - `interface Logger { debug; info; warn; error; child(bindings): Logger }`. Each method is `(obj: object, msg?: string) => void`.
    - `createLogger({ level, destination? }): Logger`, which redacts `token`, `authorization` and `mcpToken` at any depth up to two.
    - `silentLogger`
  - `@10db/db` now also exports `createTestStore` and `seedProject`, so daemon tests can share them.

- [ ] **Step 1: Add the dependency and export the db test support**

```bash
pnpm add --filter @10db/daemon pino@10.4.0
```
Append to `packages/db/src/store/index.ts`:
```ts
export { createTestStore, seedProject } from './test-support';
```

- [ ] **Step 2: Write the failing tests**

`apps/daemon/src/events/events.test.ts`:
```ts
import type { DaemonEvent } from '@10db/contracts';
import { createTestStore, insertProject } from '@10db/db';
import { afterAll, describe, expect, it } from 'vitest';
import { createEventBus, createStateStore } from './index';

const { store, close } = createTestStore();
afterAll(() => { close(); });

const projectInput = (name: string) => ({ name, repoPath: `/tmp/${name}`, gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }] });

describe('StateStore', () => {
  it('publishes events only after the transaction commits', () => {
    const bus = createEventBus();
    const seen: DaemonEvent[] = [];
    bus.subscribe((e) => seen.push(e));
    const state = createStateStore(store, bus);
    state.write((ctx) => insertProject(ctx, projectInput('one')));
    expect(seen.map((e) => e.type)).toEqual(['project.created']);
    expect(() => state.write((ctx) => { insertProject(ctx, projectInput('two')); throw new Error('rollback'); })).toThrow('rollback');
    expect(seen).toHaveLength(1);
  });

  it('keeps delivering to other listeners when one throws, and reports the error', () => {
    const errors: unknown[] = [];
    const bus = createEventBus((e) => errors.push(e));
    const seen: number[] = [];
    bus.subscribe(() => { throw new Error('bad listener'); });
    const unsubscribe = bus.subscribe((e) => seen.push(e.seq));
    const state = createStateStore(store, bus);
    state.write((ctx) => insertProject(ctx, projectInput('three')));
    unsubscribe();
    state.write((ctx) => insertProject(ctx, projectInput('four')));
    expect(seen).toHaveLength(1);
    expect(errors).toHaveLength(2);
  });
});
```
`apps/daemon/src/log/log.test.ts`:
```ts
import { describe, expect, it } from 'vitest';
import { createLogger } from './index';

describe('createLogger', () => {
  it('redacts tokens and authorization headers', () => {
    const lines: string[] = [];
    const logger = createLogger({ level: 'info', destination: { write: (line: string) => { lines.push(line); } } });
    logger.info({ token: 'secret-1', mcp: { token: 'secret-2' }, headers: { authorization: 'Bearer secret-3' } }, 'starting');
    const text = lines.join('');
    expect(text).toContain('starting');
    expect(text).not.toMatch(/secret-[123]/);
    expect(text).toContain('[redacted]');
  });
});
```

- [ ] **Step 3: Run them to see them fail**

```bash
pnpm vitest run --project daemon events log
```
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 4: Implement**

`apps/daemon/src/events/bus.ts`:
```ts
import type { DaemonEvent } from '@10db/contracts';

export interface EventBus {
  publish(events: readonly DaemonEvent[]): void;
  subscribe(listener: (event: DaemonEvent) => void): () => void;
}

export function createEventBus(onListenerError: (error: unknown) => void = () => undefined): EventBus {
  const listeners = new Set<(event: DaemonEvent) => void>();
  return {
    publish(events) {
      for (const event of events) {
        for (const listener of listeners) {
          try {
            listener(event);
          } catch (error) {
            onListenerError(error);
          }
        }
      }
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}
```

`apps/daemon/src/events/state-store.ts`:
```ts
import type { Store, TendbDatabase, WriteContext } from '@10db/db';
import type { EventBus } from './bus';

/** The daemon's single write path: commit rows and events, then push the events. */
export interface StateStore {
  readonly db: TendbDatabase;
  now(): string;
  write<T>(fn: (ctx: WriteContext) => T): T;
}

export function createStateStore(store: Store, bus: EventBus): StateStore {
  return {
    db: store.db,
    now: () => store.now(),
    write(fn) {
      const { value, events } = store.write(fn);
      bus.publish(events);
      return value;
    },
  };
}
```

`apps/daemon/src/events/index.ts`:
```ts
export { createEventBus, type EventBus } from './bus';
export { createStateStore, type StateStore } from './state-store';
```

`apps/daemon/src/log/index.ts`:
```ts
import pino, { type DestinationStream } from 'pino';
import type { LogLevel } from '../env';

type LogFn = (obj: object, msg?: string) => void;

export interface Logger {
  debug: LogFn;
  info: LogFn;
  warn: LogFn;
  error: LogFn;
  child(bindings: Record<string, string>): Logger;
}

const REDACT_PATHS = ['token', '*.token', '*.*.token', 'authorization', '*.authorization', '*.*.authorization', 'mcpToken', '*.mcpToken'];

export function createLogger(options: { readonly level: LogLevel; readonly destination?: DestinationStream }): Logger {
  return pino({ level: options.level, redact: { paths: REDACT_PATHS, censor: '[redacted]' }, base: { pid: process.pid } }, options.destination);
}

export const silentLogger: Logger = pino({ level: 'silent' });
```

- [ ] **Step 5: Run, check, commit**

```bash
pnpm vitest run --project daemon events log
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/events apps/daemon/src/log apps/daemon/package.json packages/db/src/store/index.ts pnpm-lock.yaml && git commit -m 'feat(daemon): add event bus, commit-then-publish state store and redacting logger'
```

---

### Task 12: Inbox service and permission broker

**Files:**
- Create: `apps/daemon/src/inbox/service.ts`, `inbox/permission-broker.ts`, `inbox/index.ts`
- Modify: `apps/daemon/test/fixtures.ts` (add `seedWorkstream`)
- Test: `apps/daemon/src/inbox/inbox.test.ts`

**Interfaces:**
- Consumes: the inbox, knowledge and permission-rule repositories; `StateStore`; `matchPermissionRule` and `commandPrefix`; the `ToolRequest` and `ToolDecision` types from `sessions`.
- Produces, from `inbox/index.ts`:
  - **Errors and inputs:**
    - `class ParkedError extends Error`, which rejects an answer promise when the session stops waiting.
    - `interface AskInput { projectId; workstreamId; sessionId; kind: 'question' | 'permission'; title; body; options; recommendation: string | null; category; urgency; detail: Record<string, Json> | null; signal: AbortSignal }`
    - `foldKeyFor(input): string`
  - **`interface InboxService`**:
    - `ask(input: AskInput): { item: InboxItemDto; answer: Promise<InboxAnswer> }`. It folds into an open identical card. The `answer` promise already carries a no-op rejection handler, so a caller that never awaits it (because `onWaitStart` threw, or the session was parked) cannot cause an unhandled rejection.
    - `answer(id, answer: InboxAnswer): InboxItemDto`. It throws `ConflictError` if the card isn't OPEN, and `InvalidError` if the choice isn't one of the options. In the same transaction as the answer it applies what the answer implies, whether or not a session is still waiting: a permission card's `allow_workstream` / `allow_project` writes the rule (one per target workstream, or one project rule plus a decision), and a proposal card's `accept` / `reject` sets `proposals.status` and `rationale` (the note).
    - `flag(input: { projectId; workstreamId: WorkstreamId | null; title; body; detail?: Record<string, Json>; foldKey?: string }): InboxItemDto`
    - `cancelForWorkstream(workstreamId): void`
    - `redeliver(id): InboxItemDto`
  - `createInboxService({ state, onParkedAnswer(target: InboxTarget, item: InboxItemDto): void }): InboxService`
  - **Permission broker:**
    - `interface WaitObserver { onWaitStart(item: InboxItemDto): void; onWaitEnd(item: InboxItemDto): void }`
    - `createPermissionBroker(deps: { state; inbox }, ctx: { projectId; workstreamId; sessionId; observer: WaitObserver; signal: AbortSignal; allowOnce?: { toolName: string; summary: string } | null }): (req: ToolRequest) => Promise<ToolDecision>`. `allowOnce` carries an `allow_once` answer that arrived after the workstream was parked: the first matching call in the resumed session is allowed without a new card. The broker writes no rules itself; `inbox.answer` does.
  - **Lifecycle:**
    - A question card goes `OPEN → ANSWERED → DELIVERING → RESOLVED`. Flag and proposal cards go `OPEN → RESOLVED` when answered.
    - An answer in a decision category writes a `decisions` row with an `inbox_answer` source.
    - A target with no live waiter is handed to `onParkedAnswer`.
- `apps/daemon/test/fixtures.ts` gains `seedWorkstream(store: Store, opts?: { project?: ProjectDto; title?: string; areas?: string[]; repoPath?: string }): { project; task; workstream }`.

- [ ] **Step 1: Extend the fixtures**

Append to `apps/daemon/test/fixtures.ts`:
```ts
import type { ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { insertTask, insertWorkstream, seedProject, type Store } from '@10db/db';

export function seedWorkstream(
  store: Store,
  opts: { project?: ProjectDto; title?: string; areas?: string[]; repoPath?: string; gateCommand?: string } = {},
): { project: ProjectDto; task: TaskDto; workstream: WorkstreamDto } {
  const project =
    opts.project ??
    seedProject(store, {
      ...(opts.repoPath ? { repoPath: opts.repoPath } : {}),
      ...(opts.gateCommand ? { gateCommand: opts.gateCommand } : {}),
    });
  const task = store.write((ctx) =>
    insertTask(ctx, project.id, { title: opts.title ?? 'Alpha', acceptanceCriteria: ['it works'], areas: opts.areas ?? ['api'] }),
  ).value;
  const workstream = store.write((ctx) => insertWorkstream(ctx, task.id)).value;
  return { project, task, workstream };
}
```
Move the new imports to the top of the file.

- [ ] **Step 2: Write the failing test**

`apps/daemon/src/inbox/inbox.test.ts`:
```ts
import { ConflictError, InvalidError, mintId, type InboxItemDto, type InboxTarget } from '@10db/contracts';
import {
  createTestStore,
  getInboxItem,
  getProposal,
  insertInboxItem,
  insertProposal,
  insertSource,
  listInbox,
  listPermissionRules,
  searchDecisions,
  updateInboxItem,
} from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService, createPermissionBroker, ParkedError, type InboxService, type WaitObserver } from './index';

let close: () => void;
let state: StateStore;
let inbox: InboxService;
let parked: { target: InboxTarget; item: InboxItemDto }[];
let base: ReturnType<typeof createTestStore>['store'];

beforeEach(() => {
  const test = createTestStore();
  base = test.store;
  close = test.close;
  state = createStateStore(test.store, createEventBus());
  parked = [];
  inbox = createInboxService({ state, onParkedAnswer: (target, item) => parked.push({ target, item }) });
});
afterEach(() => { close(); });

function ask(ctx: ReturnType<typeof seedWorkstream>, signal = new AbortController().signal, sessionId = mintId('Session')) {
  return inbox.ask({
    projectId: ctx.project.id,
    workstreamId: ctx.workstream.id,
    sessionId,
    kind: 'question',
    title: 'Which color?',
    body: 'For the badge',
    options: [{ label: 'Teal', description: '' }, { label: 'Red', description: '' }],
    recommendation: 'Teal',
    category: 'design',
    urgency: 'normal',
    detail: null,
    signal,
  });
}

describe('inbox questions', () => {
  it('resolves a live waiter and records a design answer as a decision', async () => {
    const ws = seedWorkstream(base);
    const { item, answer } = ask(ws);
    const final = inbox.answer(item.id, { choice: 'Teal', note: 'brand color' });
    expect(await answer).toEqual({ choice: 'Teal', note: 'brand color' });
    expect(final.state).toBe('RESOLVED');
    expect(searchDecisions(state.db, ws.project.id, 'color', 5).map((d) => d.choice)).toEqual(['Teal']);
  });

  it('folds an identical question from two workstreams into one card and resumes both', async () => {
    const a = seedWorkstream(base, { title: 'A' });
    const b = seedWorkstream(base, { project: a.project, title: 'B', areas: ['ui'] });
    const first = ask(a);
    const second = ask(b);
    expect(second.item.id).toBe(first.item.id);
    expect(getInboxItem(state.db, first.item.id).targets.map((t) => t.workstreamId)).toEqual([a.workstream.id, b.workstream.id]);
    inbox.answer(first.item.id, { choice: 'Red' });
    expect(await Promise.all([first.answer, second.answer])).toEqual([{ choice: 'Red' }, { choice: 'Red' }]);
  });

  it('hands the answer to onParkedAnswer when the session stopped waiting', async () => {
    const ws = seedWorkstream(base);
    const abort = new AbortController();
    const { item, answer } = ask(ws, abort.signal);
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    inbox.answer(item.id, { choice: 'Teal' });
    expect(parked.map((p) => p.target.workstreamId)).toEqual([ws.workstream.id]);
  });

  it('rejects a choice that is not an option, and a second answer', () => {
    const ws = seedWorkstream(base);
    const { item } = ask(ws);
    expect(() => inbox.answer(item.id, { choice: 'Purple' })).toThrow(InvalidError);
    inbox.answer(item.id, { choice: 'Teal' });
    expect(() => inbox.answer(item.id, { choice: 'Teal' })).toThrow(ConflictError);
  });

  it('redelivers an answer stuck in DELIVERING', async () => {
    const ws = seedWorkstream(base);
    // As after a restart: the session that asked is gone, so no live waiter exists.
    const abort = new AbortController();
    const { item, answer } = ask(ws, abort.signal);
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    state.write((ctx) => updateInboxItem(ctx, item.id, { state: 'DELIVERING', answer: { choice: 'Teal' } }));
    expect(inbox.redeliver(item.id).state).toBe('RESOLVED');
    expect(parked).toHaveLength(1);
  });

  it('never leaves an unhandled rejection when nobody awaits a parked answer', async () => {
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);
    try {
      const abort = new AbortController();
      ask(seedWorkstream(base), abort.signal);
      abort.abort();
      await new Promise((r) => setTimeout(r, 20));
      expect(unhandled).toEqual([]);
    } finally {
      process.off('unhandledRejection', onUnhandled);
    }
  });

  it('applies a permission choice even when no session is waiting any more', async () => {
    const ws = seedWorkstream(base);
    const abort = new AbortController();
    const { item, answer } = inbox.ask({
      projectId: ws.project.id, workstreamId: ws.workstream.id, sessionId: mintId('Session'), kind: 'permission', title: 'Allow Bash?', body: 'docker compose up -d',
      options: [{ label: 'allow_once', description: '' }, { label: 'allow_workstream', description: '' }, { label: 'allow_project', description: '' }, { label: 'deny', description: '' }],
      recommendation: null, category: 'environment', urgency: 'normal', detail: { toolName: 'Bash', summary: 'docker compose up -d' }, signal: abort.signal,
    });
    abort.abort();
    await expect(answer).rejects.toBeInstanceOf(ParkedError);
    inbox.answer(item.id, { choice: 'allow_workstream' });
    const rules = listPermissionRules(state.db, ws.project.id, ws.workstream.id);
    expect(rules.map((r) => ({ toolName: r.toolName, pattern: r.pattern, workstreamId: r.workstreamId }))).toEqual([{ toolName: 'Bash', pattern: 'docker compose', workstreamId: ws.workstream.id }]);
    expect(parked.map((p) => p.target.workstreamId)).toEqual([ws.workstream.id]);
  });

  it('records the verdict and rationale when a proposal card is answered', () => {
    const ws = seedWorkstream(base);
    const proposalId = state.write((ctx) => insertProposal(ctx, { projectId: ws.project.id, kind: 'new_task', title: 'Add caching', body: 'b', sourceId: insertSource(ctx, 'agent', {}) }));
    const card = state.write((ctx) =>
      insertInboxItem(ctx, {
        projectId: ws.project.id, kind: 'proposal', title: 'Add caching', body: 'b',
        options: [{ label: 'accept', description: '' }, { label: 'reject', description: '' }],
        recommendation: null, category: 'product', urgency: 'low', detail: { proposalId }, foldKey: null, targets: [],
      }),
    );
    expect(inbox.answer(card.id, { choice: 'reject', note: 'not this milestone' }).state).toBe('RESOLVED');
    expect(getProposal(state.db, proposalId)).toMatchObject({ status: 'rejected', rationale: 'not this milestone' });
  });

  it('cancels a card when its only workstream is cancelled', () => {
    const ws = seedWorkstream(base);
    const { item } = ask(ws);
    inbox.cancelForWorkstream(ws.workstream.id);
    expect(getInboxItem(state.db, item.id).state).toBe('CANCELLED');
  });
});

describe('permission broker', () => {
  function broker(ws: ReturnType<typeof seedWorkstream>, events: string[] = []) {
    const observer: WaitObserver = { onWaitStart: () => events.push('start'), onWaitEnd: () => events.push('end') };
    return createPermissionBroker(
      { state, inbox },
      { projectId: ws.project.id, workstreamId: ws.workstream.id, sessionId: mintId('Session'), observer, signal: new AbortController().signal },
    );
  }
  const request = (toolName: string, input: Record<string, unknown>) => ({ toolName, input, toolUseId: 't1', signal: new AbortController().signal });
  function onlyOpenCard(): InboxItemDto {
    const [card, ...rest] = listInbox(state.db, { states: ['OPEN'] });
    if (!card || rest.length > 0) throw new Error('expected exactly one open card');
    return card;
  }

  it('answers AskUserQuestion through a question card and returns the answers', async () => {
    const ws = seedWorkstream(base);
    const events: string[] = [];
    const pending = broker(ws, events)(
      request('AskUserQuestion', { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] }),
    );
    const card = onlyOpenCard();
    expect(card.kind).toBe('question');
    inbox.answer(card.id, { choice: 'Yes' });
    const decision = await pending;
    expect(decision.behavior === 'allow' && decision.updatedInput?.['answers']).toEqual({ 'Ship it?': 'Yes' });
    expect(events).toEqual(['start', 'end']);
  });

  it('writes a project rule for "always for this project" and skips the card next time', async () => {
    const ws = seedWorkstream(base);
    const decide = broker(ws);
    const pending = decide(request('Bash', { command: 'docker compose up -d' }));
    const card = onlyOpenCard();
    expect(card.kind).toBe('permission');
    inbox.answer(card.id, { choice: 'allow_project' });
    expect(await pending).toEqual({ behavior: 'allow' });
    expect(listPermissionRules(state.db, ws.project.id, ws.workstream.id)).toEqual([expect.objectContaining({ toolName: 'Bash', pattern: 'docker compose', workstreamId: null })]);
    expect(await decide(request('Bash', { command: 'docker compose logs' }))).toEqual({ behavior: 'allow' });
  });

  it('passes the builder note back on deny', async () => {
    const ws = seedWorkstream(base);
    const pending = broker(ws)(request('WebFetch', { url: 'https://example.com' }));
    inbox.answer(onlyOpenCard().id, { choice: 'deny', note: 'use the vendored docs' });
    const decision = await pending;
    expect(decision.behavior === 'deny' && decision.message).toContain('use the vendored docs');
  });

  it('allows the first matching call once when an allow_once arrived after parking', async () => {
    const ws = seedWorkstream(base);
    const decide = createPermissionBroker(
      { state, inbox },
      {
        projectId: ws.project.id, workstreamId: ws.workstream.id, sessionId: mintId('Session'), signal: new AbortController().signal,
        observer: { onWaitStart: () => undefined, onWaitEnd: () => undefined },
        allowOnce: { toolName: 'Bash', summary: 'curl -s https://example.com' },
      },
    );
    expect(await decide(request('Bash', { command: 'curl -s https://example.com' }))).toEqual({ behavior: 'allow' });
    void decide(request('Bash', { command: 'curl -s https://example.com' }));
    expect(onlyOpenCard().kind).toBe('permission');
  });
});
```
The broker opens its card synchronously, before its first `await`, so `onlyOpenCard()` sees it right after the call.

- [ ] **Step 3: Run it to see it fail**

```bash
pnpm vitest run --project daemon inbox
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 4: Implement**

`apps/daemon/src/inbox/service.ts`:
```ts
import { createHash } from 'node:crypto';
import {
  ConflictError,
  DECISION_CATEGORIES,
  InboxAnswer,
  InboxKind,
  InboxState,
  InvalidError,
  PermissionChoice,
  ProposalId,
  QuestionCategory,
  Urgency,
  type InboxItemDto,
  type InboxItemId,
  type InboxOption,
  type InboxTarget,
  type ProjectId,
  type SessionId,
  type WorkstreamId,
} from '@10db/contracts';
import {
  findOpenByFoldKey,
  getInboxItem,
  insertDecision,
  insertInboxItem,
  insertPermissionRule,
  insertSource,
  openItemsForWorkstream,
  resolveProposal,
  updateInboxItem,
  type Json,
  type WriteContext,
} from '@10db/db';
import type { StateStore } from '../events';
import { commandPrefix } from '../permissions';

export class ParkedError extends Error {
  override readonly name = 'ParkedError';
  constructor() {
    super('The session stopped waiting for this answer');
  }
}

export interface AskInput {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly kind: 'question' | 'permission';
  readonly title: string;
  readonly body: string;
  readonly options: readonly InboxOption[];
  readonly recommendation: string | null;
  readonly category: QuestionCategory;
  readonly urgency: Urgency;
  readonly detail: Record<string, Json> | null;
  readonly signal: AbortSignal;
}

export interface InboxService {
  ask(input: AskInput): { item: InboxItemDto; answer: Promise<InboxAnswer> };
  answer(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  flag(input: { projectId: ProjectId; workstreamId: WorkstreamId | null; title: string; body: string; detail?: Record<string, Json>; foldKey?: string }): InboxItemDto;
  cancelForWorkstream(workstreamId: WorkstreamId): void;
  redeliver(id: InboxItemId): InboxItemDto;
}

/** Identical open questions fold into one card (spec §7). */
export function foldKeyFor(input: Pick<AskInput, 'projectId' | 'kind' | 'title' | 'body' | 'options'>): string {
  const norm = (s: string) => s.trim().replace(/\s+/g, ' ').toLowerCase();
  const parts = [input.projectId, input.kind, norm(input.title), norm(input.body), ...input.options.map((o) => norm(o.label))];
  return createHash('sha256').update(parts.join('\u0000')).digest('hex');
}

interface Waiter {
  resolve(answer: InboxAnswer): void;
  reject(error: Error): void;
}

/**
 * A permission card's choice becomes rules in the answer's own transaction, so the choice holds even
 * when the asking session was parked before the builder answered (spec §7).
 */
function applyPermissionChoice(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (typeof toolName !== 'string' || typeof summary !== 'string') return;
  const pattern = toolName === 'Bash' ? commandPrefix(summary) : null;
  if (answer.choice === PermissionChoice.AllowWorkstream) {
    for (const target of item.targets) {
      insertPermissionRule(ctx, { projectId: item.projectId, workstreamId: target.workstreamId, toolName, pattern, sourceInboxId: item.id });
    }
  }
  if (answer.choice === PermissionChoice.AllowProject) {
    insertPermissionRule(ctx, { projectId: item.projectId, workstreamId: null, toolName, pattern, sourceInboxId: item.id });
    const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: item.id });
    insertDecision(ctx, {
      projectId: item.projectId,
      question: `Allow ${toolName}${pattern ? ` (${pattern})` : ''} in this project?`,
      choice: 'Always allow',
      rationale: answer.note ?? 'Allowed for the project from the inbox',
      decidedBy: 'me',
      scope: 'project',
      area: null,
      sourceId,
    });
  }
}

/** Spec §4: a proposal keeps its status and the builder's accept/reject rationale. */
function applyProposalVerdict(ctx: WriteContext, item: InboxItemDto, answer: InboxAnswer): void {
  const proposalId = ProposalId.safeParse(item.detail?.['proposalId']);
  if (!proposalId.success) return;
  resolveProposal(ctx, proposalId.data, { status: answer.choice === 'accept' ? 'accepted' : 'rejected', rationale: answer.note ?? null });
}

export function createInboxService(deps: {
  readonly state: StateStore;
  onParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
}): InboxService {
  const waiters = new Map<InboxItemId, Map<SessionId, Waiter>>();

  function deliver(item: InboxItemDto): InboxItemDto {
    const answer = item.answer;
    if (answer === null) throw new ConflictError(`Inbox item ${item.id} has no answer to deliver`);
    deps.state.write((ctx) => updateInboxItem(ctx, item.id, { state: InboxState.Delivering }));
    const live = waiters.get(item.id);
    waiters.delete(item.id);
    for (const target of item.targets) {
      const waiter = target.sessionId ? live?.get(target.sessionId) : undefined;
      if (waiter) waiter.resolve(answer);
      else deps.onParkedAnswer(target, item);
    }
    return deps.state.write((ctx) => updateInboxItem(ctx, item.id, { state: InboxState.Resolved }));
  }

  return {
    ask(input) {
      const foldKey = foldKeyFor(input);
      const target: InboxTarget = { workstreamId: input.workstreamId, sessionId: input.sessionId };
      const item = deps.state.write((ctx) => {
        const existing = findOpenByFoldKey(ctx.tx, input.projectId, foldKey);
        if (existing) {
          const others = existing.targets.filter((t) => t.workstreamId !== input.workstreamId);
          return updateInboxItem(ctx, existing.id, { targets: [...others, target] });
        }
        return insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: input.kind,
          title: input.title,
          body: input.body,
          options: input.options,
          recommendation: input.recommendation,
          category: input.category,
          urgency: input.urgency,
          detail: input.detail,
          foldKey,
          targets: [target],
        });
      });
      const answer = new Promise<InboxAnswer>((resolve, reject) => {
        const forItem = waiters.get(item.id) ?? new Map<SessionId, Waiter>();
        forItem.set(input.sessionId, { resolve, reject });
        waiters.set(item.id, forItem);
        const onAbort = (): void => {
          forItem.delete(input.sessionId);
          reject(new ParkedError());
        };
        if (input.signal.aborted) onAbort();
        else input.signal.addEventListener('abort', onAbort, { once: true });
      });
      // A caller may never await this (onWaitStart threw, or the session parked); main.ts exits on
      // unhandled rejections, so mark it handled here. Awaiting callers still see the rejection.
      answer.catch(() => undefined);
      return { item, answer };
    },

    answer(id, raw) {
      const answer = InboxAnswer.parse(raw);
      const item = getInboxItem(deps.state.db, id);
      if (item.state !== InboxState.Open) throw new ConflictError(`Inbox item ${id} is already ${item.state}`);
      if (item.options.length > 0 && !item.options.some((o) => o.label === answer.choice)) {
        throw new InvalidError(`Choose one of: ${item.options.map((o) => o.label).join(', ')}`);
      }
      const closesDirectly = item.kind === InboxKind.Flag || item.kind === InboxKind.Proposal || item.kind === InboxKind.Review;
      const answered = deps.state.write((ctx) => {
        const updated = updateInboxItem(ctx, id, { state: closesDirectly ? InboxState.Resolved : InboxState.Answered, answer });
        if (item.kind === InboxKind.Question && DECISION_CATEGORIES.includes(item.category)) {
          const sourceId = insertSource(ctx, 'inbox_answer', { inboxId: id });
          insertDecision(ctx, {
            projectId: item.projectId,
            question: item.title,
            choice: answer.choice,
            rationale: answer.note ?? 'Answered in the inbox',
            decidedBy: 'me',
            scope: 'project',
            area: null,
            sourceId,
          });
        }
        if (item.kind === InboxKind.Permission) applyPermissionChoice(ctx, updated, answer);
        if (item.kind === InboxKind.Proposal) applyProposalVerdict(ctx, updated, answer);
        return updated;
      });
      return closesDirectly ? answered : deliver(answered);
    },

    flag(input) {
      return deps.state.write((ctx) => {
        if (input.foldKey) {
          const existing = findOpenByFoldKey(ctx.tx, input.projectId, input.foldKey);
          if (existing) return existing;
        }
        return insertInboxItem(ctx, {
          projectId: input.projectId,
          kind: InboxKind.Flag,
          title: input.title,
          body: input.body,
          options: [],
          recommendation: null,
          category: QuestionCategory.Other,
          urgency: Urgency.High,
          detail: input.detail ?? null,
          foldKey: input.foldKey ?? null,
          targets: input.workstreamId ? [{ workstreamId: input.workstreamId, sessionId: null }] : [],
        });
      });
    },

    cancelForWorkstream(workstreamId) {
      deps.state.write((ctx) => {
        for (const item of openItemsForWorkstream(ctx.tx, workstreamId)) {
          if (item.state !== InboxState.Open) continue;
          const targets = item.targets.filter((t) => t.workstreamId !== workstreamId);
          updateInboxItem(ctx, item.id, targets.length === 0 ? { state: InboxState.Cancelled, targets } : { targets });
        }
      });
    },

    redeliver(id) {
      const item = getInboxItem(deps.state.db, id);
      return item.state === InboxState.Answered || item.state === InboxState.Delivering ? deliver(item) : item;
    },
  };
}
```

`apps/daemon/src/inbox/permission-broker.ts`:
```ts
import { PermissionChoice, QuestionCategory, Urgency, type InboxAnswer, type InboxItemDto, type ProjectId, type SessionId, type WorkstreamId } from '@10db/contracts';
import { listPermissionRules } from '@10db/db';
import { z } from 'zod';
import type { StateStore } from '../events';
import { matchPermissionRule } from '../permissions';
import type { ToolDecision, ToolRequest } from '../sessions';
import { ParkedError, type InboxService } from './service';

export interface WaitObserver {
  onWaitStart(item: InboxItemDto): void;
  onWaitEnd(item: InboxItemDto): void;
}

export interface BrokerContext {
  readonly projectId: ProjectId;
  readonly workstreamId: WorkstreamId;
  readonly sessionId: SessionId;
  readonly observer: WaitObserver;
  readonly signal: AbortSignal;
  /** An `allow_once` answered after the workstream was parked: the first identical call is allowed. */
  readonly allowOnce?: { readonly toolName: string; readonly summary: string } | null;
}

const ALLOWING: readonly string[] = [PermissionChoice.AllowOnce, PermissionChoice.AllowWorkstream, PermissionChoice.AllowProject];

const AskUserQuestionInput = z.looseObject({
  questions: z
    .array(
      z.looseObject({
        question: z.string().min(1),
        header: z.string().default(''),
        options: z.array(z.looseObject({ label: z.string().min(1), description: z.string().default('') })).min(2).max(4),
      }),
    )
    .min(1)
    .max(4),
});

const PERMISSION_OPTIONS = [
  { label: PermissionChoice.AllowOnce, description: 'Allow this call once' },
  { label: PermissionChoice.AllowWorkstream, description: 'Allow for the rest of this workstream' },
  { label: PermissionChoice.AllowProject, description: 'Always allow in this project (records a decision)' },
  { label: PermissionChoice.Deny, description: 'Deny; your note is passed to the agent' },
];

function summarize(req: ToolRequest): string {
  const command = req.input['command'];
  if (req.toolName === 'Bash' && typeof command === 'string') return command;
  return JSON.stringify(req.input).slice(0, 2000);
}

/** Decides every canUseTool call: rules first, then a card for the builder. Never an LLM (spec §7). */
export function createPermissionBroker(deps: { readonly state: StateStore; readonly inbox: InboxService }, ctx: BrokerContext): (req: ToolRequest) => Promise<ToolDecision> {
  let allowOnce = ctx.allowOnce ?? null;

  async function wait(item: InboxItemDto, answer: Promise<InboxAnswer>): Promise<InboxAnswer> {
    ctx.observer.onWaitStart(item);
    const result = await answer;
    ctx.observer.onWaitEnd(item);
    return result;
  }

  async function askQuestions(req: ToolRequest): Promise<ToolDecision> {
    const parsed = AskUserQuestionInput.safeParse(req.input);
    if (!parsed.success) return { behavior: 'deny', message: 'AskUserQuestion input was not understood; use ask_human instead.' };
    const answers: Record<string, string> = {};
    for (const q of parsed.data.questions) {
      const { item, answer } = deps.inbox.ask({
        projectId: ctx.projectId,
        workstreamId: ctx.workstreamId,
        sessionId: ctx.sessionId,
        kind: 'question',
        title: q.question,
        body: q.header,
        options: q.options.map((o) => ({ label: o.label, description: o.description })),
        recommendation: null,
        category: QuestionCategory.Other,
        urgency: Urgency.Normal,
        detail: null,
        signal: ctx.signal,
      });
      const result = await wait(item, answer);
      answers[q.question] = result.note ? `${result.choice} (${result.note})` : result.choice;
    }
    return { behavior: 'allow', updatedInput: { ...req.input, answers } };
  }

  async function askPermission(req: ToolRequest): Promise<ToolDecision> {
    const rules = listPermissionRules(deps.state.db, ctx.projectId, ctx.workstreamId);
    if (matchPermissionRule(req, rules)) return { behavior: 'allow' };
    const summary = summarize(req);
    if (allowOnce?.toolName === req.toolName && allowOnce.summary === summary) {
      allowOnce = null;
      return { behavior: 'allow' };
    }
    const { item, answer } = deps.inbox.ask({
      projectId: ctx.projectId,
      workstreamId: ctx.workstreamId,
      sessionId: ctx.sessionId,
      kind: 'permission',
      title: `Allow ${req.toolName}?`,
      body: summary,
      options: PERMISSION_OPTIONS,
      recommendation: null,
      category: QuestionCategory.Environment,
      urgency: Urgency.Normal,
      detail: { toolName: req.toolName, summary },
      signal: ctx.signal,
    });
    const result = await wait(item, answer);
    // inbox.answer has already written any rule this choice implies, in the answer's transaction.
    if (ALLOWING.includes(result.choice)) return { behavior: 'allow' };
    return { behavior: 'deny', message: `The builder denied ${req.toolName}.${result.note ? ` Note: ${result.note}` : ''}` };
  }

  return async (req) => {
    try {
      return req.toolName === 'AskUserQuestion' ? await askQuestions(req) : await askPermission(req);
    } catch (error) {
      if (error instanceof ParkedError) return { behavior: 'deny', message: 'Parked until the builder answers.', interrupt: true };
      throw error;
    }
  };
}
```

`apps/daemon/src/inbox/index.ts`:
```ts
export { createPermissionBroker, type BrokerContext, type WaitObserver } from './permission-broker';
export { createInboxService, foldKeyFor, ParkedError, type AskInput, type InboxService } from './service';
```

- [ ] **Step 5: Run, check, commit**

```bash
pnpm vitest run --project daemon inbox
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/inbox apps/daemon/test/fixtures.ts && git commit -m 'feat(daemon): add inbox service with folding and parked delivery, and the permission broker'
```
Expected: PASS.

---

### Task 13: Briefing: prompts, handoff rendering and the context pack

**Files:**
- Create: `apps/daemon/src/briefing/prompts.ts`, `briefing/context-pack.ts`, `briefing/index.ts`
- Test: `apps/daemon/src/briefing/briefing.test.ts`

**Interfaces:**
- Consumes: `getTask`, `activeClaims`, `latestHandoff`, `getHandoff`, `getInboxItem`, `searchDecisions` and `listRecentDecisions` from `@10db/db`.
- Produces, from `briefing/index.ts`:
  - **Prompt input:** `interface PromptInput { task: Pick<TaskDto, 'title' | 'description' | 'acceptanceCriteria'>; claims: readonly { kind; name }[]; action: NextAction; handoff: HandoffDto | null; answer: { question; answer; note: string | null } | null; evidence: EvidenceDto | null; recovery: { reason: string; lastOp: string | null } | null }`
  - **Prompt text:**
    - `buildSessionPrompt(input: PromptInput): string`. It always contains the line `Task: <title>`, then a newline.
    - `renderHandoff(handoff: HandoffDto): string`
  - **Nudges:** `HANDOFF_NUDGE` (contains `write_handoff`), `HANDOFF_FIRM_NUDGE` and `compactionReinjection(pack: ContextPack): string` (contains `context pack`).
  - **Context pack:** `buildContextPack(db, workstream: WorkstreamDto, budgetChars?: number): ContextPack`. It is deterministic and fills a character budget (4,000 by default). It reports `budgetUsed` as estimated tokens (chars / 4), reports `droppedCount`, and sets `empty: true` when no decision was included.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/briefing/briefing.test.ts`:
```ts
import type { HandoffDto } from '@10db/contracts';
import { mintId } from '@10db/contracts';
import { createTestStore, insertDecision, insertSource } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { buildContextPack, buildSessionPrompt, HANDOFF_NUDGE, renderHandoff } from './index';

const task = { title: 'Add the badge', description: 'A status badge.', acceptanceCriteria: ['Badge renders', 'Has a test'] };
const handoff: HandoffDto = {
  id: mintId('Handoff'),
  workstreamId: mintId('Workstream'),
  sessionId: mintId('Session'),
  content: {
    objective: { task: 'Add the badge', acceptanceCriteria: ['Badge renders'], nonGoals: ['No animation'] },
    progress: { done: ['Component skeleton'], notDone: ['Tests'], nextAction: 'Write the render test' },
    codeState: { uncommittedSummary: 'none' },
    reasoning: { decisions: ['Use Mantine Badge'], tradeOffs: [], rejected: ['Custom CSS'] },
    validation: { checks: [{ command: 'pnpm vitest', result: 'pass' }], environmentProblems: [] },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  },
  gitHead: 'abc123',
  gitChangedFiles: ['src/ui/badge.tsx'],
  gitCommits: ['abc123'],
  createdAt: '2026-10-13T12:00:00.000Z',
};
const base = { task, claims: [{ kind: 'area' as const, name: 'ui' }], handoff: null, answer: null, evidence: null, recovery: null };

describe('buildSessionPrompt', () => {
  it('names the task on its own line, lists criteria and claims, and states the rules', () => {
    const prompt = buildSessionPrompt({ ...base, action: { kind: 'start' } });
    expect(prompt).toContain('Task: Add the badge\n');
    expect(prompt).toContain('- Badge renders');
    expect(prompt).toContain('area ui');
    expect(prompt).toContain('commit tool');
  });

  it('carries the handoff when continuing', () => {
    const prompt = buildSessionPrompt({ ...base, handoff, action: { kind: 'continue_from_handoff', handoffId: handoff.id } });
    expect(prompt).toContain('Write the render test');
    expect(prompt).toContain('src/ui/badge.tsx');
  });

  it('carries the answer, the gate output or the recovery note', () => {
    expect(buildSessionPrompt({ ...base, answer: { question: 'Color?', answer: 'Teal', note: null }, action: { kind: 'answer', inboxId: mintId('InboxItem'), providerSessionId: null } })).toContain('Answer: Teal');
    const evidence = { id: mintId('Evidence'), workstreamId: handoff.workstreamId, kind: 'gate' as const, command: 'make gate', exitCode: 2, summary: 'FAIL badge.test.ts', logPath: null, commitShas: [], createdAt: handoff.createdAt };
    expect(buildSessionPrompt({ ...base, evidence, action: { kind: 'fix', evidenceId: evidence.id } })).toContain('FAIL badge.test.ts');
    expect(buildSessionPrompt({ ...base, recovery: { reason: 'daemon restarted', lastOp: 'op-commit-7' }, action: { kind: 'resume', providerSessionId: 'p', reason: 'daemon restarted' } })).toContain('op-commit-7');
  });

  it('asks for write_handoff in the nudge', () => {
    expect(HANDOFF_NUDGE).toContain('write_handoff');
    expect(renderHandoff(handoff)).toContain('Next action: Write the render test');
  });
});

describe('buildContextPack', () => {
  let close: () => void;
  let store: ReturnType<typeof createTestStore>['store'];
  beforeEach(() => ({ store, close } = createTestStore()));
  afterEach(() => { close(); });

  it('says so when there is no knowledge', () => {
    const { workstream } = seedWorkstream(store);
    const pack = buildContextPack(store.db, workstream);
    expect(pack.knowledge).toEqual({ decisions: [], budgetUsed: 0, droppedCount: 0, empty: true });
    expect(pack.task.title).toBe('Alpha');
  });

  it('fills the budget with relevant decisions and counts what it dropped', () => {
    const { project, workstream } = seedWorkstream(store, { title: 'Alpha badge' });
    store.write((ctx) => {
      for (let i = 0; i < 5; i += 1) {
        const sourceId = insertSource(ctx, 'builder', {});
        insertDecision(ctx, { projectId: project.id, question: `Badge question ${String(i)}`, choice: 'x'.repeat(300), rationale: 'r', decidedBy: 'me', scope: 'project', area: null, sourceId });
      }
    });
    const pack = buildContextPack(store.db, workstream, 700);
    expect(pack.knowledge.decisions.length).toBeGreaterThan(0);
    expect(pack.knowledge.decisions.length + pack.knowledge.droppedCount).toBe(5);
    expect(pack.knowledge.empty).toBe(false);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon briefing
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/briefing/prompts.ts`:
```ts
import type { ClaimKind, ContextPack, EvidenceDto, HandoffDto, NextAction, TaskDto } from '@10db/contracts';

export interface PromptInput {
  readonly task: Pick<TaskDto, 'title' | 'description' | 'acceptanceCriteria'>;
  readonly claims: readonly { readonly kind: ClaimKind; readonly name: string }[];
  readonly action: NextAction;
  readonly handoff: HandoffDto | null;
  readonly answer: { readonly question: string; readonly answer: string; readonly note: string | null } | null;
  readonly evidence: EvidenceDto | null;
  readonly recovery: { readonly reason: string; readonly lastOp: string | null } | null;
}

export const HANDOFF_NUDGE =
  '10db: your context is filling up. Finish the step you are on, commit it, then call the write_handoff tool with the six-part handoff and end your turn. Do not start new work.';

export const HANDOFF_FIRM_NUDGE = '10db: your context is almost full. Call write_handoff now and end your turn.';

const RULES = [
  'Edit only files inside your claims. For anything else, call the request_claim tool first.',
  'Commit only through the 10db commit tool, naming every path. Never run git commit, add, checkout, reset, stash or push --force.',
  'When a decision is not yours to make, ask with ask_human (or your question tool). Record routine engineering decisions with record_decision.',
  'If you depart from the plan or a principle, call report_deviation with your reason.',
  'When the acceptance criteria are met and committed, end your turn. 10db runs the gate itself.',
  'If 10db asks you to hand off, finish your current step, call write_handoff, and end your turn.',
];

const bullets = (lines: readonly string[]) => (lines.length === 0 ? '- (none)' : lines.map((l) => `- ${l}`).join('\n'));

export function renderHandoff(h: HandoffDto): string {
  const c = h.content;
  return [
    `Objective: ${c.objective.task}`,
    `Non-goals:\n${bullets(c.objective.nonGoals)}`,
    `Done:\n${bullets(c.progress.done)}`,
    `Not done:\n${bullets(c.progress.notDone)}`,
    `Next action: ${c.progress.nextAction}`,
    `Changed files (from git): ${h.gitChangedFiles.join(', ') || '(none)'}`,
    `Commits (from git): ${h.gitCommits.join(', ') || '(none)'}`,
    `Uncommitted: ${c.codeState.uncommittedSummary || '(none)'}`,
    `Decisions:\n${bullets(c.reasoning.decisions)}`,
    `Trade-offs:\n${bullets(c.reasoning.tradeOffs)}`,
    `Rejected approaches:\n${bullets(c.reasoning.rejected)}`,
    `Checks:\n${bullets(c.validation.checks.map((k) => `${k.command}: ${k.result}`))}`,
    `Environment problems:\n${bullets(c.validation.environmentProblems)}`,
    `Blockers:\n${bullets(c.continuity.blockers)}`,
    `Pending questions:\n${bullets(c.continuity.pendingQuestions)}`,
    `Background jobs:\n${bullets(c.continuity.backgroundJobs)}`,
    `Notes: ${c.continuity.notes || '(none)'}`,
  ].join('\n');
}

function actionSection(input: PromptInput): string {
  switch (input.action.kind) {
    case 'start':
      return 'Begin.';
    case 'continue_from_handoff':
      return input.handoff
        ? `Continue from the handoff below. Do not redo finished work.\n\nHandoff:\n${renderHandoff(input.handoff)}`
        : 'Continue the task; the previous session left no handoff, so inspect git status first.';
    case 'resume':
      return `10db resumed this session after an interruption (${input.recovery?.reason ?? input.action.reason}). Inspect git status before continuing. Last acknowledged 10db operation: ${input.recovery?.lastOp ?? 'none'}. If a tool call may not have completed, retry it with the same opId.`;
    case 'answer':
      return input.answer
        ? `The builder answered your question.\nQuestion: ${input.answer.question}\nAnswer: ${input.answer.answer}${input.answer.note ? `\nNote: ${input.answer.note}` : ''}\nContinue.`
        : 'The builder answered your question; continue.';
    case 'fix':
      return input.evidence
        ? `The gate failed (exit ${String(input.evidence.exitCode)} from \`${input.evidence.command}\`). Fix the cause, commit, and end your turn.\n\nGate output (end):\n\`\`\`\n${input.evidence.summary}\n\`\`\``
        : 'The gate failed. Run it, fix the cause, commit, and end your turn.';
    case 'verify':
      return 'Verify the work against the acceptance criteria, commit anything outstanding, and end your turn.';
  }
}

export function buildSessionPrompt(input: PromptInput): string {
  const claims = input.claims.map((c) => `${c.kind} ${c.name}`).join(', ') || '(none)';
  return [
    'You are working on one task in a shared repository, managed by 10db.',
    '',
    `Task: ${input.task.title}`,
    input.task.description,
    '',
    'Acceptance criteria:',
    bullets(input.task.acceptanceCriteria),
    '',
    `Your claims: ${claims}.`,
    '',
    'Rules:',
    bullets(RULES),
    '',
    actionSection(input),
  ].join('\n');
}

export function compactionReinjection(pack: ContextPack): string {
  return `10db: your conversation was compacted. Here is your context pack again:\n${JSON.stringify(pack, null, 2)}`;
}
```

`apps/daemon/src/briefing/context-pack.ts`:
```ts
import type { ContextPack, KnowledgeHit, WorkstreamDto } from '@10db/contracts';
import { activeClaims, getHandoff, getInboxItem, getTask, latestHandoff, listRecentDecisions, searchDecisions, type DbReader } from '@10db/db';

const DEFAULT_BUDGET_CHARS = 4000;

const sizeOf = (hit: KnowledgeHit) => hit.question.length + hit.choice.length + hit.rationale.length + 16;

/** Deterministic, budgeted context for a session (spec §9). M3 adds principles and facts. */
export function buildContextPack(db: DbReader, workstream: WorkstreamDto, budgetChars: number = DEFAULT_BUDGET_CHARS): ContextPack {
  const task = getTask(db, workstream.taskId);
  const action = workstream.nextAction;
  const handoff = action.kind === 'continue_from_handoff' ? getHandoff(db, action.handoffId) : latestHandoff(db, workstream.id);
  const answered = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;

  const relevant = searchDecisions(db, workstream.projectId, `${task.title} ${task.description}`, 20);
  const candidates = relevant.length > 0 ? relevant : listRecentDecisions(db, workstream.projectId, 5);
  const decisions: KnowledgeHit[] = [];
  let used = 0;
  for (const hit of candidates) {
    if (used + sizeOf(hit) > budgetChars) continue;
    decisions.push(hit);
    used += sizeOf(hit);
  }

  return {
    task: { title: task.title, description: task.description, acceptanceCriteria: task.acceptanceCriteria },
    claims: activeClaims(db, workstream.id).map((c) => ({ kind: c.kind, name: c.name })),
    handoff,
    pendingAnswer: answered?.answer ? { question: answered.title, answer: answered.answer.choice, note: answered.answer.note ?? null } : null,
    knowledge: { decisions, budgetUsed: Math.ceil(used / 4), droppedCount: candidates.length - decisions.length, empty: decisions.length === 0 },
  };
}
```

`apps/daemon/src/briefing/index.ts`:
```ts
export { buildContextPack } from './context-pack';
export { buildSessionPrompt, compactionReinjection, HANDOFF_FIRM_NUDGE, HANDOFF_NUDGE, renderHandoff, type PromptInput } from './prompts';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon briefing
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/briefing && git commit -m 'feat(daemon): add session prompts, handoff rendering and the budgeted context pack'
```

---

### Task 14: MCP server and the ten tools

**Files:**
- Create: `apps/daemon/src/mcp/tokens.ts`, `mcp/tools.ts`, `mcp/server.ts`, `mcp/index.ts`
- Test: `apps/daemon/src/mcp/mcp.test.ts`

**Interfaces:**
- Consumes:
  - From the repositories: `getLiveSessionByTokenHash`, `getWorkstream`, `getWorkstreamRow`, `getProject`, `getTask`, `findToolOp`, `insertToolOp`, `insertSource`, `insertDecision`, `insertDeviation`, `insertProposal`, `insertInboxItem`, `insertEvidence`, `insertHandoff`, `acquireClaims` and `searchDecisions`.
  - From daemon modules: `buildContextPack`, `judgeToolUse`, `Git`, `InboxService`, `WaitObserver` and `StateStore`.
- Produces, from `mcp/index.ts`:
  - **Tokens:** `mintSessionToken(): { token: string; hash: string }` and `hashToken(token): string`.
  - **`interface McpDeps`**:
    - Shared services: `state`, `inbox`, `git`.
    - Live-session hooks: `waitObserverFor(sessionId): WaitObserver | undefined` and `sessionSignal(sessionId): AbortSignal | undefined`.
  - **Handler:** `createMcpHandler(deps): (req: Request) => Promise<Response>`.
    - It is stateless streamable HTTP. It responds 401 unless `Authorization: Bearer <token>` matches a live session.
    - Every mutating tool is idempotent by `opId` within the workstream. Reusing an `opId` for a different tool is an error.
    - Tool errors return `isError: true` with a message the agent can act on.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/mcp/mcp.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import { writeFileSync, mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve } from '@hono/node-server';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import type { Transport } from '@modelcontextprotocol/sdk/shared/transport.js';
import { acquireClaims, createTestStore, endSession, insertSession, listInbox, patchWorkstream, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, seedWorkstream } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { createMcpHandler, mintSessionToken } from './index';

let repo: { path: string; cleanup(): void };
let close: () => void;
let base: Store;
let state: StateStore;
let inbox: InboxService;
let server: ReturnType<typeof serve>;
let url: string;
const git = createGit();

beforeEach(async () => {
  repo = await createTempRepo();
  const test = createTestStore();
  close = test.close;
  base = test.store;
  state = createStateStore(test.store, createEventBus());
  inbox = createInboxService({ state, onParkedAnswer: () => undefined });
  const handler = createMcpHandler({ state, inbox, git, waitObserverFor: () => undefined, sessionSignal: () => undefined });
  server = serve({ fetch: handler, hostname: '127.0.0.1', port: 0 });
  await new Promise((r) => server.once('listening', r));
  url = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
});
afterEach(() => {
  server.close();
  close();
  repo.cleanup();
});

async function seedSession(areas = ['api']) {
  const seeded = seedWorkstream(base, { repoPath: repo.path, areas });
  const { token, hash } = mintSessionToken();
  const head = execFileSync('git', ['-C', repo.path, 'rev-parse', 'HEAD']).toString().trim();
  const session = state.write((ctx) => {
    acquireClaims(ctx, { projectId: seeded.project.id, workstreamId: seeded.workstream.id, requests: areas.map((name) => ({ kind: 'area' as const, name })), leaseExpiresAt: ctx.now });
    patchWorkstream(ctx, seeded.workstream.id, null, { baseHead: head });
    return insertSession(ctx, { workstreamId: seeded.workstream.id, provider: 'claude', model: 'sonnet', effort: 'medium', mode: 'managed', mcpTokenHash: hash });
  });
  const client = new Client({ name: 'test', version: '0' });
  const transport = new StreamableHTTPClientTransport(new URL(url), { requestInit: { headers: { Authorization: `Bearer ${token}` } } });
  // `sessionId?: string` on the SDK class doesn't fit `Transport` under exactOptionalPropertyTypes.
  await client.connect(transport as Transport);
  const call = async (name: string, args: Record<string, unknown>) => {
    const result = await client.callTool({ name, arguments: args });
    const text = (result.content as { type: string; text: string }[]).map((c) => c.text).join('');
    return { isError: result.isError === true, text, json: result.isError ? null : (JSON.parse(text) as Record<string, unknown>) };
  };
  return { ...seeded, session, token, client, call };
}

const writeRepoFile = (rel: string, text: string) => {
  mkdirSync(join(repo.path, rel, '..'), { recursive: true });
  writeFileSync(join(repo.path, rel), text);
};
const commitCount = () => Number(execFileSync('git', ['-C', repo.path, 'rev-list', '--count', 'HEAD']).toString().trim());

describe('MCP auth', () => {
  it('rejects a missing token and an ended session', async () => {
    const res = await fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(res.status).toBe(401);
    const s = await seedSession();
    state.write((ctx) => { endSession(ctx, s.session.id, 'test'); });
    const after = await fetch(url, { method: 'POST', headers: { authorization: `Bearer ${s.token}`, 'content-type': 'application/json' }, body: '{}' });
    expect(after.status).toBe(401);
  });
});

describe('MCP tools', () => {
  it('lists exactly the ten tools', async () => {
    const s = await seedSession();
    const { tools } = await s.client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      'ask_human', 'commit', 'find_knowledge', 'get_context', 'propose', 'record_decision', 'record_evidence', 'report_deviation', 'request_claim', 'write_handoff',
    ]);
  });

  it('returns the context pack for the calling session', async () => {
    const s = await seedSession();
    const { json } = await s.call('get_context', {});
    expect(json).toMatchObject({ task: { title: 'Alpha' }, claims: [{ kind: 'area', name: 'api' }] });
  });

  it('reads a recorded decision back through find_knowledge', async () => {
    const s = await seedSession();
    await s.call('record_decision', { opId: 'op-decision-01', question: 'Which date library?', choice: 'dayjs', rationale: 'small', scope: 'project' });
    const { json } = await s.call('find_knowledge', { query: 'date library' });
    expect(json).toMatchObject({ empty: false, results: [{ choice: 'dayjs' }] });
  });

  it('commits inside claims once per opId', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/a.ts', 'export {}\n');
    const first = await s.call('commit', { opId: 'op-commit-001', paths: ['src/api/a.ts'], message: 'Add a' });
    const retry = await s.call('commit', { opId: 'op-commit-001', paths: ['src/api/a.ts'], message: 'Add a' });
    expect(first.json).toMatchObject({ alreadyCommitted: false });
    expect(retry.json).toEqual(first.json);
    expect(commitCount()).toBe(2);
  });

  it('recovers a commit made before a crash that never recorded its op', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/b.ts', 'export {}\n');
    const direct = await git.commit({ repo: repo.path, paths: ['src/api/b.ts'], message: 'Add b', opId: 'op-crashed-01' });
    const viaTool = await s.call('commit', { opId: 'op-crashed-01', paths: ['src/api/b.ts'], message: 'Add b' });
    expect(viaTool.json).toEqual({ sha: direct.sha, alreadyCommitted: true });
    expect(commitCount()).toBe(2);
  });

  it('refuses to commit a path outside the claims', async () => {
    const s = await seedSession();
    writeRepoFile('src/ui/x.ts', 'export {}\n');
    const result = await s.call('commit', { opId: 'op-commit-ui1', paths: ['src/ui/x.ts'], message: 'x' });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('request_claim');
  });

  it('records a handoff with git-derived facts', async () => {
    const s = await seedSession();
    writeRepoFile('src/api/c.ts', 'export {}\n');
    await s.call('commit', { opId: 'op-commit-c01', paths: ['src/api/c.ts'], message: 'Add c' });
    const handoff = {
      objective: { task: 'Alpha', acceptanceCriteria: ['it works'], nonGoals: [] },
      progress: { done: ['c'], notDone: ['d'], nextAction: 'Write d' },
      codeState: { uncommittedSummary: '' },
      reasoning: { decisions: [], tradeOffs: [], rejected: [] },
      validation: { checks: [], environmentProblems: [] },
      continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
    };
    const { json } = await s.call('write_handoff', { opId: 'op-handoff-01', ...handoff });
    expect(String(json?.['instruction'])).toContain('End your turn');
    const ctx = await s.call('get_context', {});
    expect(ctx.json).toMatchObject({ handoff: { gitChangedFiles: ['src/api/c.ts'], content: { progress: { nextAction: 'Write d' } } } });
  });

  it('grants a free claim', async () => {
    const a = await seedSession(['api']);
    const granted = await a.call('request_claim', { opId: 'op-claim-ui-1', kind: 'area', name: 'ui', reason: 'shared badge' });
    expect(granted.json).toMatchObject({ granted: true });
  });

  it('raises a flag card when another workstream holds the claim', async () => {
    const a = await seedSession(['api']);
    const other = seedWorkstream(base, { project: a.project, title: 'Beta', areas: ['ui'] });
    state.write((ctx) =>
      acquireClaims(ctx, { projectId: a.project.id, workstreamId: other.workstream.id, requests: [{ kind: 'area', name: 'ui' }], leaseExpiresAt: ctx.now }),
    );
    const refused = await a.call('request_claim', { opId: 'op-claim-ui-3', kind: 'area', name: 'ui', reason: 'need the badge' });
    expect(refused.json).toMatchObject({ granted: false, heldBy: other.workstream.id });
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('rejects an opId reused for a different tool', async () => {
    const s = await seedSession();
    await s.call('record_decision', { opId: 'op-shared-001', question: 'q?', choice: 'c', rationale: 'r', scope: 'project' });
    const reused = await s.call('report_deviation', { opId: 'op-shared-001', cause: 'x', severity: 'info', reason: 'y' });
    expect(reused.isError).toBe(true);
  });

  it('waits on ask_human until the builder answers', async () => {
    const s = await seedSession();
    const pending = s.call('ask_human', { opId: 'op-ask-00001', category: 'design', question: 'Teal or red?', options: [{ label: 'Teal', description: '' }, { label: 'Red', description: '' }] });
    let card;
    for (let i = 0; i < 50 && !card; i += 1) {
      await new Promise((r) => setTimeout(r, 20));
      card = listInbox(state.db, { states: ['OPEN'] })[0];
    }
    if (!card) throw new Error('no card opened');
    inbox.answer(card.id, { choice: 'Teal' });
    expect((await pending).json).toMatchObject({ answer: 'Teal' });
  });

  it('tells a parked ask_human not to ask again', async () => {
    const abort = new AbortController();
    const parkedHandler = createMcpHandler({ state, inbox, git, waitObserverFor: () => undefined, sessionSignal: () => abort.signal });
    const parkedServer = serve({ fetch: parkedHandler, hostname: '127.0.0.1', port: 0 });
    await new Promise((r) => parkedServer.once('listening', r));
    try {
      url = `http://127.0.0.1:${String((parkedServer.address() as AddressInfo).port)}/mcp`;
      const s = await seedSession();
      const pending = s.call('ask_human', { opId: 'op-ask-parked', category: 'design', question: 'Round or square?', options: [{ label: 'Round', description: '' }, { label: 'Square', description: '' }] });
      for (let i = 0; i < 50 && listInbox(state.db, { states: ['OPEN'] }).length === 0; i += 1) await new Promise((r) => setTimeout(r, 20));
      abort.abort();
      const result = await pending;
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Do not ask again');
    } finally {
      parkedServer.close();
    }
  });
});
```
`ask_human` really waits on a card, so its test polls for a database condition with a deadline. That fits the testing rules, because it isn't a fixed sleep.

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon mcp
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/mcp/tokens.ts`:
```ts
import { createHash, randomBytes } from 'node:crypto';

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A per-session bearer token; only its hash is stored. */
export function mintSessionToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('base64url');
  return { token, hash: hashToken(token) };
}
```

`apps/daemon/src/mcp/tools.ts`:
```ts
import {
  ClaimKind,
  InvalidError,
  McpToolName,
  McpToolOutputs,
  QuestionCategory,
  Urgency,
  type McpToolInputs,
  type SessionId,
} from '@10db/contracts';
import {
  acquireClaims,
  activeClaims,
  findToolOp,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  insertDecision,
  insertDeviation,
  insertEvidence,
  insertHandoff,
  insertInboxItem,
  insertProposal,
  insertSource,
  insertToolOp,
  searchDecisions,
  type Json,
} from '@10db/db';
import type { z } from 'zod';
import { buildContextPack } from '../briefing';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse } from '../guard';
import type { InboxService, WaitObserver } from '../inbox';

export interface McpDeps {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  waitObserverFor(sessionId: SessionId): WaitObserver | undefined;
  sessionSignal(sessionId: SessionId): AbortSignal | undefined;
}

type In<K extends McpToolName> = z.output<(typeof McpToolInputs)[K]>;
type Out<K extends McpToolName> = z.output<(typeof McpToolOutputs)[K]>;
export type ToolHandlers = { [K in McpToolName]: (input: In<K>) => Promise<Out<K>> };

export const TOOL_DESCRIPTIONS: Record<McpToolName, string> = {
  get_context: 'Your context pack: the task, acceptance criteria, your claims, the latest handoff, any answer waiting for you, and relevant decisions.',
  find_knowledge: 'Search recorded decisions in scope for this project. Returns an explicit empty result when nothing matches.',
  ask_human: 'Ask the builder a structured question and wait for the answer. Use for decisions outside routine engineering.',
  record_decision: 'Record a routine engineering decision you made within your authority, with its rationale.',
  propose: 'Propose a new task, a task change, or a principle. Proposals go to the builder; nothing changes until accepted.',
  report_deviation: 'Report a departure from the plan or a principle, with your signed reason.',
  request_claim: 'Ask for an additional area or hazard claim before editing files in it.',
  commit: 'Commit the named paths (and only those) under the repository lock. Returns the commit SHA. Retry with the same opId if unsure it completed.',
  record_evidence: 'Attach verification output: a command you ran, its exit code and a summary.',
  write_handoff: 'Write the six-part handoff when 10db asks you to. 10db adds the git facts. End your turn after calling it.',
};

export function createToolHandlers(deps: McpDeps, sessionId: SessionId, workstreamId: Parameters<typeof getWorkstream>[1]): ToolHandlers {
  const db = deps.state.db;
  const context = () => {
    const workstream = getWorkstream(db, workstreamId);
    return { workstream, project: getProject(db, workstream.projectId), task: getTask(db, workstream.taskId) };
  };

  /** Returns the recorded result for a repeated opId; throws if the opId belonged to another tool. */
  function prior(opId: string, tool: McpToolName): Json | undefined {
    const op = findToolOp(db, workstreamId, opId);
    if (op && op.tool !== tool) throw new InvalidError(`opId ${opId} was already used for ${op.tool}; use a new opId`);
    return op?.result;
  }

  const record = <K extends McpToolName>(tool: K, opId: string, result: Out<K>, ctx: Parameters<typeof insertToolOp>[0]): Out<K> => {
    insertToolOp(ctx, { workstreamId, sessionId, opId, tool, result });
    return result;
  };

  return {
    get_context: () => Promise.resolve(buildContextPack(db, getWorkstream(db, workstreamId))),

    find_knowledge: ({ query, limit }) => {
      const results = searchDecisions(db, context().project.id, query, limit);
      return Promise.resolve({ results, empty: results.length === 0 });
    },

    ask_human: async (input) => {
      const done = prior(input.opId, McpToolName.AskHuman);
      if (done !== undefined) return McpToolOutputs.ask_human.parse(done);
      const { project } = context();
      const signal = deps.sessionSignal(sessionId) ?? new AbortController().signal;
      const { item, answer } = deps.inbox.ask({
        projectId: project.id,
        workstreamId,
        sessionId,
        kind: 'question',
        title: input.question,
        body: [input.consequences, input.affectedScope ? `Affects: ${input.affectedScope}` : undefined].filter(Boolean).join('\n'),
        options: input.options,
        recommendation: input.recommendation ?? null,
        category: input.category,
        urgency: input.urgency,
        detail: null,
        signal,
      });
      const observer = deps.waitObserverFor(sessionId);
      observer?.onWaitStart(item);
      const result = await answer;
      observer?.onWaitEnd(item);
      return deps.state.write((ctx) => record('ask_human', input.opId, { inboxId: item.id, answer: result.choice, note: result.note ?? null }, ctx));
    },

    record_decision: (input) => {
      const done = prior(input.opId, McpToolName.RecordDecision);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.record_decision.parse(done));
      const { project } = context();
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const decisionId = insertDecision(ctx, { projectId: project.id, question: input.question, choice: input.choice, rationale: input.rationale, decidedBy: `agent:${sessionId}`, scope: input.scope, area: input.area ?? null, sourceId });
          return record('record_decision', input.opId, { decisionId }, ctx);
        }),
      );
    },

    propose: (input) => {
      const done = prior(input.opId, McpToolName.Propose);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.propose.parse(done));
      const { project } = context();
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const proposalId = insertProposal(ctx, { projectId: project.id, kind: input.kind, title: input.title, body: input.body, sourceId });
          insertInboxItem(ctx, {
            projectId: project.id, kind: 'proposal', title: input.title, body: input.body,
            options: [{ label: 'accept', description: 'Accept the proposal' }, { label: 'reject', description: 'Reject it' }],
            recommendation: null, category: QuestionCategory.Product, urgency: Urgency.Low, detail: { proposalId }, foldKey: null, targets: [],
          });
          return record('propose', input.opId, { proposalId }, ctx);
        }),
      );
    },

    report_deviation: (input) => {
      const done = prior(input.opId, McpToolName.ReportDeviation);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.report_deviation.parse(done));
      const { project } = context();
      return Promise.resolve(
        deps.state.write((ctx) => {
          const sourceId = insertSource(ctx, 'agent', { sessionId, workstreamId });
          const deviationId = insertDeviation(ctx, { projectId: project.id, workstreamId, cause: input.cause, severity: input.severity, signedReason: `${input.reason} (agent:${sessionId})`, sourceId });
          return record('report_deviation', input.opId, { deviationId }, ctx);
        }),
      );
    },

    request_claim: (input) => {
      const done = prior(input.opId, McpToolName.RequestClaim);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.request_claim.parse(done));
      const { project } = context();
      const known = input.kind === ClaimKind.Hazard ? project.hazards.map((h) => h.name) : project.areas.map((a) => a.name);
      if (!known.includes(input.name)) throw new InvalidError(`No ${input.kind} named ${input.name}. Known: ${known.join(', ')}`);
      // The claim shares the workstream's lease, which the scheduler's heartbeat renews (decision 36).
      const outcome = deps.state.write((ctx) =>
        acquireClaims(ctx, { projectId: project.id, workstreamId, requests: [{ kind: input.kind, name: input.name }], leaseExpiresAt: getWorkstreamRow(ctx.tx, workstreamId).leaseExpiresAt ?? ctx.now }),
      );
      if (outcome.ok) {
        const claim = outcome.claims.find((c) => c.kind === input.kind && c.name === input.name);
        if (!claim) throw new InvalidError('Claim was granted but not found');
        return Promise.resolve(deps.state.write((ctx) => record('request_claim', input.opId, { granted: true, claimId: claim.id }, ctx)));
      }
      const card = deps.inbox.flag({
        projectId: project.id,
        workstreamId,
        title: `Claim conflict: ${input.kind} ${input.name}`,
        body: `Another workstream holds it. Reason given: ${input.reason}`,
        detail: { heldBy: outcome.conflict.heldBy },
      });
      return Promise.resolve(deps.state.write((ctx) => record('request_claim', input.opId, { granted: false, heldBy: outcome.conflict.heldBy, inboxId: card.id }, ctx)));
    },

    commit: async (input) => {
      const done = prior(input.opId, McpToolName.Commit);
      if (done !== undefined) return McpToolOutputs.commit.parse(done);
      const { project } = context();
      const claims = activeClaims(db, workstreamId).map((c) => ({ kind: c.kind, name: c.name }));
      for (const path of input.paths) {
        const verdict = judgeToolUse({ toolName: 'Write', toolInput: { file_path: path }, repoPath: project.repoPath, areas: project.areas, hazards: project.hazards, claims });
        if (verdict.decision === 'deny') throw new InvalidError(verdict.reason);
      }
      const result = await deps.git.commit({ repo: project.repoPath, paths: input.paths, message: input.message, opId: input.opId });
      return deps.state.write((ctx) => {
        ctx.emit({ type: 'commit.recorded', entityType: 'workstream', entityId: workstreamId, data: { sha: result.sha, paths: [...input.paths], alreadyCommitted: result.alreadyCommitted } });
        return record('commit', input.opId, result, ctx);
      });
    },

    record_evidence: (input) => {
      const done = prior(input.opId, McpToolName.RecordEvidence);
      if (done !== undefined) return Promise.resolve(McpToolOutputs.record_evidence.parse(done));
      return Promise.resolve(
        deps.state.write((ctx) => {
          const evidence = insertEvidence(ctx, { workstreamId, kind: 'agent', command: input.command, exitCode: input.exitCode, summary: input.summary, logPath: null, commitShas: [] });
          return record('record_evidence', input.opId, { evidenceId: evidence.id }, ctx);
        }),
      );
    },

    write_handoff: async ({ opId, ...content }) => {
      const done = prior(opId, McpToolName.WriteHandoff);
      if (done !== undefined) return McpToolOutputs.write_handoff.parse(done);
      const { project } = context();
      const row = getWorkstreamRow(db, workstreamId);
      const head = await deps.git.head(project.repoPath);
      const base = row.baseHead ?? head;
      const [changed, commits] = await Promise.all([deps.git.changedFilesSince(project.repoPath, base), deps.git.commitsSince(project.repoPath, base)]);
      return deps.state.write((ctx) => {
        const handoff = insertHandoff(ctx, { workstreamId, sessionId, content, gitHead: head, gitChangedFiles: changed, gitCommits: commits });
        return record('write_handoff', opId, { handoffId: handoff.id, instruction: 'Handoff recorded. End your turn now; a fresh session will continue from it.' }, ctx);
      });
    },
  };
}
```

`apps/daemon/src/mcp/server.ts`:
```ts
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { DomainError, McpToolInputs, McpToolName } from '@10db/contracts';
import { getLiveSessionByTokenHash } from '@10db/db';
import { z } from 'zod';
import { ParkedError } from '../inbox';
import { hashToken } from './tokens';
import { createToolHandlers, TOOL_DESCRIPTIONS, type McpDeps } from './tools';

function errorText(error: unknown): string {
  // The card stays open; its answer reaches the next session's prompt, so a retry would open a second card.
  if (error instanceof ParkedError) return '10db parked this session until the builder answers. Do not ask again: the answer arrives in the prompt of the session that resumes this work. End your turn now.';
  if (error instanceof DomainError) return error.message;
  if (error instanceof z.ZodError) return `Invalid input: ${error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`;
  return 'Internal error in 10db; retry the call with the same opId.';
}

/** Stateless streamable-HTTP MCP endpoint; the bearer token identifies the calling session. */
export function createMcpHandler(deps: McpDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    const token = /^Bearer (.+)$/.exec(req.headers.get('authorization') ?? '')?.[1];
    const session = token ? getLiveSessionByTokenHash(deps.state.db, hashToken(token)) : undefined;
    if (!session) return Response.json({ error: 'unauthorized' }, { status: 401 });

    const handlers = createToolHandlers(deps, session.id, session.workstreamId);
    const server = new McpServer({ name: '10db', version: '0.1.0' });
    for (const name of Object.values(McpToolName)) {
      const schema = McpToolInputs[name];
      server.registerTool(name, { description: TOOL_DESCRIPTIONS[name], inputSchema: schema }, async (args: unknown) => {
        try {
          // Each handler takes its own tool's parsed input; the registry pairs them by name.
          const handler = handlers[name] as (input: unknown) => Promise<unknown>;
          const output = await handler(schema.parse(args));
          return { content: [{ type: 'text' as const, text: JSON.stringify(output) }] };
        } catch (error) {
          return { isError: true, content: [{ type: 'text' as const, text: errorText(error) }] };
        }
      });
    }
    // No sessionIdGenerator means stateless mode; passing `undefined` explicitly fails exactOptionalPropertyTypes.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    await server.connect(transport);
    try {
      return await transport.handleRequest(req);
    } finally {
      void server.close();
    }
  };
}
```
If the MCP SDK's `registerTool` types reject the callback, because they infer the args from the schema, keep the `args: unknown` signature and add one cast at the call with a comment. Don't weaken the handler types. If responses come back empty because the server closes before the JSON body is read, move `server.close()` into a `.then` on the body: `const res = await transport.handleRequest(req); const body = await res.text(); void server.close(); return new Response(body, res);`.

`apps/daemon/src/mcp/index.ts`:
```ts
export { createMcpHandler } from './server';
export { hashToken, mintSessionToken } from './tokens';
export type { McpDeps } from './tools';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon mcp
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/mcp && git commit -m 'feat(daemon): add the MCP server with ten idempotent tools behind per-session tokens'
```
Expected: PASS.

---

### Task 15: HTTP API and the replaying event stream

**Files:**
- Create: `apps/daemon/src/api/services.ts`, `api/stream.ts`
- Modify: `apps/daemon/src/api/app.ts`, `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/api/index.ts` (export `ApiServices`), `apps/daemon/src/main.ts` (placeholder deps), `apps/daemon/package.json` (add `ws` and `@types/ws`)
- Test: `apps/daemon/src/api/app.test.ts`, `apps/daemon/src/api/stream.test.ts`

**Interfaces:**
- Consumes: only `@10db/contracts`, `hono` and `hono/ws` types. There are no `node:*` imports and nothing from `@10db/db` (desktop typechecks this code).
- Produces:
  - `interface ApiServices`:
    - Projects and tasks: `listProjects()`, `createProject(input)`, `listTasks(projectId)`, `createTask(projectId, input)`.
    - Workstreams: `startTask(taskId)`, `listWorkstreams({ active })`, `cancelWorkstream(id): Promise<WorkstreamDto>`, `retryWorkstream(id)`.
    - Inbox: `listInbox({ states })`, `answerInbox(id, answer)`.
    - Events: `eventsAfter(afterSeq, limit)`, `subscribe(listener)`.
  - `interface ApiDeps { startedAt; allowedOrigins; token: string; services: ApiServices; upgradeWebSocket: UpgradeWebSocket; mcp(req: Request): Promise<Response> }`
  - `createApp(deps)` and `type AppType`.
  - **Routes:**

    | Method | Path |
    |---|---|
    | GET | `/health` |
    | GET, POST | `/projects` |
    | GET, POST | `/projects/:projectId/tasks` |
    | POST | `/tasks/:taskId/start` |
    | GET | `/workstreams?active=true\|false` |
    | POST | `/workstreams/:id/cancel` |
    | POST | `/workstreams/:id/retry` |
    | GET | `/inbox?state=OPEN,ANSWERED` |
    | POST | `/inbox/:id/answer` |
    | GET | `/events?after=N&limit=M` |
    | WS | `/events/stream?after=N&token=T` |
    | ALL | `/mcp` |

  - **Auth:**
    - `/health` and `/mcp` skip the UI token; MCP has its own per-session tokens.
    - Every other route needs `Authorization: Bearer <ui token>`. The WebSocket route takes `?token=` instead.
    - Errors: `ZodError` returns 400 with `issues`, and a `DomainError` maps to its status.
  - `streamEvents(after, services, send)` is the replay-then-live seam. Every event with `seq > after` is sent exactly once, in order.

- [ ] **Step 1: Add the dependencies and write the failing tests**

```bash
pnpm add --filter @10db/daemon ws@8.22.0
pnpm add -D --filter @10db/daemon @types/ws@8.18.2
```

Replace `apps/daemon/src/api/app.test.ts`:
```ts
import { ConflictError, HealthResponse, mintId, NotFoundError, PROTOCOL_VERSION, type DaemonEvent } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import type { ApiServices } from './services';

const TOKEN = 'ui-token-for-tests';
const startedAt = new Date('2026-10-13T12:00:00.000Z');

function stubServices(overrides: Partial<ApiServices> = {}): ApiServices {
  const none = () => { throw new Error('not stubbed'); };
  return {
    listProjects: () => [],
    createProject: none,
    listTasks: () => [],
    createTask: none,
    startTask: none,
    listWorkstreams: () => [],
    cancelWorkstream: none,
    retryWorkstream: none,
    listInbox: () => [],
    answerInbox: none,
    eventsAfter: () => [] as DaemonEvent[],
    subscribe: () => () => undefined,
    ...overrides,
  };
}

function app(services = stubServices()) {
  return createApp({
    startedAt,
    allowedOrigins: ['http://localhost:1420'],
    token: TOKEN,
    services,
    upgradeWebSocket: (() => () => new Response(null, { status: 426 })) as never,
    mcp: () => Promise.resolve(new Response('mcp')),
  });
}
const auth = { headers: { Authorization: `Bearer ${TOKEN}` } };

describe('API', () => {
  it('serves /health without a token', async () => {
    const res = await app().request('/health');
    expect(HealthResponse.parse(await res.json())).toEqual({ status: 'ok', protocolVersion: PROTOCOL_VERSION, startedAt: startedAt.toISOString() });
  });

  it('requires the UI token everywhere else', async () => {
    expect((await app().request('/projects')).status).toBe(401);
    expect((await app().request('/projects', { headers: { Authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await app().request('/projects', auth)).status).toBe(200);
  });

  it('passes /mcp through without the UI token', async () => {
    expect(await (await app().request('/mcp', { method: 'POST' })).text()).toBe('mcp');
  });

  it('answers 400 with issue paths for an invalid body', async () => {
    const res = await app().request('/projects', { method: 'POST', ...auth, headers: { ...auth.headers, 'content-type': 'application/json' }, body: JSON.stringify({ name: '' }) });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { issues: { path: string }[] };
    expect(body.issues.map((i) => i.path)).toContain('repoPath');
  });

  it('maps domain errors to 404 and 409', async () => {
    const services = stubServices({
      startTask: () => { throw new NotFoundError('task', 'tsk_x'); },
      retryWorkstream: () => { throw new ConflictError('not failed'); },
    });
    expect((await app(services).request(`/tasks/${mintId('Task')}/start`, { method: 'POST', ...auth })).status).toBe(404);
    expect((await app(services).request(`/workstreams/${mintId('Workstream')}/retry`, { method: 'POST', ...auth })).status).toBe(409);
  });

  it('answers 400 for a malformed ID', async () => {
    expect((await app().request('/tasks/not-an-id/start', { method: 'POST', ...auth })).status).toBe(400);
  });

  it('filters the inbox by a comma-separated state list, and rejects an unknown state', async () => {
    const seen: (readonly string[] | null)[] = [];
    const services = stubServices({ listInbox: ({ states }) => { seen.push(states); return []; } });
    expect((await app(services).request('/inbox?state=OPEN,ANSWERED', auth)).status).toBe(200);
    expect((await app(services).request('/inbox', auth)).status).toBe(200);
    expect(seen).toEqual([['OPEN', 'ANSWERED'], null]);
    expect((await app(services).request('/inbox?state=NOPE', auth)).status).toBe(400);
  });

  it('keeps the CORS allow-list', async () => {
    const ok = await app().request('/health', { headers: { Origin: 'http://localhost:1420' } });
    expect(ok.headers.get('access-control-allow-origin')).toBe('http://localhost:1420');
    const no = await app().request('/health', { headers: { Origin: 'https://evil.example' } });
    expect(no.headers.get('access-control-allow-origin')).toBeNull();
  });
});
```

`apps/daemon/src/api/stream.test.ts`:
```ts
import type { DaemonEvent } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import type { ApiServices } from './services';
import { streamEvents } from './stream';

const ev = (seq: number): DaemonEvent => ({ seq, type: 'task.created', entityType: 'task', entityId: 'x', data: {}, at: '2026-10-13T12:00:00.000Z' });

describe('streamEvents', () => {
  it('replays after the cursor, then streams live, with no gap or duplicate at the seam', () => {
    const history = [ev(1), ev(2), ev(3)];
    // Cast rather than annotate: an annotated `let x: F | null = null` narrows to `null`, because the only
    // other assignments happen inside callbacks, and then `listener?.(…)` fails to typecheck.
    let listener = null as ((e: DaemonEvent) => void) | null;
    const services: Pick<ApiServices, 'eventsAfter' | 'subscribe'> = {
      subscribe: (fn) => { listener = fn; return () => { listener = null; }; },
      eventsAfter: (after) => {
        // Event 4 commits while the replay query runs: it must arrive once, after 3.
        if (after === 1) { history.push(ev(4)); listener?.(ev(4)); }
        return history.filter((e) => e.seq > after);
      },
    };
    const sent: number[] = [];
    const stop = streamEvents(1, services, (e) => sent.push(e.seq));
    listener?.(ev(4));
    listener?.(ev(5));
    stop();
    listener?.(ev(6));
    expect(sent).toEqual([2, 3, 4, 5]);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm vitest run --project daemon api
```
Expected: FAIL, because `./services` and `./stream` are missing and `createApp` lacks the new deps.

- [ ] **Step 3: Implement**

`apps/daemon/src/api/services.ts`:
```ts
import type {
  DaemonEvent,
  InboxAnswer,
  InboxItemDto,
  InboxItemId,
  InboxState,
  ProjectDto,
  ProjectId,
  ProjectInput,
  TaskDto,
  TaskId,
  TaskInput,
  WorkstreamDto,
  WorkstreamId,
} from '@10db/contracts';

/** What the HTTP layer needs from the daemon. Implemented in the daemon module. */
export interface ApiServices {
  listProjects(): ProjectDto[];
  createProject(input: ProjectInput): ProjectDto;
  listTasks(projectId: ProjectId): TaskDto[];
  createTask(projectId: ProjectId, input: TaskInput): TaskDto;
  startTask(taskId: TaskId): WorkstreamDto;
  listWorkstreams(filter: { readonly active: boolean }): WorkstreamDto[];
  cancelWorkstream(id: WorkstreamId): Promise<WorkstreamDto>;
  retryWorkstream(id: WorkstreamId): WorkstreamDto;
  listInbox(filter: { readonly states: readonly InboxState[] | null }): InboxItemDto[];
  answerInbox(id: InboxItemId, answer: InboxAnswer): InboxItemDto;
  eventsAfter(afterSeq: number, limit: number): DaemonEvent[];
  subscribe(listener: (event: DaemonEvent) => void): () => void;
}
```

`apps/daemon/src/api/stream.ts`:
```ts
import type { DaemonEvent } from '@10db/contracts';
import type { ApiServices } from './services';

const PAGE = 500;

/**
 * Sends every event with seq > `after` exactly once and in order: subscribe first (buffering),
 * replay from the store, flush the buffer past the last replayed seq, then go live.
 * Returns an unsubscribe function.
 */
export function streamEvents(after: number, services: Pick<ApiServices, 'eventsAfter' | 'subscribe'>, send: (event: DaemonEvent) => void): () => void {
  let lastSent = after;
  let live = false;
  const buffered: DaemonEvent[] = [];
  const emit = (event: DaemonEvent): void => {
    if (event.seq <= lastSent) return;
    send(event);
    lastSent = event.seq;
  };
  const unsubscribe = services.subscribe((event) => {
    if (live) emit(event);
    else buffered.push(event);
  });
  for (;;) {
    const page = services.eventsAfter(lastSent, PAGE);
    for (const event of page) emit(event);
    if (page.length < PAGE) break;
  }
  for (const event of buffered.sort((a, b) => a.seq - b.seq)) emit(event);
  live = true;
  return unsubscribe;
}
```

Replace `apps/daemon/src/api/app.ts`:
```ts
import {
  DomainError,
  HealthResponse,
  InboxAnswer,
  InboxItemId,
  InboxState,
  ProjectId,
  ProjectInput,
  PROTOCOL_VERSION,
  TaskId,
  TaskInput,
  WorkstreamId,
} from '@10db/contracts';
import { Hono } from 'hono';
import { cors } from 'hono/cors';
import type { UpgradeWebSocket } from 'hono/ws';
import { z } from 'zod';
import type { ApiServices } from './services';
import { streamEvents } from './stream';

export interface ApiDeps {
  readonly startedAt: Date;
  /** Origins the UI is served from (Vite dev server, Tauri webview). */
  readonly allowedOrigins: readonly string[];
  /** The UI's bearer token, generated by the daemon at start. */
  readonly token: string;
  readonly services: ApiServices;
  readonly upgradeWebSocket: UpgradeWebSocket;
  /** The MCP endpoint; it authenticates sessions itself. */
  mcp(req: Request): Promise<Response>;
}

const STATUS = { not_found: 404, conflict: 409, invalid: 400 } as const;
const OPEN_PATHS = new Set(['/health', '/mcp']);

function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const Cursor = z.coerce.number().int().min(0).catch(0);
const Limit = z.coerce.number().int().min(1).max(1000).catch(500);
const StateList = z
  .string()
  .optional()
  // InboxState is an `as const` object, not a schema, so wrap it in z.enum to parse.
  .transform((s) => (s ? s.split(',').map((x) => z.enum(InboxState).parse(x)) : null));

export function createApp(deps: ApiDeps) {
  const app = new Hono()
    .use('*', cors({ origin: (origin) => (deps.allowedOrigins.includes(origin) ? origin : null), allowHeaders: ['Authorization', 'Content-Type'] }))
    .use('*', async (c, next) => {
      if (OPEN_PATHS.has(c.req.path)) return next();
      const presented = c.req.path === '/events/stream' ? (c.req.query('token') ?? '') : (/^Bearer (.+)$/.exec(c.req.header('authorization') ?? '')?.[1] ?? '');
      if (!sameToken(presented, deps.token)) return c.json({ error: 'unauthorized' }, 401);
      return next();
    })
    .all('/mcp', (c) => deps.mcp(c.req.raw))
    .get('/health', (c) => c.json(HealthResponse.parse({ status: 'ok', protocolVersion: PROTOCOL_VERSION, startedAt: deps.startedAt.toISOString() })))
    .get('/projects', (c) => c.json(deps.services.listProjects()))
    .post('/projects', async (c) => c.json(deps.services.createProject(ProjectInput.parse(await c.req.json())), 201))
    .get('/projects/:projectId/tasks', (c) => c.json(deps.services.listTasks(ProjectId.parse(c.req.param('projectId')))))
    .post('/projects/:projectId/tasks', async (c) =>
      c.json(deps.services.createTask(ProjectId.parse(c.req.param('projectId')), TaskInput.parse(await c.req.json())), 201),
    )
    .post('/tasks/:taskId/start', (c) => c.json(deps.services.startTask(TaskId.parse(c.req.param('taskId'))), 201))
    .get('/workstreams', (c) => c.json(deps.services.listWorkstreams({ active: c.req.query('active') !== 'false' })))
    .post('/workstreams/:id/cancel', async (c) => c.json(await deps.services.cancelWorkstream(WorkstreamId.parse(c.req.param('id')))))
    .post('/workstreams/:id/retry', (c) => c.json(deps.services.retryWorkstream(WorkstreamId.parse(c.req.param('id')))))
    .get('/inbox', (c) => c.json(deps.services.listInbox({ states: StateList.parse(c.req.query('state')) })))
    .post('/inbox/:id/answer', async (c) =>
      c.json(deps.services.answerInbox(InboxItemId.parse(c.req.param('id')), InboxAnswer.parse(await c.req.json()))),
    )
    .get('/events', (c) => c.json(deps.services.eventsAfter(Cursor.parse(c.req.query('after')), Limit.parse(c.req.query('limit')))))
    .get(
      '/events/stream',
      deps.upgradeWebSocket((c) => {
        const after = Cursor.parse(c.req.query('after'));
        let stop: (() => void) | null = null;
        return {
          onOpen(_event, ws) {
            stop = streamEvents(after, deps.services, (event) => { ws.send(JSON.stringify(event)); });
          },
          onClose() {
            stop?.();
          },
        };
      }),
    );

  app.onError((error, c) => {
    if (error instanceof z.ZodError) {
      return c.json({ error: 'invalid', issues: error.issues.map((i) => ({ path: i.path.join('.'), message: i.message })) }, 400);
    }
    if (error instanceof DomainError) return c.json({ error: error.code, message: error.message }, STATUS[error.code]);
    return c.json({ error: 'internal' }, 500);
  });
  return app;
}

export type AppType = ReturnType<typeof createApp>;
```
`/mcp` sits in `OPEN_PATHS` because the MCP handler checks session tokens itself.

Append to `apps/daemon/src/api/index.ts`:
```ts
export type { ApiServices } from './services';
```

`createApp` now needs more deps, so `apps/daemon/src/main.ts` stops compiling. Give it placeholders until Task 19 replaces the file. Add `import { randomBytes } from 'node:crypto';`, change the `@hono/node-server` import to `import { serve, upgradeWebSocket } from '@hono/node-server';`, change `import { createApp } from './api';` to `import { createApp, type ApiServices } from './api';`, and replace the `const app = createApp(...)` line with:
```ts
// Placeholders until Task 19 composes the daemon: only /health works in between.
const notWired = (): never => {
  throw new Error('The daemon services are wired in Task 19');
};
const placeholderServices: ApiServices = {
  listProjects: notWired,
  createProject: notWired,
  listTasks: notWired,
  createTask: notWired,
  startTask: notWired,
  listWorkstreams: notWired,
  cancelWorkstream: notWired,
  retryWorkstream: notWired,
  listInbox: notWired,
  answerInbox: notWired,
  eventsAfter: notWired,
  subscribe: notWired,
};
const app = createApp({
  startedAt: new Date(),
  allowedOrigins: UI_ORIGINS,
  token: randomBytes(32).toString('base64url'),
  services: placeholderServices,
  upgradeWebSocket,
  mcp: () => Promise.resolve(Response.json({ error: 'not wired' }, { status: 503 })),
});
```

- [ ] **Step 4: Run, check (including the desktop typecheck), commit**

```bash
pnpm vitest run --project daemon api
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/api apps/daemon/src/main.ts apps/daemon/package.json pnpm-lock.yaml && git commit -m 'feat(daemon): add the HTTP API with token auth and a gap-free replaying event stream'
```
Expected: PASS, and `pnpm typecheck` stays green for `@10db/desktop`. That proves `src/api` still has no Node-only imports.

### Task 16: The workstream runner

**Files:**
- Create: `apps/daemon/src/runner/runner.ts`, `runner/next-action.ts`, `runner/live-sessions.ts`, `runner/index.ts`
- Create: `apps/daemon/test/engine.ts` (test harness: store, inbox, git, gate, MCP server, runner, fake adapter)
- Modify: `apps/daemon/test/fixtures.ts` (add `waitFor`, `waitForAsync`, `handoffArgs`)
- Test: `apps/daemon/src/runner/next-action.test.ts`, `apps/daemon/src/runner/runner.test.ts`

**Interfaces:**
- Consumes everything above.
- Produces, from `runner/index.ts`:
  - `type StopReason = 'cancelled' | 'paused' | 'shutdown'`
  - `interface RunnerLimits { maxRecoveryAttempts; maxFixAttempts; gateTimeoutMs }` and `DEFAULT_RUNNER_LIMITS`, which are `{ 3, 3, 30 min }`.
  - `interface LiveSessions { register(id, { signal, observer }); unregister(id); get(id) }` and `createLiveSessions()`.
  - `nextActionAfterCrash(previous: NextAction, providerSessionId: string | null, latest: HandoffDto | null): NextAction`
  - **`interface RunnerOptions`**:
    - Services: `state`, `adapter`, `inbox`, `git`, `gate`, `clock`, `logger`, `dataDir`, `live`, `limits`.
    - Callbacks: `mcpUrl(): string`, `sessionEnv(project): Readonly<Record<string, string>>`, `onRateLimited(provider, resetsAt: Date | null, projectId)`, `onLaneFreed()`.
    - Optional: `identifyProcess?(pid): Promise<string | null>`, the OS start time of a pid. The runner stores it beside a session's or gate's pid so recovery never signals a reused PID. `startDaemon` passes `systemProcesses.identify`; without it nothing is recorded and recovery leaves those processes alone.
  - **`interface Runner`**:
    - Control: `launch(id, fence)`, `stop(id, reason): Promise<void>`, `cancel(id): Promise<void>` (cancels running or idle work), `stopProvider(provider, reason)`, `stopAll(reason)`.
    - Status: `isRunning(id)`, `idle(): Promise<void>`.
    - Inbox hook: `deliverParkedAnswer(target, item)`.
  - `createRunner(opts): Runner`
- Behavior (spec §5):
  - **Session loop.** Each session gets a fresh MCP token, a prompt from `briefing`, the guard as `preToolUse`, and the permission broker as `canUseTool`.
  - **Context thresholds.** At `handoffPct` the runner moves the workstream to HANDING_OFF and sends `HANDOFF_NUDGE`. At `nudgePct`, or when the turn ends with no handoff, it sends `HANDOFF_FIRM_NUDGE` once. When the turn ends with a handoff recorded, the next session starts right away in the same lane.
  - **Turn complete without a handoff request.** The workstream goes to VERIFYING, and 10db runs the gate:
    - On pass: DONE, task done, claims released.
    - On fail: QUEUED with a `fix` next action. After `maxFixAttempts` it becomes FAILED and a flag card is raised.
  - **Questions.** A question moves the workstream to WAITING_HUMAN, by way of RUNNING if the session hasn't reported `started` yet (a fake or real session can ask before its first event is processed). After `humanWaitMinutes` the runner first aborts the session's waits, so an answer from then on takes the parked path, and then stops the session. The lane is freed and the next action becomes `answer`. When the answer arrives, it re-queues; an answer that lands while the session is still stopping re-queues as soon as the stop finishes. A permission answered after parking keeps its effect: rules come from `inbox.answer`, and an `allow_once` lets the first identical call in the resumed session through.
  - **Progress resets the crash count.** A session that ends in `handoff` or `step_done` sets `recoveryAttempts` back to 0, so `maxRecoveryAttempts` counts consecutive failures.
  - **Stopping.** `stop(id, 'cancelled' | 'shutdown')` also aborts a running gate, which kills its process group. A gate aborted by shutdown records no evidence; the workstream stays VERIFYING and recovery runs the gate again. A `shutdown` stop ends the session with exit reason `shutdown`.
  - **Crashes.** RECOVERING, then QUEUED with `nextActionAfterCrash`. After `maxRecoveryAttempts` it becomes FAILED and a flag card is raised.
  - **Usage limit.** A rejected rate-limit event moves the workstream to PAUSED_LIMIT and reports `onRateLimited`.
  - **Compaction.** It records a deviation and re-sends the context pack.

- [ ] **Step 1: Extend the fixtures**

Append to `apps/daemon/test/fixtures.ts`:
```ts
/** Polls `check` until it returns a value (not undefined/false) or the deadline passes. */
export async function waitFor<T>(check: () => T | undefined | false, timeoutMs = 10_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = check();
    if (value !== undefined && value !== false) return value;
    if (Date.now() > deadline) throw new Error('waitFor timed out');
    await new Promise((r) => setTimeout(r, 15));
  }
}

/** Async variant of `waitFor` for checks that call the HTTP API. */
export async function waitForAsync<T>(check: () => Promise<T | undefined>, timeoutMs = 15_000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await check();
    if (value !== undefined) return value;
    if (Date.now() > deadline) throw new Error('waitForAsync timed out');
    await new Promise((r) => setTimeout(r, 25));
  }
}

/** Arguments for the write_handoff MCP tool in fake scripts. */
export function handoffArgs(opId: string, nextAction: string): Record<string, unknown> {
  return {
    opId,
    objective: { task: 'scripted', acceptanceCriteria: ['it works'], nonGoals: [] },
    progress: { done: ['first half'], notDone: ['second half'], nextAction },
    codeState: { uncommittedSummary: '' },
    reasoning: { decisions: [], tradeOffs: [], rejected: [] },
    validation: { checks: [], environmentProblems: [] },
    continuity: { blockers: [], pendingQuestions: [], backgroundJobs: [], notes: '' },
  };
}
```

- [ ] **Step 2: Write the test harness**

`apps/daemon/test/engine.ts`:
```ts
import type { AddressInfo } from 'node:net';
import { serve } from '@hono/node-server';
import type { ProjectDto, ProjectInput, Provider, TaskDto, WorkstreamDto, WorkstreamId } from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  createTestStore,
  getProject,
  getTask,
  getWorkstreamRow,
  insertTask,
  insertWorkstream,
  seedProject,
  transitionWorkstream,
  type Store,
} from '@10db/db';
import { ManualClock } from '../src/clock';
import { createEventBus, createStateStore, type StateStore } from '../src/events';
import { createGit } from '../src/git';
import { createInboxService, type InboxService } from '../src/inbox';
import { silentLogger } from '../src/log';
import { createMcpHandler } from '../src/mcp';
import { createLiveSessions, createRunner, DEFAULT_RUNNER_LIMITS, type Runner } from '../src/runner';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { createGateRunner } from '../src/verify';
import { createTempRepo, tempDir } from './fixtures';

export interface TestEngine {
  readonly store: Store;
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly runner: Runner;
  readonly adapter: FakeAdapter;
  readonly clock: ManualClock;
  readonly project: ProjectDto;
  readonly repoPath: string;
  readonly rateLimited: { provider: Provider; resetsAt: Date | null }[];
  addTask(title: string, areas?: string[], dependsOn?: TaskDto['id'][]): { task: TaskDto; workstream: WorkstreamDto };
  /** Does what the scheduler does: claims, lease, STARTING, then launch. */
  launch(id: WorkstreamId): void;
  close(): Promise<void>;
}

export async function createTestEngine(book: FakeScriptBook, project: Partial<ProjectInput> = {}): Promise<TestEngine> {
  const repo = await createTempRepo();
  const data = tempDir('engine-data');
  const { store, close } = createTestStore();
  const state = createStateStore(store, createEventBus());
  const clock = new ManualClock();
  const adapter = new FakeAdapter(book);
  const live = createLiveSessions();
  const git = createGit();
  const rateLimited: { provider: Provider; resetsAt: Date | null }[] = [];
  let runner: Runner | null = null;
  const inbox = createInboxService({ state, onParkedAnswer: (target, item) => runner?.deliverParkedAnswer(target, item) });
  const server = serve({
    fetch: createMcpHandler({ state, inbox, git, waitObserverFor: (id) => live.get(id)?.observer, sessionSignal: (id) => live.get(id)?.signal }),
    hostname: '127.0.0.1',
    port: 0,
  });
  await new Promise((r) => server.once('listening', r));
  const mcpUrl = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}/mcp`;
  runner = createRunner({
    state, adapter, inbox, git, gate: createGateRunner(), clock, logger: silentLogger, dataDir: data.path, live,
    limits: { ...DEFAULT_RUNNER_LIMITS, gateTimeoutMs: 20_000 },
    mcpUrl: () => mcpUrl,
    sessionEnv: () => ({}),
    onRateLimited: (provider, resetsAt) => rateLimited.push({ provider, resetsAt }),
    onLaneFreed: () => undefined,
  });
  const seeded = seedProject(store, {
    repoPath: repo.path,
    gateCommand: 'true',
    areas: [{ name: 'api', globs: ['src/api/**'] }, { name: 'ui', globs: ['src/ui/**'] }],
    ...project,
  });
  const engine: TestEngine = {
    store, state, inbox, runner, adapter, clock, project: seeded, repoPath: repo.path, rateLimited,
    addTask(title, areas = ['api'], dependsOn = []) {
      const task = state.write((ctx) => insertTask(ctx, seeded.id, { title, acceptanceCriteria: ['it works'], areas, dependsOn }));
      const workstream = state.write((ctx) => insertWorkstream(ctx, task.id));
      return { task, workstream };
    },
    launch(id) {
      const row = getWorkstreamRow(store.db, id);
      const task = getTask(store.db, row.taskId);
      const fence = state.write((ctx) => {
        const lease = new Date(clock.now().getTime() + 60_000).toISOString();
        const claims = acquireClaims(ctx, { projectId: row.projectId, workstreamId: id, requests: claimRequestsForTask(task, getProject(ctx.tx, row.projectId)), leaseExpiresAt: lease });
        if (!claims.ok) throw new Error(`claim conflict on ${claims.conflict.name}`);
        const f = acquireLease(ctx, id, 'test-daemon', lease);
        transitionWorkstream(ctx, id, { to: 'STARTING', fence: f });
        return f;
      });
      runner.launch(id, fence);
    },
    async close() {
      await runner.stopAll('shutdown');
      server.close();
      close();
      repo.cleanup();
      data.cleanup();
    },
  };
  return engine;
}
```

- [ ] **Step 3: Write the failing tests**

`apps/daemon/src/runner/next-action.test.ts`:
```ts
import { mintId, type HandoffDto, type NextAction } from '@10db/contracts';
import { describe, expect, it } from 'vitest';
import { nextActionAfterCrash } from './index';

const handoff = { id: mintId('Handoff') } as HandoffDto;

describe('nextActionAfterCrash', () => {
  it.each<[string, NextAction, string | null, HandoffDto | null, NextAction['kind']]>([
    ['resumes a session that has a provider id', { kind: 'start' }, 'p1', null, 'resume'],
    ['starts fresh from the handoff after a failed resume', { kind: 'resume', providerSessionId: 'p1', reason: 'x' }, 'p1', handoff, 'continue_from_handoff'],
    ['starts over when a resume failed and there is no handoff', { kind: 'resume', providerSessionId: 'p1', reason: 'x' }, 'p1', null, 'start'],
    ['continues from the handoff when the provider never started', { kind: 'start' }, null, handoff, 'continue_from_handoff'],
    ['keeps verification as verification', { kind: 'verify' }, 'p1', handoff, 'verify'],
  ])('%s', (_name, previous, providerSessionId, latest, kind) => {
    expect(nextActionAfterCrash(previous, providerSessionId, latest).kind).toBe(kind);
  });
});
```
The `as HandoffDto` cast is the one allowed shortcut in this test. `nextActionAfterCrash` reads only `.id`, and a full handoff fixture would hide that.

`apps/daemon/src/runner/runner.test.ts`:
```ts
import { activeClaims, getTask, getWorkstream, listEventsAfter, listEvidence, listInbox, listSessions, schema } from '@10db/db';
import { afterEach, describe, expect, it } from 'vitest';
import { handoffArgs, waitFor } from '../../test/fixtures';
import { createTestEngine, type TestEngine } from '../../test/engine';

let engine: TestEngine;
afterEach(async () => { await engine.close(); });

const write = (path: string, content = 'x') => ({ do: 'tool' as const, toolName: 'Write', input: { file_path: path, content } });
const commit = (opId: string, paths: string[]) => ({ do: 'mcp' as const, tool: 'commit', args: { opId, paths, message: `Commit ${opId}` } });
const turn = { do: 'turn_complete' as const };
const askShip = { do: 'tool' as const, toolName: 'AskUserQuestion', input: { questions: [{ question: 'Ship it?', header: 'Ship', options: [{ label: 'Yes', description: '' }, { label: 'No', description: '' }], multiSelect: false }] } };

const curl = { do: 'tool' as const, toolName: 'Bash', input: { command: 'curl -s https://example.com' } };

const ws = (id: Parameters<typeof getWorkstream>[1]) => getWorkstream(engine.store.db, id);
const openCard = () => listInbox(engine.store.db, { states: ['OPEN'] })[0];
const transitions = (id: Parameters<typeof getWorkstream>[1]) =>
  listEventsAfter(engine.store.db, 0, 1000)
    .filter((e) => e.type === 'workstream.changed' && e.entityId === id)
    .map((e) => [e.data['from'], e.data['to']].map((s) => (typeof s === 'string' ? s : '?')).join('->'));

describe('runner', () => {
  it('runs a task to DONE with gate evidence, and the guard blocks an out-of-claim write', async () => {
    engine = await createTestEngine({ Alpha: [[write('src/ui/nope.txt'), write('src/api/a.txt'), commit('op-alpha-001', ['src/api/a.txt']), turn]] });
    const { task, workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(getTask(engine.store.db, task.id).status).toBe('done');
    const [gate] = listEvidence(engine.store.db, workstream.id);
    expect(gate).toMatchObject({ kind: 'gate', exitCode: 0 });
    expect(gate?.commitShas).toHaveLength(1);
    expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
    expect(engine.adapter.observations.find((o) => o.kind === 'denied_by_guard')?.detail['reason']).toContain('request_claim');
  });

  it('hands off at the threshold, nudges firmly near the limit, and continues in a fresh session', async () => {
    engine = await createTestEngine({
      Alpha: [
        [{ do: 'context', percentage: 75 }, { do: 'await_message', contains: 'write_handoff' }, { do: 'context', percentage: 88 }, { do: 'await_message', contains: 'almost full' }, { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-handoff-1', 'Write the second file') }, turn],
        [write('src/api/b.txt'), commit('op-alpha-002', ['src/api/b.txt']), turn],
      ],
    });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id).map((s) => s.exitReason)).toEqual(['handoff', 'step_done']);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Next action: Write the second file');
    const states = listEventsAfter(engine.store.db, 0, 1000).filter((e) => e.type === 'workstream.changed').map((e) => e.data['to']);
    expect(states).toContain('HANDING_OFF');
  });

  it('sends a failed gate back as a fix with the output, then passes', async () => {
    engine = await createTestEngine(
      { Alpha: [[turn], [write('src/api/fixed.txt'), commit('op-fix-0001', ['src/api/fixed.txt']), turn]] },
      { gateCommand: 'test -f src/api/fixed.txt || { echo MISSING-FIXED-FILE; exit 2; }' },
    );
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'fix' }, attempt: 1 });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('MISSING-FIXED-FILE');
  });

  it('parks a long wait, frees the lane, and resumes with the answer in a new session', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, turn], [write('src/api/a.txt'), commit('op-park-0001', ['src/api/a.txt']), turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    expect(ws(workstream.id).state).toBe('WAITING_HUMAN');

    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null, nextAction: { kind: 'answer', inboxId: card.id } });

    engine.inbox.answer(card.id, { choice: 'Yes' });
    expect(ws(workstream.id).state).toBe('QUEUED');
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    const [first, second] = listSessions(engine.store.db, workstream.id);
    expect(engine.adapter.prompts[1]).toMatchObject({ resume: first?.providerSessionId });
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
    expect(second?.exitReason).toBe('step_done');
  });

  it('delivers a live answer to the same session', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, write('src/api/a.txt'), commit('op-live-0001', ['src/api/a.txt']), turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(listSessions(engine.store.db, workstream.id)).toHaveLength(1);
    expect(engine.adapter.observations).toContainEqual(expect.objectContaining({ kind: 'tool_allowed', detail: { toolName: 'AskUserQuestion', answers: { 'Ship it?': 'Yes' } } }));
  });

  it('goes STARTING -> RUNNING -> WAITING_HUMAN when the first step is a question', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    engine.inbox.answer((await waitFor(openCard)).id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(transitions(workstream.id).slice(0, 4)).toEqual(['QUEUED->STARTING', 'STARTING->RUNNING', 'RUNNING->WAITING_HUMAN', 'WAITING_HUMAN->RUNNING']);
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('keeps an answer that arrives while the parked session is still stopping', async () => {
    engine = await createTestEngine({ Alpha: [[askShip, turn], [write('src/api/a.txt'), commit('op-grace-0001', ['src/api/a.txt']), turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    engine.inbox.answer(card.id, { choice: 'Yes' });
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 0, nextAction: { kind: 'answer', inboxId: card.id } });

    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.adapter.prompts[1]?.prompt).toContain('Answer: Yes');
  });

  it.each(['allow_project', 'allow_once'])('applies %s answered after parking, without asking again', async (choice) => {
    engine = await createTestEngine({ Alpha: [[curl, turn], [curl, write('src/api/a.txt'), commit('op-perm-0001', ['src/api/a.txt']), turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    const card = await waitFor(openCard);
    engine.clock.advance(10 * 60_000);
    await engine.runner.idle();
    engine.inbox.answer(card.id, { choice });
    engine.launch(workstream.id);
    await engine.runner.idle();

    expect(ws(workstream.id).state).toBe('DONE');
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['review']);
    expect(engine.adapter.observations.filter((o) => o.kind === 'tool_allowed' && o.detail['toolName'] === 'Bash')).toHaveLength(1);
    expect(engine.adapter.prompts[1]?.prompt).toContain('Allow Bash? curl -s https://example.com');
  });

  it('resets the crash count once a session makes progress', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'crash', message: 'boom' }], [write('src/api/a.txt'), commit('op-reset-0001', ['src/api/a.txt']), turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).recoveryAttempts).toBe(1);
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id)).toMatchObject({ state: 'DONE', recoveryAttempts: 0 });
  });

  it('cancels during verification by killing the gate', async () => {
    engine = await createTestEngine({ Alpha: [[turn]] }, { gateCommand: 'sleep 30' });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => ws(workstream.id).state === 'VERIFYING');
    const started = Date.now();
    await engine.runner.cancel(workstream.id);
    expect(Date.now() - started).toBeLessThan(5_000);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(listEvidence(engine.store.db, workstream.id)).toEqual([]);
  });

  it('retries crashes as resume, then fresh, and fails after the limit with a flag', async () => {
    const crash = { do: 'crash' as const, message: 'boom' };
    engine = await createTestEngine({ Alpha: [[crash], [crash], [crash], [crash]] });
    const { workstream } = engine.addTask('Alpha');
    const kinds: string[] = [];
    for (let i = 0; i < 4; i += 1) {
      engine.launch(workstream.id);
      await engine.runner.idle();
      kinds.push(ws(workstream.id).state === 'QUEUED' ? ws(workstream.id).nextAction.kind : ws(workstream.id).state);
    }
    expect(kinds).toEqual(['resume', 'start', 'resume', 'FAILED']);
    expect(listInbox(engine.store.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('cancels a running workstream, releasing claims', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'activity', summary: 'working' }, { do: 'hang' }]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await waitFor(() => listSessions(engine.store.db, workstream.id)[0]?.providerSessionId ?? undefined);
    await engine.runner.cancel(workstream.id);
    expect(ws(workstream.id).state).toBe('CANCELLED');
    expect(activeClaims(engine.store.db, workstream.id)).toEqual([]);
  });

  it('pauses on a usage limit until the reported reset', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'rate_limit', status: 'rejected', resetsInSeconds: 600 }]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('PAUSED_LIMIT');
    expect(ws(workstream.id).pausedUntil).not.toBeNull();
    expect(engine.rateLimited).toHaveLength(1);
  });

  it('logs emergency compaction as a deviation and re-sends the context pack', async () => {
    engine = await createTestEngine({ Alpha: [[{ do: 'compact' }, { do: 'await_message', contains: 'context pack' }, turn]] });
    const { workstream } = engine.addTask('Alpha');
    engine.launch(workstream.id);
    await engine.runner.idle();
    expect(ws(workstream.id).state).toBe('DONE');
    expect(engine.store.db.select().from(schema.deviations).all()).toHaveLength(1);
  });
});
```

- [ ] **Step 4: Run them to see them fail**

```bash
pnpm vitest run --project daemon runner
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 5: Implement**

`apps/daemon/src/runner/next-action.ts`:
```ts
import type { HandoffDto, NextAction } from '@10db/contracts';

/** After a crash: resume the provider session once; if resuming already failed, start fresh from the last handoff. */
export function nextActionAfterCrash(previous: NextAction, providerSessionId: string | null, latest: HandoffDto | null): NextAction {
  const fresh: NextAction = latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' };
  if (previous.kind === 'verify') return previous;
  if (previous.kind === 'resume') return fresh;
  return providerSessionId ? { kind: 'resume', providerSessionId, reason: 'the session crashed' } : fresh;
}
```

`apps/daemon/src/runner/live-sessions.ts`:
```ts
import type { SessionId } from '@10db/contracts';
import type { WaitObserver } from '../inbox';

export interface LiveSession {
  readonly signal: AbortSignal;
  readonly observer: WaitObserver;
}

/** Sessions with a running adapter handle; MCP tools look up their wait observer and abort signal here. */
export interface LiveSessions {
  register(id: SessionId, session: LiveSession): void;
  unregister(id: SessionId): void;
  get(id: SessionId): LiveSession | undefined;
}

export function createLiveSessions(): LiveSessions {
  const sessions = new Map<SessionId, LiveSession>();
  return {
    register: (id, session) => { sessions.set(id, session); },
    unregister: (id) => { sessions.delete(id); },
    get: (id) => sessions.get(id),
  };
}
```

`apps/daemon/src/runner/runner.ts`:
```ts
import { join } from 'node:path';
import {
  EventType,
  InboxKind,
  PermissionChoice,
  WorkstreamState as S,
  type HandoffId,
  type InboxItemDto,
  type InboxItemId,
  type InboxTarget,
  type NextAction,
  type ProjectDto,
  type ProjectId,
  type Provider,
  type WorkstreamId,
} from '@10db/contracts';
import {
  activeClaims,
  clearLease,
  endSession,
  getEvidence,
  getHandoff,
  getInboxItem,
  getProject,
  getTask,
  getWorkstream,
  getWorkstreamRow,
  handoffForSession,
  insertDeviation,
  insertEvidence,
  insertInboxItem,
  insertSession,
  insertSource,
  latestHandoff,
  latestToolOp,
  listEvidence,
  markSessionStarted,
  openItemsForWorkstream,
  patchWorkstream,
  releaseClaims,
  setTaskStatus,
  StaleFenceError,
  transitionWorkstream,
  updateSessionUsage,
} from '@10db/db';
import { buildContextPack, buildSessionPrompt, compactionReinjection, HANDOFF_FIRM_NUDGE, HANDOFF_NUDGE } from '../briefing';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Git } from '../git';
import { judgeToolUse } from '../guard';
import { createPermissionBroker, type InboxService, type WaitObserver } from '../inbox';
import type { Logger } from '../log';
import { mintSessionToken } from '../mcp';
import { baseAllowedTools } from '../permissions';
import type { SessionAdapter, SessionHandle } from '../sessions';
import type { GateRunner } from '../verify';
import type { LiveSessions } from './live-sessions';
import { nextActionAfterCrash } from './next-action';

export type StopReason = 'cancelled' | 'paused' | 'shutdown';

export interface RunnerLimits {
  readonly maxRecoveryAttempts: number;
  readonly maxFixAttempts: number;
  readonly gateTimeoutMs: number;
}

export const DEFAULT_RUNNER_LIMITS: RunnerLimits = { maxRecoveryAttempts: 3, maxFixAttempts: 3, gateTimeoutMs: 30 * 60_000 };

export interface RunnerOptions {
  readonly state: StateStore;
  readonly adapter: SessionAdapter;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly gate: GateRunner;
  readonly clock: Clock;
  readonly logger: Logger;
  readonly dataDir: string;
  readonly live: LiveSessions;
  readonly limits: RunnerLimits;
  mcpUrl(): string;
  sessionEnv(project: ProjectDto): Readonly<Record<string, string>>;
  onRateLimited(provider: Provider, resetsAt: Date | null, projectId: ProjectId): void;
  onLaneFreed(): void;
  /** The OS start time of a pid, stored beside it so recovery can tell a reused PID apart. */
  identifyProcess?(pid: number): Promise<string | null>;
}

export interface Runner {
  launch(id: WorkstreamId, fence: number): void;
  stop(id: WorkstreamId, reason: StopReason): Promise<void>;
  cancel(id: WorkstreamId): Promise<void>;
  stopProvider(provider: Provider, reason: StopReason): Promise<void>;
  stopAll(reason: StopReason): Promise<void>;
  isRunning(id: WorkstreamId): boolean;
  idle(): Promise<void>;
  deliverParkedAnswer(target: InboxTarget, item: InboxItemDto): void;
}

type Outcome =
  | { readonly kind: 'handoff'; readonly handoffId: HandoffId }
  | { readonly kind: 'step_done'; readonly withoutHandoff: boolean }
  | { readonly kind: 'parked'; readonly inboxId: InboxItemId; readonly providerSessionId: string | null }
  | { readonly kind: 'paused'; readonly until: Date | null; readonly providerSessionId: string | null }
  | { readonly kind: 'crashed'; readonly message: string; readonly providerSessionId: string | null }
  | { readonly kind: 'stopped'; readonly reason: StopReason; readonly providerSessionId: string | null };

type Terminal = Exclude<Outcome, { kind: 'handoff' } | { kind: 'step_done' }>;

const PERMISSION_ANSWER_TEXT: Readonly<Record<string, string>> = {
  [PermissionChoice.AllowOnce]: 'allowed once. Retry the call now; 10db lets this exact call through once.',
  [PermissionChoice.AllowWorkstream]: 'allowed for the rest of this workstream. Retry the call.',
  [PermissionChoice.AllowProject]: 'always allowed in this project. Retry the call.',
  [PermissionChoice.Deny]: 'denied. Do not retry it; find another way or ask with ask_human.',
};

/** A permission card answered while the workstream was parked, as prompt text plus any one-time allowance. */
function permissionAnswer(item: InboxItemDto): { prompt: { question: string; answer: string; note: string | null }; allowOnce: { toolName: string; summary: string } | null } | null {
  const toolName = item.detail?.['toolName'];
  const summary = item.detail?.['summary'];
  if (!item.answer || typeof toolName !== 'string' || typeof summary !== 'string') return null;
  return {
    prompt: { question: `${item.title} ${summary}`, answer: PERMISSION_ANSWER_TEXT[item.answer.choice] ?? item.answer.choice, note: item.answer.note ?? null },
    allowOnce: item.answer.choice === PermissionChoice.AllowOnce ? { toolName, summary } : null,
  };
}

interface Control {
  readonly fence: number;
  readonly provider: Provider;
  stopReason: StopReason | null;
  handle: SessionHandle | null;
  /** Set while the gate runs; aborting it kills the gate's process group. */
  gateAbort: AbortController | null;
  done: Promise<void>;
}

/** Per-session mutable state, kept in one object so callbacks and the event loop share it. */
interface SessionState {
  providerSessionId: string | null;
  handoffRequested: boolean;
  firmSent: boolean;
  parkedFor: InboxItemId | null;
  waits: number;
  waitTimer: Timer | null;
  outcome: Outcome | null;
}

export function createRunner(opts: RunnerOptions): Runner {
  const db = opts.state.db;
  const active = new Map<WorkstreamId, Control>();
  let idleWaiters: (() => void)[] = [];
  const identify = async (pid: number | null): Promise<string | null> => (pid === null || !opts.identifyProcess ? null : opts.identifyProcess(pid));

  function freshAction(id: WorkstreamId): NextAction {
    const latest = latestHandoff(db, id);
    return latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' };
  }

  function cancelNow(id: WorkstreamId, fence: number | null): void {
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, { to: S.Cancelled, fence, patch: { currentSessionId: null }, reason: 'cancelled by the builder' });
      releaseClaims(ctx, id);
      clearLease(ctx, id);
    });
    opts.inbox.cancelForWorkstream(id);
  }

  function fail(id: WorkstreamId, fence: number, reason: string): void {
    const row = getWorkstreamRow(db, id);
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, { to: S.Failed, fence, patch: { failureReason: reason, currentSessionId: null }, reason });
      releaseClaims(ctx, id);
      clearLease(ctx, id);
    });
    opts.inbox.flag({ projectId: row.projectId, workstreamId: id, title: `Workstream failed: ${getTask(db, row.taskId).title}`, body: reason });
  }

  /**
   * Parks on `inboxId`, whatever state the workstream reached meanwhile. An answer that landed while
   * the session was stopping is already on the card, so the workstream re-queues with it right away.
   */
  function park(id: WorkstreamId, fence: number, inboxId: InboxItemId, providerSessionId: string | null): void {
    const nextAction: NextAction = { kind: 'answer', inboxId, providerSessionId };
    const answered = getInboxItem(db, inboxId).answer !== null;
    opts.state.write((ctx) => {
      const current = getWorkstreamRow(ctx.tx, id).state;
      if (current === S.Running || current === S.HandingOff) transitionWorkstream(ctx, id, { to: S.WaitingHuman, fence, reason: `parking on ${inboxId}` });
      if (answered) transitionWorkstream(ctx, id, { to: S.Queued, fence, patch: { nextAction }, reason: 'answered while parking' });
      else patchWorkstream(ctx, id, fence, { nextAction });
      clearLease(ctx, id);
    });
  }

  function settle(id: WorkstreamId, ctl: Control, outcome: Terminal): void {
    const row = getWorkstreamRow(db, id);
    if (row.state === S.WaitingHuman && outcome.kind !== 'parked' && !(outcome.kind === 'stopped' && outcome.reason === 'cancelled')) {
      const open = openItemsForWorkstream(db, id)[0];
      if (open) {
        park(id, ctl.fence, open.id, outcome.providerSessionId);
        return;
      }
    }
    switch (outcome.kind) {
      case 'stopped':
        if (outcome.reason === 'cancelled') cancelNow(id, ctl.fence);
        if (outcome.reason === 'paused') settle(id, ctl, { kind: 'paused', until: null, providerSessionId: outcome.providerSessionId });
        return;
      case 'paused': {
        const nextAction: NextAction = outcome.providerSessionId ? { kind: 'resume', providerSessionId: outcome.providerSessionId, reason: 'the usage limit reset' } : freshAction(id);
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, { to: S.PausedLimit, fence: ctl.fence, patch: { nextAction, pausedUntil: outcome.until?.toISOString() ?? null }, reason: 'usage limit' });
          clearLease(ctx, id);
        });
        return;
      }
      case 'parked':
        park(id, ctl.fence, outcome.inboxId, outcome.providerSessionId);
        return;
      case 'crashed': {
        const attempts = row.recoveryAttempts + 1;
        if (attempts > opts.limits.maxRecoveryAttempts) {
          fail(id, ctl.fence, `The session failed ${String(attempts)} times; last error: ${outcome.message}`);
          return;
        }
        const nextAction = nextActionAfterCrash(row.nextAction, outcome.providerSessionId, latestHandoff(db, id));
        opts.state.write((ctx) => {
          transitionWorkstream(ctx, id, { to: S.Recovering, fence: ctl.fence, reason: outcome.message.slice(0, 200) });
          transitionWorkstream(ctx, id, { to: S.Queued, fence: ctl.fence, patch: { nextAction, recoveryAttempts: attempts }, reason: 'retrying after a crash' });
          clearLease(ctx, id);
        });
      }
    }
  }

  async function runSession(id: WorkstreamId, ctl: Control): Promise<Outcome> {
    const row = getWorkstreamRow(db, id);
    const project = getProject(db, row.projectId);
    const task = getTask(db, row.taskId);
    const action = row.nextAction;
    const baseHead = row.baseHead ?? (await opts.git.head(project.repoPath));
    const answeredItem = action.kind === 'answer' ? getInboxItem(db, action.inboxId) : null;
    const resumeId = action.kind === 'resume' || action.kind === 'answer' ? action.providerSessionId : null;
    const claims = () => activeClaims(db, id).map((c) => ({ kind: c.kind, name: c.name }));
    const permission = answeredItem?.kind === InboxKind.Permission ? permissionAnswer(answeredItem) : null;
    const prompt = buildSessionPrompt({
      task,
      claims: claims(),
      action,
      handoff: action.kind === 'continue_from_handoff' ? getHandoff(db, action.handoffId) : null,
      answer: permission?.prompt ?? (answeredItem?.answer ? { question: answeredItem.title, answer: answeredItem.answer.choice, note: answeredItem.answer.note ?? null } : null),
      evidence: action.kind === 'fix' ? getEvidence(db, action.evidenceId) : null,
      recovery: action.kind === 'resume' ? { reason: action.reason, lastOp: latestToolOp(db, id)?.opId ?? null } : null,
    });
    const { token, hash } = mintSessionToken();
    const session = opts.state.write((ctx) => {
      const s = insertSession(ctx, { workstreamId: id, provider: project.provider, model: row.model, effort: row.effort, mode: 'managed', mcpTokenHash: hash });
      patchWorkstream(ctx, id, ctl.fence, { currentSessionId: s.id, baseHead });
      return s;
    });

    const abort = new AbortController();
    const st: SessionState = { providerSessionId: resumeId, handoffRequested: false, firmSent: false, parkedFor: null, waits: 0, waitTimer: null, outcome: null };
    const log = opts.logger.child({ workstreamId: id, sessionId: session.id });
    let handle: SessionHandle | null = null;

    const observer: WaitObserver = {
      onWaitStart(item) {
        st.waits += 1;
        if (st.waits > 1) return;
        opts.state.write((ctx) => {
          // A session can ask before its `started` event is processed; STARTING has no edge to WAITING_HUMAN.
          if (getWorkstreamRow(ctx.tx, id).state === S.Starting) transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
          transitionWorkstream(ctx, id, { to: S.WaitingHuman, fence: ctl.fence, reason: `waiting on ${item.id}` });
        });
        st.waitTimer = opts.clock.setTimeout(() => {
          st.parkedFor = item.id;
          // Abort the waits first: an answer that arrives while the session is still stopping then goes
          // through onParkedAnswer and the card, instead of to a waiter that is about to disappear.
          abort.abort();
          void handle?.stop();
        }, project.humanWaitMinutes * 60_000);
      },
      onWaitEnd() {
        st.waits = Math.max(0, st.waits - 1);
        if (st.waits > 0) return;
        st.waitTimer?.cancel();
        st.waitTimer = null;
        opts.state.write((ctx) => transitionWorkstream(ctx, id, { to: st.handoffRequested ? S.HandingOff : S.Running, fence: ctl.fence, reason: 'answered' }));
      },
    };

    opts.live.register(session.id, { signal: abort.signal, observer });
    handle = opts.adapter.start({
      sessionId: session.id,
      workstreamId: id,
      sequence: session.sequence,
      cwd: project.repoPath,
      prompt,
      model: row.model,
      effort: row.effort,
      resumeProviderSessionId: resumeId,
      env: opts.sessionEnv(project),
      allowedTools: baseAllowedTools(project),
      mcp: { url: opts.mcpUrl(), token, toolTimeoutMs: (project.humanWaitMinutes + 5) * 60_000 },
      preToolUse: (req) => judgeToolUse({ toolName: req.toolName, toolInput: req.input, repoPath: project.repoPath, areas: project.areas, hazards: project.hazards, claims: claims() }),
      canUseTool: createPermissionBroker(
        { state: opts.state, inbox: opts.inbox },
        { projectId: project.id, workstreamId: id, sessionId: session.id, observer, signal: abort.signal, allowOnce: permission?.allowOnce ?? null },
      ),
    });
    ctl.handle = handle;

    for await (const event of handle.events) {
      switch (event.type) {
        case 'started': {
          st.providerSessionId = event.providerSessionId;
          const pidStart = await identify(event.pid);
          opts.state.write((ctx) => {
            markSessionStarted(ctx, session.id, event.providerSessionId, event.pid, pidStart);
            const current = getWorkstreamRow(ctx.tx, id).state;
            if (current === S.Starting || current === S.HandingOff) transitionWorkstream(ctx, id, { to: S.Running, fence: ctl.fence });
          });
          break;
        }
        case 'activity':
          opts.state.write((ctx) => {
            patchWorkstream(ctx, id, ctl.fence, { lastActivityAt: ctx.now });
            ctx.emit({ type: EventType.SessionActivity, entityType: 'session', entityId: session.id, data: { workstreamId: id, kind: event.kind, summary: event.summary.slice(0, 500) } });
          });
          break;
        case 'context':
          opts.state.write((ctx) => {
            updateSessionUsage(ctx, session.id, { contextPct: event.percentage });
            patchWorkstream(ctx, id, ctl.fence, { contextPct: event.percentage });
            ctx.emit({ type: EventType.SessionContext, entityType: 'session', entityId: session.id, data: { workstreamId: id, percentage: event.percentage } });
          });
          if (!st.handoffRequested && event.percentage >= project.handoffPct) {
            st.handoffRequested = true;
            opts.state.write((ctx) => {
              if (getWorkstreamRow(ctx.tx, id).state === S.Running) {
                transitionWorkstream(ctx, id, { to: S.HandingOff, fence: ctl.fence, reason: `context at ${String(event.percentage)}%` });
              }
            });
            handle.send(HANDOFF_NUDGE);
          } else if (st.handoffRequested && !st.firmSent && event.percentage >= project.nudgePct) {
            st.firmSent = true;
            handle.send(HANDOFF_FIRM_NUDGE);
          }
          break;
        case 'compacted':
          opts.state.write((ctx) => {
            const sourceId = insertSource(ctx, 'daemon', { sessionId: session.id });
            insertDeviation(ctx, { projectId: project.id, workstreamId: id, cause: `emergency compaction (${event.trigger})`, severity: 'warn', signedReason: 'Context ran out before a handoff (10db)', sourceId });
          });
          handle.send(compactionReinjection(buildContextPack(db, getWorkstream(db, id))));
          break;
        case 'rate_limit':
          if (event.status === 'rejected' && !st.outcome) {
            st.outcome = { kind: 'paused', until: event.resetsAt, providerSessionId: st.providerSessionId };
            opts.onRateLimited(project.provider, event.resetsAt, project.id);
          }
          break;
        case 'turn_complete': {
          opts.state.write((ctx) => { updateSessionUsage(ctx, session.id, { inputTokens: event.inputTokens, outputTokens: event.outputTokens, costUsd: event.costUsd }); });
          const recorded = handoffForSession(db, session.id);
          if (recorded) {
            st.outcome = { kind: 'handoff', handoffId: recorded.id };
            await handle.stop();
          } else if (st.handoffRequested && !st.firmSent) {
            st.firmSent = true;
            handle.send(HANDOFF_FIRM_NUDGE);
          } else {
            st.outcome = { kind: 'step_done', withoutHandoff: st.handoffRequested };
            await handle.stop();
          }
          break;
        }
        case 'ended':
          if (st.outcome) break;
          if (ctl.stopReason) st.outcome = { kind: 'stopped', reason: ctl.stopReason, providerSessionId: st.providerSessionId };
          else if (st.parkedFor) st.outcome = { kind: 'parked', inboxId: st.parkedFor, providerSessionId: st.providerSessionId };
          else if (event.reason === 'rate_limited') {
            st.outcome = { kind: 'paused', until: null, providerSessionId: st.providerSessionId };
            opts.onRateLimited(project.provider, null, project.id);
          } else if (event.reason === 'error' || event.reason === 'stopped') {
            st.outcome = { kind: 'crashed', message: event.message ?? 'the session stopped unexpectedly', providerSessionId: st.providerSessionId };
          } else st.outcome = { kind: 'step_done', withoutHandoff: st.handoffRequested };
          break;
      }
    }

    st.waitTimer?.cancel();
    abort.abort();
    opts.live.unregister(session.id);
    ctl.handle = null;
    const outcome: Outcome = st.outcome ?? { kind: 'crashed', message: 'the session ended without an outcome', providerSessionId: st.providerSessionId };
    const progressed = outcome.kind === 'handoff' || outcome.kind === 'step_done';
    opts.state.write((ctx) => {
      endSession(ctx, session.id, outcome.kind === 'stopped' && outcome.reason === 'shutdown' ? 'shutdown' : outcome.kind);
      patchWorkstream(ctx, id, ctl.fence, {
        currentSessionId: null,
        // Progress resets the crash count, so the limit counts consecutive failures (spec §5.4).
        ...(progressed ? { recoveryAttempts: 0 } : {}),
        ...(outcome.kind === 'handoff' ? { nextAction: { kind: 'continue_from_handoff', handoffId: outcome.handoffId } } : {}),
      });
    });
    log.info({ outcome: outcome.kind }, 'session ended');
    return outcome;
  }

  async function verify(id: WorkstreamId, ctl: Control): Promise<void> {
    if (getWorkstreamRow(db, id).state !== S.Verifying) {
      opts.state.write((ctx) => transitionWorkstream(ctx, id, { to: S.Verifying, fence: ctl.fence, patch: { nextAction: { kind: 'verify' } } }));
    }
    const row = getWorkstreamRow(db, id);
    const project = getProject(db, row.projectId);
    const run = listEvidence(db, id).filter((e) => e.kind === 'gate').length + 1;
    const gateAbort = new AbortController();
    ctl.gateAbort = gateAbort;
    if (ctl.stopReason === 'cancelled' || ctl.stopReason === 'shutdown') gateAbort.abort();
    let recording: Promise<void> = Promise.resolve();
    const result = await opts.gate.run({
      repo: project.repoPath,
      command: project.gateCommand,
      logPath: join(opts.dataDir, 'logs', 'gate', `${id}-${String(run)}.log`),
      timeoutMs: opts.limits.gateTimeoutMs,
      env: { ...process.env, ...opts.sessionEnv(project) },
      signal: gateAbort.signal,
      onSpawn: (pid) => {
        recording = identify(pid).then((gatePidStart) => {
          if (gatePidStart !== null) opts.state.write((ctx) => { patchWorkstream(ctx, id, ctl.fence, { gatePid: pid, gatePidStart }); });
        });
      },
    });
    ctl.gateAbort = null;
    await recording.catch(() => undefined);
    opts.state.write((ctx) => { patchWorkstream(ctx, id, ctl.fence, { gatePid: null, gatePidStart: null }); });
    if (ctl.stopReason === 'cancelled') {
      cancelNow(id, ctl.fence);
      return;
    }
    // Shutdown killed the gate: record nothing. The workstream stays VERIFYING and recovery re-runs it.
    if (result.aborted) return;
    const head = await opts.git.head(project.repoPath);
    const commitShas = await opts.git.commitsSince(project.repoPath, row.baseHead ?? head);
    const evidence = { workstreamId: id, kind: 'gate' as const, command: project.gateCommand, exitCode: result.exitCode, summary: result.tail.slice(-2000), logPath: result.logPath, commitShas };
    if (result.exitCode === 0) {
      opts.state.write((ctx) => {
        insertEvidence(ctx, evidence);
        transitionWorkstream(ctx, id, { to: S.Done, fence: ctl.fence, reason: 'gate passed' });
        setTaskStatus(ctx, row.taskId, 'done');
        releaseClaims(ctx, id);
        clearLease(ctx, id);
        // Spec §7: a Review card tells the builder verified work is ready to look at.
        insertInboxItem(ctx, {
          projectId: project.id,
          kind: 'review',
          title: `Review: ${getTask(ctx.tx, row.taskId).title}`,
          body: `Gate passed with ${String(commitShas.length)} commit(s).`,
          options: [{ label: 'accept', description: 'Looks good' }],
          recommendation: null,
          category: 'product',
          urgency: 'low',
          detail: { workstreamId: id, commits: commitShas },
          foldKey: null,
          targets: [],
        });
      });
      return;
    }
    const attempt = row.attempt + 1;
    const evidenceId = opts.state.write((ctx) => insertEvidence(ctx, evidence).id);
    if (attempt > opts.limits.maxFixAttempts) {
      fail(id, ctl.fence, `The gate failed ${String(attempt)} times (last exit ${String(result.exitCode)})`);
      return;
    }
    opts.state.write((ctx) => {
      transitionWorkstream(ctx, id, { to: S.Queued, fence: ctl.fence, patch: { nextAction: { kind: 'fix', evidenceId }, attempt }, reason: `gate exit ${String(result.exitCode)}` });
      clearLease(ctx, id);
    });
  }

  async function run(id: WorkstreamId, ctl: Control): Promise<void> {
    try {
      for (;;) {
        if (ctl.stopReason) return;
        const row = getWorkstreamRow(db, id);
        if (row.nextAction.kind === 'verify' || row.state === S.Verifying) {
          await verify(id, ctl);
          return;
        }
        const outcome = await runSession(id, ctl);
        if (outcome.kind === 'handoff') continue;
        if (outcome.kind === 'step_done') {
          if (outcome.withoutHandoff) {
            const row = getWorkstreamRow(db, id);
            opts.inbox.flag({ projectId: row.projectId, workstreamId: id, title: 'Session ended without the requested handoff', body: 'The agent ended its turn twice after being asked for a handoff; 10db is verifying the work as it stands.' });
          }
          opts.state.write((ctx) =>
            transitionWorkstream(ctx, id, {
              to: S.Verifying,
              fence: ctl.fence,
              patch: { nextAction: { kind: 'verify' } },
              reason: outcome.withoutHandoff ? 'turn ended without the requested handoff' : 'step complete',
            }),
          );
          continue;
        }
        settle(id, ctl, outcome);
        return;
      }
    } catch (error) {
      if (error instanceof StaleFenceError) {
        opts.logger.warn({ workstreamId: id }, 'runner fenced off by a newer lease; stopping');
        await ctl.handle?.stop();
        return;
      }
      opts.logger.error({ workstreamId: id, err: error instanceof Error ? error.message : String(error) }, 'runner failed');
      try {
        settle(id, ctl, { kind: 'crashed', message: error instanceof Error ? error.message : String(error), providerSessionId: null });
      } catch (inner) {
        opts.logger.error({ workstreamId: id, err: String(inner) }, 'could not record the runner failure');
      }
    }
  }

  const runner: Runner = {
    launch(id, fence) {
      if (active.has(id)) return;
      const ctl: Control = { fence, provider: getProject(db, getWorkstreamRow(db, id).projectId).provider, stopReason: null, handle: null, gateAbort: null, done: Promise.resolve() };
      active.set(id, ctl);
      ctl.done = run(id, ctl).finally(() => {
        active.delete(id);
        opts.onLaneFreed();
        if (active.size === 0) {
          const waiters = idleWaiters;
          idleWaiters = [];
          for (const w of waiters) w();
        }
      });
    },
    async stop(id, reason) {
      const ctl = active.get(id);
      if (!ctl) return;
      ctl.stopReason = reason;
      // A pause only stops sessions; a running gate doesn't use the provider, so let it finish.
      if (reason !== 'paused') ctl.gateAbort?.abort();
      await ctl.handle?.stop();
      await ctl.done;
    },
    async cancel(id) {
      if (active.has(id)) await runner.stop(id, 'cancelled');
      else cancelNow(id, null);
    },
    async stopProvider(provider, reason) {
      // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Provider has one member in M1; the filter matters once there are two.
      const matching = [...active.entries()].filter(([, c]) => c.provider === provider);
      await Promise.all(matching.map(([id]) => runner.stop(id, reason)));
    },
    async stopAll(reason) {
      await Promise.all([...active.keys()].map((id) => runner.stop(id, reason)));
    },
    isRunning: (id) => active.has(id),
    idle: () => (active.size === 0 ? Promise.resolve() : new Promise((r) => idleWaiters.push(r))),
    deliverParkedAnswer(target, item) {
      const row = getWorkstreamRow(db, target.workstreamId);
      if (row.state !== S.WaitingHuman || row.currentSessionId !== null) return;
      const providerSessionId = row.nextAction.kind === 'answer' ? row.nextAction.providerSessionId : null;
      opts.state.write((ctx) =>
        transitionWorkstream(ctx, row.id, { to: S.Queued, fence: null, patch: { nextAction: { kind: 'answer', inboxId: item.id, providerSessionId } }, reason: 'answer arrived' }),
      );
      opts.onLaneFreed();
    },
  };
  return runner;
}
```
Two things to watch while implementing:
- **`stop` on a parked or stopped handle** awaits `handle.stop()` inside the `for await` loop. That is safe: the channel buffers the `ended` event, and `stop()` resolves without needing a consumer.
- **The `settle` switch exhaustiveness.** The switch has no `default`, so the linter's exhaustiveness rule checks it. Keep it that way.

`apps/daemon/src/runner/index.ts`:
```ts
export { createLiveSessions, type LiveSession, type LiveSessions } from './live-sessions';
export { nextActionAfterCrash } from './next-action';
export { createRunner, DEFAULT_RUNNER_LIMITS, type Runner, type RunnerLimits, type RunnerOptions, type StopReason } from './runner';
```

- [ ] **Step 6: Run, check, commit**

```bash
pnpm vitest run --project daemon runner next-action
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/runner apps/daemon/test && git commit -m 'feat(daemon): add the workstream runner with handoff, waits, verification and crash paths'
```
Expected: all runner tests PASS. If a test hangs, a session never emitted `ended`. Check the fake script ends in `turn_complete`, `end`, `crash`, or a stop.

---

### Task 17: Scheduler, leases and provider pauses

**Files:**
- Create: `packages/db/src/store/settings.ts` (export from the store index)
- Create: `apps/daemon/src/scheduler/scheduler.ts`, `scheduler/provider-pauses.ts`, `scheduler/index.ts`
- Test: `apps/daemon/src/scheduler/scheduler.test.ts`, `apps/daemon/src/scheduler/provider-pauses.test.ts`

**Interfaces:**
- Produces:
  - **Settings** (`@10db/db`): `getAppSetting(db, key): Json | undefined`, `setAppSetting(ctx, key, value: Json)`, `deleteAppSetting(ctx, key)`.
  - **Provider pauses** (`scheduler/index.ts`):
    - `interface ProviderPauses { pause(provider, until: Date | null, projectId): void; isPaused(provider): boolean; restore(): void; stop(): void }`
    - `createProviderPauses({ state, clock, inbox, stopProvider(provider): Promise<void>, onResume(), defaultPauseMs })`. A pause with no reset time lasts `defaultPauseMs`, which is 30 minutes.
  - **Scheduler** (`scheduler/index.ts`):
    - `interface Scheduler { requestTick(): void; tick(): number; start(): void; stop(): void }`. `requestTick()` does nothing until `start()`, so nothing launches while startup recovery and `pauses.restore()` are still running.
    - `createScheduler({ state, runner: Pick<Runner, 'launch'>, pauses: Pick<ProviderPauses, 'isPaused'>, clock, instanceId, caps: { global; perProvider }, leaseMs, tickMs, logger })`. The default caps are `{ global: 4, perProvider: 4 }` (spec §15), and the defaults are `leaseMs: 60_000` and `tickMs: 2_000`.
  - **`tick()`.** It walks QUEUED workstreams, oldest first. It skips paused providers, full caps (global, project `maxLanes`, provider), unfinished dependencies and claim conflicts. Otherwise it acquires claims, leases and STARTING in one transaction, then calls `runner.launch(id, fence)`.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/scheduler/scheduler.test.ts`:
```ts
import type { WorkstreamId } from '@10db/contracts';
import { createTestStore, getWorkstream, getWorkstreamRow, insertTask, insertWorkstream, releaseClaims, seedProject, transitionWorkstream, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { silentLogger } from '../log';
import { createScheduler } from './index';

let store: Store;
let close: () => void;
let state: StateStore;
let clock: ManualClock;
let launched: { id: WorkstreamId; fence: number }[];
let paused: Set<string>;

beforeEach(() => {
  ({ store, close } = createTestStore());
  state = createStateStore(store, createEventBus());
  clock = new ManualClock();
  launched = [];
  paused = new Set();
});
afterEach(() => { close(); });

function scheduler(caps = { global: 4, perProvider: 4 }) {
  return createScheduler({
    state, clock, caps, instanceId: 'daemon-1', leaseMs: 60_000, tickMs: 2_000, logger: silentLogger,
    runner: { launch: (id, fence) => { launched.push({ id, fence }); } },
    pauses: { isPaused: (p) => paused.has(p) },
  });
}

function queue(projectOverrides = {}, areas = ['api'], dependsOn: Parameters<typeof insertTask>[2]['dependsOn'] = []) {
  const project = seedProject(store, projectOverrides);
  return add(project, areas, dependsOn);
}
function add(project: ReturnType<typeof seedProject>, areas: string[], dependsOn: Parameters<typeof insertTask>[2]['dependsOn'] = []) {
  const task = state.write((ctx) => insertTask(ctx, project.id, { title: 't', acceptanceCriteria: ['x'], areas, dependsOn }));
  return { project, task, workstream: state.write((ctx) => insertWorkstream(ctx, task.id)) };
}

describe('scheduler', () => {
  it('respects the global cap', () => {
    queue(); queue(); queue();
    expect(scheduler({ global: 2, perProvider: 4 }).tick()).toBe(2);
    expect(launched).toHaveLength(2);
  });

  it('respects a project lane limit and the provider cap', () => {
    const a = queue({ maxLanes: 1 });
    add(a.project, ['ui']);
    queue();
    expect(scheduler({ global: 4, perProvider: 2 }).tick()).toBe(2);
    expect(launched.map((l) => getWorkstreamRow(store.db, l.id).projectId).filter((p) => p === a.project.id)).toHaveLength(1);
  });

  it('waits for dependencies', () => {
    const a = queue();
    add(a.project, ['ui'], [a.task.id]);
    scheduler().tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
  });

  it('serializes workstreams that claim the same area', () => {
    const a = queue();
    const b = add(a.project, ['api']);
    const s = scheduler();
    s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id]);
    state.write((ctx) => {
      for (const to of ['RUNNING', 'VERIFYING', 'DONE'] as const) transitionWorkstream(ctx, a.workstream.id, { to, fence: null });
      releaseClaims(ctx, a.workstream.id);
    });
    s.tick();
    expect(launched.map((l) => l.id)).toEqual([a.workstream.id, b.workstream.id]);
  });

  it('skips a paused provider', () => {
    queue();
    paused.add('claude');
    expect(scheduler().tick()).toBe(0);
  });

  it('ignores requestTick until it is started', async () => {
    queue();
    const s = scheduler();
    s.requestTick();
    await Promise.resolve();
    expect(launched).toHaveLength(0);
    s.start();
    s.requestTick();
    await Promise.resolve();
    expect(launched).toHaveLength(1);
    s.stop();
  });

  it('leases with a fresh fence and renews the lease on the heartbeat', () => {
    const a = queue();
    const s = scheduler();
    s.tick();
    expect(launched[0]?.fence).toBe(1);
    expect(getWorkstream(store.db, a.workstream.id).state).toBe('STARTING');
    const before = getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt;
    s.start();
    clock.advance(20_000);
    s.stop();
    expect(getWorkstreamRow(store.db, a.workstream.id).leaseExpiresAt).not.toBe(before);
  });
});
```

`apps/daemon/src/scheduler/provider-pauses.test.ts`:
```ts
import { createTestStore, getWorkstream, listInbox, transitionWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { seedWorkstream } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createInboxService } from '../inbox';
import { createProviderPauses } from './index';

let close: () => void;
let base: ReturnType<typeof createTestStore>['store'];
let state: StateStore;
let clock: ManualClock;
let stopped: string[];
let resumed: number;

beforeEach(() => {
  const t = createTestStore();
  base = t.store;
  close = t.close;
  state = createStateStore(t.store, createEventBus());
  clock = new ManualClock();
  stopped = [];
  resumed = 0;
});
afterEach(() => { close(); });

function pauses() {
  return createProviderPauses({
    state, clock,
    inbox: createInboxService({ state, onParkedAnswer: () => undefined }),
    stopProvider: (p) => { stopped.push(p); return Promise.resolve(); },
    onResume: () => { resumed += 1; },
    defaultPauseMs: 30 * 60_000,
  });
}

describe('provider pauses', () => {
  it('pauses once, raises one notice, and re-queues paused work at the reset', () => {
    const { project, workstream } = seedWorkstream(base);
    state.write((ctx) => {
      transitionWorkstream(ctx, workstream.id, { to: 'STARTING', fence: null });
      transitionWorkstream(ctx, workstream.id, { to: 'PAUSED_LIMIT', fence: null });
    });
    const p = pauses();
    const reset = new Date(clock.now().getTime() + 10 * 60_000);
    p.pause('claude', reset, project.id);
    p.pause('claude', reset, project.id);
    expect(p.isPaused('claude')).toBe(true);
    expect(stopped).toEqual(['claude', 'claude']);
    expect(listInbox(state.db, { states: ['OPEN'] })).toHaveLength(1);

    clock.advance(10 * 60_000);
    expect(p.isPaused('claude')).toBe(false);
    expect(getWorkstream(state.db, workstream.id).state).toBe('QUEUED');
    expect(resumed).toBe(1);
  });

  it('uses the default length when no reset time is known', () => {
    const { project } = seedWorkstream(base);
    const p = pauses();
    p.pause('claude', null, project.id);
    clock.advance(29 * 60_000);
    expect(p.isPaused('claude')).toBe(true);
    clock.advance(2 * 60_000);
    expect(p.isPaused('claude')).toBe(false);
  });

  it('restores a persisted pause after a restart', () => {
    const { project } = seedWorkstream(base);
    pauses().pause('claude', new Date(clock.now().getTime() + 5 * 60_000), project.id);
    const restarted = pauses();
    restarted.restore();
    expect(restarted.isPaused('claude')).toBe(true);
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm vitest run --project daemon scheduler provider-pauses
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`packages/db/src/store/settings.ts`:
```ts
import { eq } from 'drizzle-orm';
import * as schema from '../schema';
import type { DbReader, Json, WriteContext } from './store';

export function getAppSetting(db: DbReader, key: string): Json | undefined {
  return db.select({ value: schema.appSettings.value }).from(schema.appSettings).where(eq(schema.appSettings.key, key)).get()?.value as Json | undefined;
}

export function setAppSetting(ctx: WriteContext, key: string, value: Json): void {
  ctx.tx.insert(schema.appSettings).values({ key, value, updatedAt: ctx.now }).onConflictDoUpdate({ target: schema.appSettings.key, set: { value, updatedAt: ctx.now } }).run();
}

export function deleteAppSetting(ctx: WriteContext, key: string): void {
  ctx.tx.delete(schema.appSettings).where(eq(schema.appSettings.key, key)).run();
}
```
Add `export * from './settings';` to the store index. The `as Json` is the boundary: `app_settings.value` is untyped JSON, and readers validate it with zod.

`apps/daemon/src/scheduler/provider-pauses.ts`:
```ts
import { EventType, Provider, WorkstreamState, type ProjectId } from '@10db/contracts';
import { deleteAppSetting, getAppSetting, getProject, listWorkstreams, setAppSetting, transitionWorkstream } from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { InboxService } from '../inbox';

export interface ProviderPauses {
  pause(provider: Provider, until: Date | null, projectId: ProjectId): void;
  isPaused(provider: Provider): boolean;
  /** Re-arms pauses persisted before a restart. */
  restore(): void;
  stop(): void;
}

const PauseSetting = z.object({ until: z.iso.datetime() });
const key = (provider: Provider) => `provider_pause.${provider}`;

/** A usage limit pauses every lane on that provider until the reset time (spec §5.4). */
export function createProviderPauses(opts: {
  readonly state: StateStore;
  readonly clock: Clock;
  readonly inbox: InboxService;
  stopProvider(provider: Provider): Promise<void>;
  onResume(): void;
  readonly defaultPauseMs: number;
}): ProviderPauses {
  const until = new Map<Provider, Date>();
  const timers = new Map<Provider, Timer>();

  function resume(provider: Provider): void {
    until.delete(provider);
    timers.delete(provider);
    opts.state.write((ctx) => {
      deleteAppSetting(ctx, key(provider));
      for (const ws of listWorkstreams(ctx.tx, { states: [WorkstreamState.PausedLimit] })) {
        // eslint-disable-next-line @typescript-eslint/no-unnecessary-condition -- Provider has one member in M1; the check matters once there are two.
        if (getProject(ctx.tx, ws.projectId).provider !== provider) continue;
        transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Queued, fence: null, patch: { pausedUntil: null }, reason: 'usage limit reset' });
      }
      ctx.emit({ type: EventType.ProviderResumed, entityType: 'provider', entityId: provider });
    });
    opts.onResume();
  }

  function arm(provider: Provider, at: Date): void {
    timers.get(provider)?.cancel();
    until.set(provider, at);
    timers.set(provider, opts.clock.setTimeout(() => { resume(provider); }, Math.max(0, at.getTime() - opts.clock.now().getTime())));
  }

  return {
    pause(provider, reportedUntil, projectId) {
      const now = opts.clock.now();
      const at = reportedUntil && reportedUntil > now ? reportedUntil : new Date(now.getTime() + opts.defaultPauseMs);
      const current = until.get(provider);
      if (!current || at > current) {
        arm(provider, at);
        opts.state.write((ctx) => {
          setAppSetting(ctx, key(provider), { until: at.toISOString() });
          ctx.emit({ type: EventType.ProviderPaused, entityType: 'provider', entityId: provider, data: { until: at.toISOString() } });
        });
        opts.inbox.flag({
          projectId,
          workstreamId: null,
          title: `${provider} usage limit reached`,
          body: `Every lane on ${provider} is paused until ${at.toISOString()}. Work resumes automatically.`,
          foldKey: `provider-pause:${provider}`,
        });
      }
      void opts.stopProvider(provider);
    },
    isPaused: (provider) => until.has(provider),
    restore() {
      for (const provider of Object.values(Provider)) {
        const parsed = PauseSetting.safeParse(getAppSetting(opts.state.db, key(provider)));
        if (!parsed.success) continue;
        const at = new Date(parsed.data.until);
        if (at > opts.clock.now()) arm(provider, at);
        else resume(provider);
      }
    },
    stop() {
      for (const timer of timers.values()) timer.cancel();
      timers.clear();
    },
  };
}
```

`apps/daemon/src/scheduler/scheduler.ts`:
```ts
import { isTerminal, WorkstreamState, type Provider, type WorkstreamId } from '@10db/contracts';
import {
  acquireClaims,
  acquireLease,
  claimRequestsForTask,
  countLanes,
  dependenciesDone,
  getProject,
  getTask,
  listWorkstreams,
  renewClaimLeases,
  renewLeases,
  transitionWorkstream,
} from '@10db/db';
import type { Clock, Timer } from '../clock';
import type { StateStore } from '../events';
import type { Logger } from '../log';

export interface SchedulerOptions {
  readonly state: StateStore;
  readonly runner: { launch(id: WorkstreamId, fence: number): void };
  readonly pauses: { isPaused(provider: Provider): boolean };
  readonly clock: Clock;
  readonly instanceId: string;
  readonly caps: { readonly global: number; readonly perProvider: number };
  readonly leaseMs: number;
  readonly tickMs: number;
  readonly logger: Logger;
}

export interface Scheduler {
  requestTick(): void;
  /** Launches what fits now; returns how many were launched. */
  tick(): number;
  start(): void;
  stop(): void;
}

export const DEFAULT_CAPS = { global: 4, perProvider: 4 } as const;

export function createScheduler(opts: SchedulerOptions): Scheduler {
  const db = opts.state.db;
  let timer: Timer | null = null;
  let pending = false;
  let started = false;

  function tick(): number {
    const lanes = countLanes(db);
    let global = lanes.global;
    const byProject = new Map(lanes.byProject);
    const byProvider = new Map(lanes.byProvider);
    let launched = 0;
    for (const ws of listWorkstreams(db, { states: [WorkstreamState.Queued] })) {
      if (global >= opts.caps.global) break;
      const project = getProject(db, ws.projectId);
      if (opts.pauses.isPaused(project.provider)) continue;
      if ((byProject.get(project.id) ?? 0) >= project.maxLanes) continue;
      if ((byProvider.get(project.provider) ?? 0) >= opts.caps.perProvider) continue;
      if (!dependenciesDone(db, ws.taskId)) continue;
      const task = getTask(db, ws.taskId);
      const leaseUntil = new Date(opts.clock.now().getTime() + opts.leaseMs).toISOString();
      const fence = opts.state.write((ctx) => {
        const claimed = acquireClaims(ctx, { projectId: project.id, workstreamId: ws.id, requests: claimRequestsForTask(task, project), leaseExpiresAt: leaseUntil });
        if (!claimed.ok) return null;
        const f = acquireLease(ctx, ws.id, opts.instanceId, leaseUntil);
        transitionWorkstream(ctx, ws.id, { to: WorkstreamState.Starting, fence: f, reason: 'lane granted' });
        return f;
      });
      if (fence === null) continue;
      global += 1;
      byProject.set(project.id, (byProject.get(project.id) ?? 0) + 1);
      byProvider.set(project.provider, (byProvider.get(project.provider) ?? 0) + 1);
      launched += 1;
      opts.runner.launch(ws.id, fence);
    }
    return launched;
  }

  function heartbeat(): void {
    const leaseUntil = new Date(opts.clock.now().getTime() + opts.leaseMs).toISOString();
    opts.state.write((ctx) => {
      renewLeases(ctx, opts.instanceId, leaseUntil);
      const mine = listWorkstreams(ctx.tx).filter((w) => !isTerminal(w.state)).map((w) => w.id);
      renewClaimLeases(ctx, mine, leaseUntil);
    });
  }

  function loop(): void {
    try {
      heartbeat();
      tick();
    } catch (error) {
      opts.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'scheduler tick failed');
    }
    timer = opts.clock.setTimeout(loop, opts.tickMs);
  }

  return {
    tick,
    requestTick() {
      // Before start() the daemon is still recovering; the first loop and start's own tick cover it.
      if (pending || !started) return;
      pending = true;
      queueMicrotask(() => {
        pending = false;
        try {
          tick();
        } catch (error) {
          opts.logger.error({ err: error instanceof Error ? error.message : String(error) }, 'scheduler tick failed');
        }
      });
    },
    start() {
      started = true;
      timer ??= opts.clock.setTimeout(loop, opts.tickMs);
    },
    stop() {
      started = false;
      timer?.cancel();
      timer = null;
    },
  };
}
```

`apps/daemon/src/scheduler/index.ts`:
```ts
export { createProviderPauses, type ProviderPauses } from './provider-pauses';
export { createScheduler, DEFAULT_CAPS, type Scheduler, type SchedulerOptions } from './scheduler';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon scheduler provider-pauses
pnpm vitest run --project db
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/scheduler packages/db/src/store && git commit -m 'feat(daemon): add scheduler with lane caps, leases and fencing, and provider usage-limit pauses'
```

---

### Task 18: Startup recovery

**Files:**
- Create: `apps/daemon/src/recovery/recover.ts`, `recovery/processes.ts`, `recovery/index.ts`
- Test: `apps/daemon/src/recovery/recover.test.ts`

**Interfaces:**
- Produces, from `recovery/index.ts`:
  - `interface ProcessTerminator { identify(pid: number): Promise<string | null>; terminate(target: { pid: number; startedAt: string; group?: boolean }): Promise<'terminated' | 'not_running'> }` and `systemProcesses`.
    - `identify` returns the process's OS start time (`/bin/ps -o lstart= -p <pid>`, with `LC_ALL=C`), or `null` when no such process runs.
    - `terminate` signals only while the pid's start time still equals `startedAt`, so a PID reused after a reboot is never touched. It sends SIGTERM (to the group when `group` is set), then SIGKILL after 2 s. A process that exits in between (`ESRCH`) counts as `not_running`; it never throws.
  - `interface RecoveryReport { requeued: WorkstreamId[]; failed: WorkstreamId[]; parked: WorkstreamId[]; redelivered: InboxItemId[] }`
  - `recoverOnStartup({ state, inbox, git, processes, maxRecoveryAttempts, logger, cleanShutdown? }): Promise<RecoveryReport>`. `cleanShutdown` is true when the previous daemon stopped through `RunningDaemon.stop()` (Task 19); then re-queued work keeps its `recoveryAttempts` instead of counting a failed attempt.
- Behavior (spec §5.4, Recovery):
  - **Every non-terminal workstream.** It terminates orphaned session processes (any live session row with a `pid` and a recorded `pidStart`) and an orphaned gate's process group (`gatePid`), ends those sessions with `daemon_restart`, and clears the current session, the gate pid and the lease.
  - **Lane states** (STARTING, RUNNING, HANDING_OFF, VERIFYING, RECOVERING, TAKEN_OVER):
    - It moves the workstream to RECOVERING and emits a `recovery.step` event with HEAD, the dirty files and the last acknowledged operation.
    - Then it re-queues, as `verify` if verification was under way, or else via `nextActionAfterCrash`.
    - After `maxRecoveryAttempts` the workstream becomes FAILED and a flag card is raised.
  - **WAITING_HUMAN** with an open card becomes parked, with next action `answer`.
  - **QUEUED and PAUSED_LIMIT** keep their state; only the lease is cleared.
  - **Inbox items** left in ANSWERED or DELIVERING are redelivered.

- [ ] **Step 1: Write the failing test**

`apps/daemon/src/recovery/recover.test.ts`:
```ts
import { spawn } from 'node:child_process';
import { mintId } from '@10db/contracts';
import { acquireLease, createTestStore, getWorkstream, getWorkstreamRow, insertSession, listEventsAfter, listInbox, listSessions, markSessionStarted, patchWorkstream, transitionWorkstream, updateInboxItem, type Store } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, seedWorkstream, waitFor } from '../../test/fixtures';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService, type InboxService } from '../inbox';
import { silentLogger } from '../log';
import { recoverOnStartup, systemProcesses } from './index';

let base: Store;
let close: () => void;
let state: StateStore;
let inbox: InboxService;
let repo: { path: string; cleanup(): void };
let parked: string[];

beforeEach(async () => {
  ({ store: base, close } = createTestStore());
  state = createStateStore(base, createEventBus());
  parked = [];
  inbox = createInboxService({ state, onParkedAnswer: (t) => parked.push(t.workstreamId) });
  repo = await createTempRepo();
});
afterEach(() => { close(); repo.cleanup(); });

function inState(
  states: readonly ('STARTING' | 'RUNNING' | 'VERIFYING' | 'WAITING_HUMAN')[],
  opts: { title?: string; pid?: number | null; pidStart?: string | null; provider?: string | null } = {},
) {
  const seeded = seedWorkstream(base, { title: opts.title ?? 'Alpha', repoPath: repo.path });
  const session = state.write((ctx) => {
    for (const to of states) transitionWorkstream(ctx, seeded.workstream.id, { to, fence: null });
    const s = insertSession(ctx, { workstreamId: seeded.workstream.id, provider: 'claude', model: 'sonnet', effort: 'medium', mode: 'managed', mcpTokenHash: mintId('Session') });
    if (opts.provider !== null) markSessionStarted(ctx, s.id, opts.provider ?? 'provider-1', opts.pid ?? null, opts.pidStart ?? null);
    patchWorkstream(ctx, seeded.workstream.id, null, { currentSessionId: s.id });
    // A lease held by a daemon that no longer exists; recovery must clear it.
    acquireLease(ctx, seeded.workstream.id, 'dead-daemon', ctx.now);
    return s;
  });
  return { ...seeded, session };
}

const recover = (extra: { cleanShutdown?: boolean } = {}) =>
  recoverOnStartup({ state, inbox, git: createGit(), processes: systemProcesses, maxRecoveryAttempts: 3, logger: silentLogger, ...extra });

/** A real process to stand in for an orphan, with the identity recovery checks before signalling it. */
async function orphanProcess(detached = false) {
  const child = detached ? spawn('sh', ['-c', 'sleep 60'], { detached: true, stdio: 'ignore' }) : spawn('sleep', ['60']);
  const pid = child.pid;
  if (pid === undefined) throw new Error('spawn failed');
  const startedAt = await systemProcesses.identify(pid);
  if (startedAt === null) throw new Error('ps could not see the child');
  const exited = new Promise((r) => child.once('exit', r));
  return { child, pid, startedAt, exited };
}

describe('recoverOnStartup', () => {
  it('fences a running workstream, kills its orphaned process, and re-queues it to resume', async () => {
    const orphan = await orphanProcess();
    const ws = inState(['STARTING', 'RUNNING'], { pid: orphan.pid, pidStart: orphan.startedAt });
    const { exited } = orphan;
    const report = await recover();
    await exited;

    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({ state: 'QUEUED', currentSessionId: null, recoveryAttempts: 1, nextAction: { kind: 'resume', providerSessionId: 'provider-1' } });
    expect(getWorkstreamRow(state.db, ws.workstream.id).leaseOwner).toBeNull();
    expect(listSessions(state.db, ws.workstream.id)[0]?.exitReason).toBe('daemon_restart');
    const steps = listEventsAfter(state.db, 0, 1000).filter((e) => e.type === 'recovery.step');
    expect(steps[0]?.data).toMatchObject({ step: 'reconciled', sessionsEnded: 1 });
  });

  it('leaves a live process alone when its pid now belongs to something else', async () => {
    const stranger = await orphanProcess();
    try {
      inState(['STARTING', 'RUNNING'], { pid: stranger.pid, pidStart: 'Thu Jan  1 00:00:00 1970' });
      await recover();
      expect(await systemProcesses.identify(stranger.pid)).toBe(stranger.startedAt);
    } finally {
      stranger.child.kill('SIGKILL');
    }
  });

  it('re-runs verification when the daemon died while verifying, killing the orphaned gate group', async () => {
    const gate = await orphanProcess(true);
    const ws = inState(['STARTING', 'RUNNING', 'VERIFYING']);
    state.write((ctx) => { patchWorkstream(ctx, ws.workstream.id, null, { gatePid: gate.pid, gatePidStart: gate.startedAt }); });
    await recover();
    await gate.exited;
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({ state: 'QUEUED', nextAction: { kind: 'verify' } });
    expect(getWorkstreamRow(state.db, ws.workstream.id).gatePid).toBeNull();
  });

  it('does not count a clean shutdown as a failed recovery attempt', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    const report = await recover({ cleanShutdown: true });
    expect(report.requeued).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({ state: 'QUEUED', recoveryAttempts: 0, nextAction: { kind: 'resume' } });
  });

  it('parks a workstream that was waiting on an open card', async () => {
    const ws = inState(['STARTING', 'RUNNING', 'WAITING_HUMAN']);
    const { item } = inbox.ask({ projectId: ws.project.id, workstreamId: ws.workstream.id, sessionId: ws.session.id, kind: 'question', title: 'Q?', body: '', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], recommendation: null, category: 'other', urgency: 'normal', detail: null, signal: new AbortController().signal });
    const report = await recover();
    expect(report.parked).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id)).toMatchObject({ state: 'WAITING_HUMAN', currentSessionId: null, nextAction: { kind: 'answer', inboxId: item.id } });
  });

  it('fails a workstream that has used its recovery attempts, with a flag', async () => {
    const ws = inState(['STARTING', 'RUNNING']);
    state.write((ctx) => { patchWorkstream(ctx, ws.workstream.id, null, { recoveryAttempts: 3 }); });
    const report = await recover();
    expect(report.failed).toEqual([ws.workstream.id]);
    expect(getWorkstream(state.db, ws.workstream.id).state).toBe('FAILED');
    expect(listInbox(state.db, { states: ['OPEN'] }).map((i) => i.kind)).toEqual(['flag']);
  });

  it('redelivers answers that were mid-delivery', async () => {
    const ws = inState(['STARTING', 'RUNNING', 'WAITING_HUMAN']);
    // The asking session died with the old daemon, so no waiter is live; abort models that.
    const asked = new AbortController();
    const { item } = inbox.ask({ projectId: ws.project.id, workstreamId: ws.workstream.id, sessionId: ws.session.id, kind: 'question', title: 'Q2?', body: '', options: [{ label: 'A', description: '' }, { label: 'B', description: '' }], recommendation: null, category: 'other', urgency: 'normal', detail: null, signal: asked.signal });
    asked.abort();
    state.write((ctx) => updateInboxItem(ctx, item.id, { state: 'DELIVERING', answer: { choice: 'A' } }));
    const report = await recover();
    expect(report.redelivered).toEqual([item.id]);
    await waitFor(() => parked.length > 0);
  });
});
```

- [ ] **Step 2: Run it to see it fail**

```bash
pnpm vitest run --project daemon recover
```
Expected: FAIL, because `./index` can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/recovery/processes.ts`:
```ts
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const run = promisify(execFile);

export interface ProcessTerminator {
  /** The OS start time of `pid`, or null when no such process runs. */
  identify(pid: number): Promise<string | null>;
  /** Signals `pid` (or its process group) only while its start time still equals `startedAt`. */
  terminate(target: { readonly pid: number; readonly startedAt: string; readonly group?: boolean }): Promise<'terminated' | 'not_running'>;
}

async function identify(pid: number): Promise<string | null> {
  try {
    const { stdout } = await run('/bin/ps', ['-o', 'lstart=', '-p', String(pid)], { env: { LC_ALL: 'C' } });
    const startedAt = stdout.trim();
    return startedAt === '' ? null : startedAt;
  } catch {
    return null; // ps exits 1 when the pid doesn't exist
  }
}

/** Sends a signal; false when the target already exited (ESRCH), so callers never throw on a race. */
function signal(target: number, sig: NodeJS.Signals): boolean {
  try {
    process.kill(target, sig);
    return true;
  } catch {
    return false;
  }
}

/**
 * Ends processes left by a crashed daemon: SIGTERM, then SIGKILL after 2 s. After a reboot a stored pid
 * can belong to an unrelated process, so the start time recorded with the pid must still match.
 */
export const systemProcesses: ProcessTerminator = {
  identify,
  async terminate({ pid, startedAt, group = false }) {
    if ((await identify(pid)) !== startedAt) return 'not_running';
    const target = group ? -pid : pid;
    if (!signal(target, 'SIGTERM')) return 'not_running';
    for (let i = 0; i < 20; i += 1) {
      if ((await identify(pid)) !== startedAt) return 'terminated';
      await new Promise((r) => setTimeout(r, 100));
    }
    signal(target, 'SIGKILL');
    return 'terminated';
  },
};
```

`apps/daemon/src/recovery/recover.ts`:
```ts
import { ACTIVE_STATES, EventType, WorkstreamState as S, type InboxItemId, type NextAction, type WorkstreamId } from '@10db/contracts';
import {
  clearLease,
  endSession,
  getProject,
  getTask,
  getWorkstreamRow,
  latestHandoff,
  latestToolOp,
  listInbox,
  listSessions,
  listWorkstreams,
  openItemsForWorkstream,
  patchWorkstream,
  releaseClaims,
  transitionWorkstream,
} from '@10db/db';
import type { StateStore } from '../events';
import type { Git } from '../git';
import type { InboxService } from '../inbox';
import type { Logger } from '../log';
import { nextActionAfterCrash } from '../runner';
import type { ProcessTerminator } from './processes';

export interface RecoveryReport {
  readonly requeued: WorkstreamId[];
  readonly failed: WorkstreamId[];
  readonly parked: WorkstreamId[];
  readonly redelivered: InboxItemId[];
}

const KEEP_STATE = new Set<string>([S.Queued, S.PausedLimit]);

/** Runs once at startup, before the scheduler, so no runner races it (spec §5.4). */
export async function recoverOnStartup(opts: {
  readonly state: StateStore;
  readonly inbox: InboxService;
  readonly git: Git;
  readonly processes: ProcessTerminator;
  readonly maxRecoveryAttempts: number;
  readonly logger: Logger;
  /** The previous daemon stopped cleanly, so this restart is not a failed attempt (spec §5.4). */
  readonly cleanShutdown?: boolean;
}): Promise<RecoveryReport> {
  const db = opts.state.db;
  const report: RecoveryReport = { requeued: [], failed: [], parked: [], redelivered: [] };

  for (const ws of listWorkstreams(db, { states: ACTIVE_STATES })) {
    const row = getWorkstreamRow(db, ws.id);
    const project = getProject(db, row.projectId);
    const sessions = listSessions(db, ws.id);
    const live = sessions.filter((s) => s.endedAt === null);
    for (const s of live) if (s.pid !== null && s.pidStart !== null) await opts.processes.terminate({ pid: s.pid, startedAt: s.pidStart });
    if (row.gatePid !== null && row.gatePidStart !== null) await opts.processes.terminate({ pid: row.gatePid, startedAt: row.gatePidStart, group: true });
    const providerSessionId = [...sessions].reverse().find((s) => s.providerSessionId !== null)?.providerSessionId ?? null;
    opts.state.write((ctx) => {
      for (const s of live) endSession(ctx, s.id, 'daemon_restart');
      patchWorkstream(ctx, ws.id, null, { currentSessionId: null, gatePid: null, gatePidStart: null });
      clearLease(ctx, ws.id);
    });
    if (KEEP_STATE.has(row.state)) continue;

    if (row.state === S.WaitingHuman) {
      const open = openItemsForWorkstream(db, ws.id)[0];
      if (open) {
        const nextAction: NextAction = { kind: 'answer', inboxId: open.id, providerSessionId };
        opts.state.write((ctx) => { patchWorkstream(ctx, ws.id, null, { nextAction }); });
        report.parked.push(ws.id);
        continue;
      }
    }

    const head = await opts.git.head(project.repoPath).catch(() => 'unknown');
    const dirty = await opts.git.status(project.repoPath).then((s) => s.map((x) => x.path)).catch(() => []);
    const lastOp = latestToolOp(db, ws.id);
    const attempts = opts.cleanShutdown ? row.recoveryAttempts : row.recoveryAttempts + 1;
    const restarted = opts.cleanShutdown ? 'daemon restarted after a clean shutdown' : 'daemon restarted';
    const nextAction: NextAction =
      row.state === S.Verifying || row.nextAction.kind === 'verify' ? { kind: 'verify' } : nextActionAfterCrash(row.nextAction, providerSessionId, latestHandoff(db, ws.id));
    const failed = attempts > opts.maxRecoveryAttempts;
    opts.state.write((ctx) => {
      if (row.state !== S.Recovering) {
        if (row.state === S.WaitingHuman) transitionWorkstream(ctx, ws.id, { to: S.Queued, fence: null, patch: { nextAction, recoveryAttempts: attempts }, reason: 'recovered after restart' });
        else transitionWorkstream(ctx, ws.id, { to: S.Recovering, fence: null, reason: restarted });
      }
      ctx.emit({
        type: EventType.RecoveryStep,
        entityType: 'workstream',
        entityId: ws.id,
        data: { step: 'reconciled', head, dirtyFiles: dirty.slice(0, 200), lastOpId: lastOp?.opId ?? null, sessionsEnded: live.length },
      });
      if (row.state === S.WaitingHuman) return;
      if (failed) {
        transitionWorkstream(ctx, ws.id, { to: S.Failed, fence: null, patch: { recoveryAttempts: attempts, failureReason: `Recovery failed ${String(attempts)} times` } });
        releaseClaims(ctx, ws.id);
      } else {
        transitionWorkstream(ctx, ws.id, { to: S.Queued, fence: null, patch: { nextAction, recoveryAttempts: attempts }, reason: 'recovered after restart' });
      }
    });
    if (failed) {
      opts.inbox.flag({ projectId: project.id, workstreamId: ws.id, title: `Workstream failed: ${getTask(db, row.taskId).title}`, body: `Recovery failed ${String(attempts)} times.` });
      report.failed.push(ws.id);
    } else report.requeued.push(ws.id);
  }

  for (const item of listInbox(db, { states: ['ANSWERED', 'DELIVERING'] })) {
    opts.inbox.redeliver(item.id);
    report.redelivered.push(item.id);
  }
  opts.logger.info({ ...report }, 'startup recovery complete');
  return report;
}
```

`apps/daemon/src/recovery/index.ts`:
```ts
export { recoverOnStartup, type RecoveryReport } from './recover';
export { systemProcesses, type ProcessTerminator } from './processes';
```

- [ ] **Step 4: Run, check, commit**

```bash
pnpm vitest run --project daemon recover
pnpm typecheck && pnpm lint
pnpm format
git add apps/daemon/src/recovery && git commit -m 'feat(daemon): add startup recovery that fences orphans, requeues or fails, and redelivers answers'
```

---

### Task 19: Daemon composition: lock, logs, backups, services, `main.ts`

**Files:**
- Create: `apps/daemon/src/daemon/instance-lock.ts`, `daemon/runtime-files.ts`, `daemon/services.ts`, `daemon/start.ts`, `daemon/index.ts`
- Create: `apps/daemon/src/backups/index.ts`, `apps/daemon/src/log/rotate.ts`
- Create: `apps/daemon/src/sessions/unavailable-adapter.ts` (export it)
- Modify: `apps/daemon/src/env.ts`, `apps/daemon/.env.example`, `apps/daemon/src/main.ts`, `apps/daemon/src/log/index.ts` (export the rotation helpers)
- Test: `apps/daemon/src/daemon/instance-lock.test.ts`, `apps/daemon/src/backups/backups.test.ts`, `apps/daemon/src/daemon/start.test.ts`

**Interfaces:**
- Produces:
  - **Instance lock** (`daemon/index.ts`): `class AlreadyRunningError extends Error { readonly pid: number }` and `acquireInstanceLock(dataDir): { release(): void }`. A lock whose pid is no longer alive is taken over.
  - **Runtime files** (`daemon/index.ts`):
    - `writeRuntimeFiles(dataDir, { pid, port, protocolVersion, startedAt }, token)`, which writes `daemon.json` and `ui-token` (mode 0600). Each is written to a temporary file and renamed into place, so a concurrent reader never sees a partial file.
    - `readRuntimeInfo(dataDir)`. M1b's Tauri shell reads these same files.
  - **Services** (`daemon/index.ts`): `createServices({ state, bus, runner, scheduler, inbox }): ApiServices`. `createProject` checks that `repoPath` contains `.git` (400), and a second project on the same `repoPath` is a `ConflictError` (409, from `insertProject`).
  - **Start options** (`daemon/index.ts`): `interface DaemonOptions { dataDir; port; adapter; logLevel; clock?; caps?; limits?; sessionEnv?; processes?; migrationsDir?; allowedOrigins? }`
  - **Running daemon** (`daemon/index.ts`):
    - `interface RunningDaemon { url; port; mcpUrl; token; state; runner; scheduler; stop(): Promise<void> }`
    - `startDaemon(opts): Promise<RunningDaemon>`. It merges `opts.limits` over `DEFAULT_RUNNER_LIMITS` once and gives the result to both the runner and recovery.
    - **Clean shutdown.** `stop()` writes the app setting `daemon.clean_shutdown` after every runner has stopped. The next `startDaemon` reads and deletes it, and passes `cleanShutdown` to recovery, so quitting the app never counts as a failed recovery attempt. A `kill -9` leaves no marker, so it does count.
  - **Backups** (`backups/index.ts`):
    - `hasPendingMigrations(db, migrationsDir): boolean`
    - `backupDatabase(db, dir, label, now): Promise<string>`
    - `pruneBackups(dir, label, keep): string[]`
    - `msUntilNextHour(now, hour): number`
    - `scheduleNightlyBackup(clock, run, hour?, onError?): { cancel(): void }`. A failed run goes to `onError` and the schedule re-arms; it never becomes an unhandled rejection.
  - **Logs** (`log/index.ts`): `rotateLogFile(path, maxBytes?, keep?)` and `fileDestination(path)`.
  - **Sessions** (`sessions/index.ts`): `createUnavailableAdapter(message): SessionAdapter`
  - **Env:** `TENDB_FAKE_SCRIPTS?: string`. `main.ts` uses the fake adapter when it is set, and otherwise the unavailable adapter, until M1b.

- [ ] **Step 1: Write the failing tests**

`apps/daemon/src/daemon/instance-lock.test.ts`:
```ts
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { acquireInstanceLock, AlreadyRunningError } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => { dir = tempDir('lock'); });
afterEach(() => { dir.cleanup(); });

describe('acquireInstanceLock', () => {
  it('refuses a second holder while the first is alive', () => {
    writeFileSync(join(dir.path, 'daemon.lock'), String(process.ppid));
    expect(() => acquireInstanceLock(dir.path)).toThrow(AlreadyRunningError);
  });

  it('takes over a lock left by a dead process', () => {
    writeFileSync(join(dir.path, 'daemon.lock'), '999999');
    const lock = acquireInstanceLock(dir.path);
    lock.release();
    expect(() => {
      acquireInstanceLock(dir.path).release();
    }).not.toThrow();
  });
});
```

`apps/daemon/src/backups/backups.test.ts`:
```ts
import { readdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { DB_MIGRATIONS_DIR, migrateDatabase, openDatabase } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../test/fixtures';
import { ManualClock } from '../clock';
import { backupDatabase, hasPendingMigrations, msUntilNextHour, pruneBackups, scheduleNightlyBackup } from './index';

let dir: { path: string; cleanup(): void };
beforeEach(() => { dir = tempDir('backups'); });
afterEach(() => { dir.cleanup(); });

describe('backups', () => {
  it('detects pending migrations before and not after migrating', () => {
    const db = openDatabase(join(dir.path, 'db.sqlite'));
    expect(hasPendingMigrations(db, DB_MIGRATIONS_DIR)).toBe(true);
    migrateDatabase(db);
    expect(hasPendingMigrations(db, DB_MIGRATIONS_DIR)).toBe(false);
    db.$client.close();
  });

  it('writes an openable backup', async () => {
    const db = openDatabase(join(dir.path, 'db.sqlite'));
    migrateDatabase(db);
    const file = await backupDatabase(db, join(dir.path, 'backups'), 'nightly', new Date('2026-10-13T03:00:00.000Z'));
    const copy = openDatabase(file);
    expect(copy.$client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE name = 'projects'").get()).toEqual({ n: 1 });
    copy.$client.close();
    db.$client.close();
  });

  it('keeps only the newest backups for a label', () => {
    for (const day of ['20261001', '20261002', '20261003']) writeFileSync(join(dir.path, `10db-nightly-${day}T030000.sqlite`), '');
    const removed = pruneBackups(dir.path, 'nightly', 2);
    expect(removed.map((f) => f.split('/').at(-1))).toEqual(['10db-nightly-20261001T030000.sqlite']);
    expect(readdirSync(dir.path).filter((f) => f.startsWith('10db-nightly'))).toHaveLength(2);
  });

  it.each([
    ['before the hour', '2026-10-13T01:30:00', 90 * 60_000],
    ['after the hour', '2026-10-13T04:00:00', 23 * 3_600_000],
  ])('waits until the next 03:00 local time %s', (_n, local, ms) => {
    expect(msUntilNextHour(new Date(local), 3)).toBe(ms);
  });

  it('reports a failed nightly backup and keeps the schedule', async () => {
    const clock = new ManualClock(new Date('2026-10-13T01:00:00'));
    const errors: unknown[] = [];
    const nightly = scheduleNightlyBackup(clock, () => Promise.reject(new Error('disk full')), 3, (error) => errors.push(error));
    clock.advance(2 * 3_600_000);
    await new Promise((r) => setTimeout(r, 0));
    expect(errors).toHaveLength(1);
    expect(clock.pendingTimers()).toBe(1);
    nightly.cancel();
  });
});
```

`apps/daemon/src/daemon/start.test.ts`:
```ts
import { statSync } from 'node:fs';
import { join } from 'node:path';
import { getWorkstream } from '@10db/db';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createTempRepo, tempDir, waitFor } from '../../test/fixtures';
import { FakeAdapter, type FakeScriptBook } from '../sessions';
import { AlreadyRunningError, readRuntimeInfo, startDaemon, type RunningDaemon } from './index';

let dir: { path: string; cleanup(): void };
let daemon: RunningDaemon | null;
beforeEach(() => { dir = tempDir('daemon'); daemon = null; });
afterEach(async () => { await daemon?.stop(); dir.cleanup(); });

describe('startDaemon', () => {
  it('serves health, writes runtime files with a private token, and refuses a second instance', async () => {
    daemon = await startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn' });
    const health = await fetch(`${daemon.url}/health`);
    expect(health.status).toBe(200);
    expect(readRuntimeInfo(dir.path)).toMatchObject({ port: daemon.port, pid: process.pid });
    expect(statSync(join(dir.path, 'ui-token')).mode & 0o777).toBe(0o600);
    const projects = await fetch(`${daemon.url}/projects`, { headers: { Authorization: `Bearer ${daemon.token}` } });
    expect(await projects.json()).toEqual([]);
    await expect(startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn' })).rejects.toThrow(AlreadyRunningError);
  });

  it('answers 409 for a second project on the same repository', async () => {
    const repo = await createTempRepo();
    try {
      daemon = await startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter({}), logLevel: 'warn' });
      const body = JSON.stringify({ name: 'demo', repoPath: repo.path, gateCommand: 'true', areas: [{ name: 'src', globs: ['src/**'] }] });
      const post = () => fetch(`${daemon?.url ?? ''}/projects`, { method: 'POST', headers: { Authorization: `Bearer ${daemon?.token ?? ''}`, 'content-type': 'application/json' }, body });
      expect((await post()).status).toBe(201);
      expect((await post()).status).toBe(409);
    } finally {
      repo.cleanup();
    }
  });

  it('does not count a clean stop against the recovery limit', async () => {
    const repo = await createTempRepo();
    const book: FakeScriptBook = { Alpha: [[{ do: 'hang' }], [{ do: 'hang' }]] };
    const start = () => startDaemon({ dataDir: dir.path, port: 0, adapter: new FakeAdapter(book), logLevel: 'warn' });
    try {
      let running = await start();
      daemon = running;
      const call = async <T>(path: string, body: unknown): Promise<T> => {
        const res = await fetch(`${running.url}${path}`, { method: 'POST', headers: { Authorization: `Bearer ${running.token}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
        return (await res.json()) as T;
      };
      const project = await call<{ id: string }>('/projects', { name: 'demo', repoPath: repo.path, gateCommand: 'true', areas: [{ name: 'api', globs: ['src/**'] }] });
      const task = await call<{ id: string }>(`/projects/${project.id}/tasks`, { title: 'Alpha', acceptanceCriteria: ['x'], areas: ['api'] });
      const ws = await call<{ id: Parameters<typeof getWorkstream>[1] }>(`/tasks/${task.id}/start`, {});
      await waitFor(() => getWorkstream(running.state.db, ws.id).state === 'RUNNING');
      await running.stop();
      daemon = null;

      running = await start();
      daemon = running;
      await waitFor(() => getWorkstream(running.state.db, ws.id).state === 'RUNNING');
      expect(getWorkstream(running.state.db, ws.id).recoveryAttempts).toBe(0);
    } finally {
      repo.cleanup();
    }
  });
});
```

- [ ] **Step 2: Run them to see them fail**

```bash
pnpm vitest run --project daemon instance-lock backups start
```
Expected: FAIL, because the modules can't be resolved.

- [ ] **Step 3: Implement**

`apps/daemon/src/daemon/instance-lock.ts`:
```ts
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

export class AlreadyRunningError extends Error {
  override readonly name = 'AlreadyRunningError';
  readonly pid: number;
  constructor(pid: number) {
    super(`Another 10db daemon is running (pid ${String(pid)})`);
    this.pid = pid;
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'EPERM';
  }
}

/** One daemon per data directory (spec §3). A lock left by a dead process is taken over. */
export function acquireInstanceLock(dataDir: string): { release(): void } {
  const path = join(dataDir, 'daemon.lock');
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      writeFileSync(path, String(process.pid), { flag: 'wx' });
      return {
        release() {
          try {
            if (readFileSync(path, 'utf8') === String(process.pid)) rmSync(path, { force: true });
          } catch {
            // Already gone.
          }
        },
      };
    } catch (error) {
      if (!(typeof error === 'object' && error !== null && 'code' in error && error.code === 'EEXIST')) throw error;
      const holder = Number(readFileSync(path, 'utf8'));
      // A live holder, including this process, keeps the lock; only a dead holder's lock is taken over.
      if (Number.isInteger(holder) && holder > 0 && alive(holder)) throw new AlreadyRunningError(holder);
      rmSync(path, { force: true });
    }
  }
  throw new Error(`Could not take the daemon lock at ${path}`);
}
```

`apps/daemon/src/daemon/runtime-files.ts`:
```ts
import { chmodSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { z } from 'zod';

export const RuntimeInfo = z.object({ pid: z.int(), port: z.int(), protocolVersion: z.int(), startedAt: z.iso.datetime() });
export type RuntimeInfo = z.infer<typeof RuntimeInfo>;

/** Write-then-rename, so a reader (the crash test, M1b's Tauri shell) never sees a half-written file. */
function writeAtomically(path: string, content: string, mode: number): void {
  const tmp = `${path}.${String(process.pid)}.tmp`;
  writeFileSync(tmp, content, { mode });
  chmodSync(tmp, mode);
  renameSync(tmp, path);
}

/** `daemon.json` tells the UI where to connect; `ui-token` (0600) holds its bearer token. */
export function writeRuntimeFiles(dataDir: string, info: RuntimeInfo, token: string): void {
  writeAtomically(join(dataDir, 'ui-token'), token, 0o600);
  writeAtomically(join(dataDir, 'daemon.json'), `${JSON.stringify(info, null, 2)}\n`, 0o644);
}

export function readRuntimeInfo(dataDir: string): RuntimeInfo {
  return RuntimeInfo.parse(JSON.parse(readFileSync(join(dataDir, 'daemon.json'), 'utf8')));
}

export function removeRuntimeFiles(dataDir: string): void {
  rmSync(join(dataDir, 'daemon.json'), { force: true });
}
```

`apps/daemon/src/backups/index.ts`:
```ts
import { mkdirSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import type { TendbDatabase } from '@10db/db';
import { z } from 'zod';
import type { Clock, Timer } from '../clock';

const Journal = z.object({ entries: z.array(z.unknown()) });

export function hasPendingMigrations(db: TendbDatabase, migrationsDir: string): boolean {
  const journal = Journal.parse(JSON.parse(readFileSync(join(migrationsDir, 'meta', '_journal.json'), 'utf8')));
  const table = db.$client.prepare("SELECT count(*) AS n FROM sqlite_master WHERE type = 'table' AND name = '__drizzle_migrations'").get() as { n: number };
  if (table.n === 0) return journal.entries.length > 0;
  const applied = db.$client.prepare('SELECT count(*) AS n FROM __drizzle_migrations').get() as { n: number };
  return journal.entries.length > applied.n;
}

const stamp = (d: Date) => d.toISOString().replace(/[-:]/g, '').slice(0, 15);

/** A consistent online copy via SQLite's backup API (safe while the daemon writes). */
export async function backupDatabase(db: TendbDatabase, dir: string, label: string, now: Date): Promise<string> {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `10db-${label}-${stamp(now)}.sqlite`);
  await db.$client.backup(file);
  return file;
}

export function pruneBackups(dir: string, label: string, keep: number): string[] {
  const files = readdirSync(dir).filter((f) => f.startsWith(`10db-${label}-`) && f.endsWith('.sqlite')).sort().reverse();
  const doomed = files.slice(keep).map((f) => join(dir, f));
  for (const file of doomed) rmSync(file, { force: true });
  return doomed.reverse();
}

export function msUntilNextHour(now: Date, hour: number): number {
  const next = new Date(now);
  next.setHours(hour, 0, 0, 0);
  if (next <= now) next.setDate(next.getDate() + 1);
  return next.getTime() - now.getTime();
}

export function scheduleNightlyBackup(clock: Clock, run: () => Promise<void>, hour = 3, onError: (error: unknown) => void = () => undefined): { cancel(): void } {
  let timer: Timer | null = null;
  const arm = (): void => {
    timer = clock.setTimeout(() => {
      // A failed backup (a full disk, say) is reported, never left as an unhandled rejection that exits the daemon.
      void run().catch(onError).finally(arm);
    }, msUntilNextHour(clock.now(), hour));
  };
  arm();
  return { cancel: () => timer?.cancel() };
}
```
The `as { n: number }` casts read SQLite's own `count(*)` row, so they sit at the boundary.

`apps/daemon/src/log/rotate.ts`:
```ts
import { existsSync, renameSync, rmSync, statSync } from 'node:fs';
import pino, { type DestinationStream } from 'pino';

/** Rotates `path` to `path.1` … `path.<keep>` when it is larger than `maxBytes`. */
export function rotateLogFile(path: string, maxBytes = 10 * 1024 * 1024, keep = 5): void {
  if (!existsSync(path) || statSync(path).size <= maxBytes) return;
  rmSync(`${path}.${String(keep)}`, { force: true });
  for (let i = keep - 1; i >= 1; i -= 1) if (existsSync(`${path}.${String(i)}`)) renameSync(`${path}.${String(i)}`, `${path}.${String(i + 1)}`);
  renameSync(path, `${path}.1`);
}

export function fileDestination(path: string): DestinationStream {
  return pino.destination({ dest: path, mkdir: true, sync: false });
}
```
Add `export { fileDestination, rotateLogFile } from './rotate';` to `log/index.ts`.

`apps/daemon/src/sessions/unavailable-adapter.ts`:
```ts
import { Provider } from '@10db/contracts';
import { createChannel } from './channel';
import type { SessionAdapter, SessionEvent } from './types';

/** Ends every session at once with a clear message; used until a real adapter is configured. */
export function createUnavailableAdapter(message: string): SessionAdapter {
  return {
    provider: Provider.Claude,
    start() {
      const channel = createChannel<SessionEvent>();
      channel.push({ type: 'ended', reason: 'error', message });
      channel.end();
      return { events: channel, send: () => undefined, stop: () => Promise.resolve() };
    },
  };
}
```
Export it from `sessions/index.ts`.

`apps/daemon/src/daemon/services.ts`:
```ts
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ACTIVE_STATES, ConflictError, InvalidError, ProjectInput, WorkstreamState } from '@10db/contracts';
import {
  getWorkstream,
  getWorkstreamRow,
  insertProject,
  insertTask,
  insertWorkstream,
  latestHandoff,
  listEventsAfter,
  listInbox,
  listProjects,
  listTasks,
  listWorkstreams,
  transitionWorkstream,
} from '@10db/db';
import type { ApiServices } from '../api';
import type { EventBus, StateStore } from '../events';
import type { InboxService } from '../inbox';
import type { Runner } from '../runner';
import type { Scheduler } from '../scheduler';

export function createServices(deps: {
  readonly state: StateStore;
  readonly bus: EventBus;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  readonly inbox: InboxService;
}): ApiServices {
  const db = deps.state.db;
  return {
    listProjects: () => listProjects(db),
    createProject(input) {
      const config = ProjectInput.parse(input);
      if (!existsSync(join(config.repoPath, '.git'))) throw new InvalidError(`${config.repoPath} is not a git repository`);
      return deps.state.write((ctx) => insertProject(ctx, config));
    },
    listTasks: (projectId) => listTasks(db, projectId),
    createTask(projectId, input) {
      const task = deps.state.write((ctx) => insertTask(ctx, projectId, input));
      deps.scheduler.requestTick();
      return task;
    },
    startTask(taskId) {
      const ws = deps.state.write((ctx) => insertWorkstream(ctx, taskId));
      deps.scheduler.requestTick();
      return ws;
    },
    listWorkstreams: ({ active }) => listWorkstreams(db, active ? { states: ACTIVE_STATES } : {}),
    async cancelWorkstream(id) {
      await deps.runner.cancel(id);
      return getWorkstream(db, id);
    },
    retryWorkstream(id) {
      if (getWorkstreamRow(db, id).state !== WorkstreamState.Failed) throw new ConflictError('Only a failed workstream can be retried');
      const latest = latestHandoff(db, id);
      const ws = deps.state.write((ctx) =>
        transitionWorkstream(ctx, id, {
          to: WorkstreamState.Queued,
          fence: null,
          patch: { attempt: 0, recoveryAttempts: 0, failureReason: null, nextAction: latest ? { kind: 'continue_from_handoff', handoffId: latest.id } : { kind: 'start' } },
          reason: 'retried by the builder',
        }),
      );
      deps.scheduler.requestTick();
      return ws;
    },
    listInbox: ({ states }) => listInbox(db, states ? { states } : {}),
    answerInbox(id, answer) {
      const item = deps.inbox.answer(id, answer);
      deps.scheduler.requestTick();
      return item;
    },
    eventsAfter: (after, limit) => listEventsAfter(db, after, limit),
    subscribe: (listener) => deps.bus.subscribe(listener),
  };
}
```
`apps/daemon/src/api/index.ts` already exports `createApp`, `type AppType`, `type ApiDeps` (Task 6) and `type ApiServices` (Task 15), and `src/index.ts` already re-exports `AppType` from `./api`.

`apps/daemon/src/daemon/start.ts`:
```ts
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { serve, upgradeWebSocket, type WebSocketServerLike } from '@hono/node-server';
import { PROTOCOL_VERSION, type ProjectDto } from '@10db/contracts';
import { createStore, DB_MIGRATIONS_DIR, deleteAppSetting, getAppSetting, migrateDatabase, openDatabase, setAppSetting } from '@10db/db';
import { WebSocketServer } from 'ws';
import { createApp } from '../api';
import { backupDatabase, hasPendingMigrations, pruneBackups, scheduleNightlyBackup } from '../backups';
import { systemClock, type Clock } from '../clock';
import type { LogLevel } from '../env';
import { createEventBus, createStateStore, type StateStore } from '../events';
import { createGit } from '../git';
import { createInboxService } from '../inbox';
import { createLogger, fileDestination, rotateLogFile } from '../log';
import { createMcpHandler } from '../mcp';
import { recoverOnStartup, systemProcesses, type ProcessTerminator } from '../recovery';
import { createLiveSessions, createRunner, DEFAULT_RUNNER_LIMITS, type Runner, type RunnerLimits } from '../runner';
import { createProviderPauses, createScheduler, DEFAULT_CAPS, type Scheduler } from '../scheduler';
import type { SessionAdapter } from '../sessions';
import { createGateRunner } from '../verify';
import { acquireInstanceLock } from './instance-lock';
import { removeRuntimeFiles, writeRuntimeFiles } from './runtime-files';
import { createServices } from './services';

export interface DaemonOptions {
  readonly dataDir: string;
  readonly port: number;
  readonly adapter: SessionAdapter;
  readonly logLevel: LogLevel;
  readonly clock?: Clock;
  readonly caps?: { readonly global: number; readonly perProvider: number };
  readonly limits?: Partial<RunnerLimits>;
  readonly sessionEnv?: (project: ProjectDto) => Readonly<Record<string, string>>;
  readonly processes?: ProcessTerminator;
  readonly migrationsDir?: string;
  readonly allowedOrigins?: readonly string[];
}

export interface RunningDaemon {
  readonly url: string;
  readonly port: number;
  readonly mcpUrl: string;
  readonly token: string;
  readonly state: StateStore;
  readonly runner: Runner;
  readonly scheduler: Scheduler;
  stop(): Promise<void>;
}

const UI_ORIGINS = ['http://localhost:1420', 'tauri://localhost', 'http://tauri.localhost'] as const;
/** Written by stop() after every runner has stopped; its absence at start means the last run crashed. */
const CLEAN_SHUTDOWN_KEY = 'daemon.clean_shutdown';

export async function startDaemon(opts: DaemonOptions): Promise<RunningDaemon> {
  const clock = opts.clock ?? systemClock;
  const startedAt = clock.now();
  mkdirSync(join(opts.dataDir, 'logs'), { recursive: true });
  const lock = acquireInstanceLock(opts.dataDir);
  const logPath = join(opts.dataDir, 'logs', 'daemon.log');
  rotateLogFile(logPath);
  const logger = createLogger({ level: opts.logLevel, destination: fileDestination(logPath) });

  const db = openDatabase(join(opts.dataDir, '10db.sqlite'));
  const migrationsDir = opts.migrationsDir ?? DB_MIGRATIONS_DIR;
  const backupsDir = join(opts.dataDir, 'backups');
  if (hasPendingMigrations(db, migrationsDir)) await backupDatabase(db, backupsDir, 'pre-migrate', startedAt);
  migrateDatabase(db, migrationsDir);

  const bus = createEventBus((error) => { logger.error({ err: String(error) }, 'event listener failed'); });
  const state = createStateStore(createStore(db, () => clock.now()), bus);
  const instanceId = randomUUID();
  const git = createGit();
  const live = createLiveSessions();
  const limits: RunnerLimits = { ...DEFAULT_RUNNER_LIMITS, ...opts.limits };
  const processes = opts.processes ?? systemProcesses;
  let mcpUrl = '';
  let runner: Runner | null = null;
  let scheduler: Scheduler | null = null;
  const inbox = createInboxService({ state, onParkedAnswer: (target, item) => runner?.deliverParkedAnswer(target, item) });
  const pauses = createProviderPauses({
    state, clock, inbox,
    stopProvider: (provider) => runner?.stopProvider(provider, 'paused') ?? Promise.resolve(),
    onResume: () => scheduler?.requestTick(),
    defaultPauseMs: 30 * 60_000,
  });
  runner = createRunner({
    state, adapter: opts.adapter, inbox, git, gate: createGateRunner(), clock, logger, dataDir: opts.dataDir, live,
    limits,
    mcpUrl: () => mcpUrl,
    sessionEnv: opts.sessionEnv ?? (() => ({})),
    onRateLimited: (provider, resetsAt, projectId) => { pauses.pause(provider, resetsAt, projectId); },
    onLaneFreed: () => scheduler?.requestTick(),
    identifyProcess: (pid) => processes.identify(pid),
  });
  scheduler = createScheduler({
    state, runner, pauses, clock, instanceId, logger,
    caps: opts.caps ?? DEFAULT_CAPS,
    leaseMs: 60_000,
    tickMs: 2_000,
  });

  const cleanShutdown = getAppSetting(db, CLEAN_SHUTDOWN_KEY) !== undefined;
  state.write((ctx) => { deleteAppSetting(ctx, CLEAN_SHUTDOWN_KEY); });
  await recoverOnStartup({ state, inbox, git, processes, maxRecoveryAttempts: limits.maxRecoveryAttempts, logger, cleanShutdown });
  pauses.restore();

  const token = randomBytes(32).toString('base64url');
  const app = createApp({
    startedAt,
    allowedOrigins: opts.allowedOrigins ?? UI_ORIGINS,
    token,
    services: createServices({ state, bus, runner, scheduler, inbox }),
    upgradeWebSocket,
    mcp: createMcpHandler({ state, inbox, git, waitObserverFor: (id) => live.get(id)?.observer, sessionSignal: (id) => live.get(id)?.signal }),
  });
  const wss = new WebSocketServer({ noServer: true });
  // ws declares `options.noServer?: boolean`, which WebSocketServerLike rejects under
  // exactOptionalPropertyTypes; the runtime shape is what @hono/node-server expects.
  const server = serve({ fetch: app.fetch, hostname: '127.0.0.1', port: opts.port, websocket: { server: wss as WebSocketServerLike } });
  await new Promise<void>((resolve, reject) => {
    server.once('listening', resolve);
    server.once('error', reject);
  });
  const port = (server.address() as AddressInfo).port;
  const url = `http://127.0.0.1:${String(port)}`;
  mcpUrl = `${url}/mcp`;
  writeRuntimeFiles(opts.dataDir, { pid: process.pid, port, protocolVersion: PROTOCOL_VERSION, startedAt: startedAt.toISOString() }, token);

  const nightly = scheduleNightlyBackup(
    clock,
    async () => {
      await backupDatabase(db, backupsDir, 'nightly', clock.now());
      pruneBackups(backupsDir, 'nightly', 7);
    },
    3,
    (error) => { logger.error({ err: error instanceof Error ? error.message : String(error) }, 'nightly backup failed'); },
  );
  scheduler.start();
  scheduler.requestTick();
  logger.info({ port, dataDir: opts.dataDir }, 'daemon started');

  return {
    url, port, mcpUrl, token, state, runner, scheduler,
    async stop() {
      scheduler.stop();
      pauses.stop();
      nightly.cancel();
      await runner.stopAll('shutdown');
      state.write((ctx) => { setAppSetting(ctx, CLEAN_SHUTDOWN_KEY, { at: ctx.now }); });
      wss.close();
      await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
      removeRuntimeFiles(opts.dataDir);
      db.$client.close();
      lock.release();
    },
  };
}
```
`server.address()` returns `AddressInfo` for a TCP listener, and that cast is the boundary. If `serve`'s returned type has no `once`, wrap it: `import type { Server } from 'node:http'` and cast it with a comment.

`apps/daemon/src/daemon/index.ts`:
```ts
export { acquireInstanceLock, AlreadyRunningError } from './instance-lock';
export { readRuntimeInfo, writeRuntimeFiles, type RuntimeInfo } from './runtime-files';
export { createServices } from './services';
export { startDaemon, type DaemonOptions, type RunningDaemon } from './start';
```

Add to the `DaemonEnv` schema in `apps/daemon/src/env.ts`:
```ts
  TENDB_FAKE_SCRIPTS: z.string().min(1).optional(),
```
Add to `apps/daemon/.env.example`:
```bash
# Test and M1a development only: path to a fake-adapter script book (JSON). When set, sessions are
# scripted instead of running Claude Code. Leave empty in normal use.
TENDB_FAKE_SCRIPTS=
```

Replace `apps/daemon/src/main.ts`:
```ts
import { AlreadyRunningError, startDaemon } from './daemon';
import { loadEnv } from './env';
import { resolveDataDir, resolveMigrationsDir } from './paths';
import { createUnavailableAdapter, FakeAdapter, loadFakeScriptBook } from './sessions';

process.on('unhandledRejection', (error) => {
  console.error('10db daemon: unhandled rejection', error);
  process.exit(1);
});
process.on('uncaughtException', (error) => {
  console.error('10db daemon: uncaught exception', error);
  process.exit(1);
});

const env = loadEnv(process.env);
const dataDir = resolveDataDir(env);
const adapter = env.TENDB_FAKE_SCRIPTS
  ? new FakeAdapter(loadFakeScriptBook(env.TENDB_FAKE_SCRIPTS))
  : createUnavailableAdapter('No session adapter is configured yet; the Claude adapter arrives in M1b.');

try {
  const daemon = await startDaemon({ dataDir, port: env.TENDB_PORT, adapter, logLevel: env.TENDB_LOG_LEVEL, migrationsDir: resolveMigrationsDir() });
  console.log(`10db daemon listening on ${daemon.url} (data: ${dataDir})`);
  const shutdown = (): void => {
    void daemon.stop().then(() => process.exit(0));
  };
  process.once('SIGINT', shutdown);
  process.once('SIGTERM', shutdown);
} catch (error) {
  if (error instanceof AlreadyRunningError) {
    console.error(error.message);
    process.exit(2);
  }
  throw error;
}
```
An unhandled error makes the daemon exit loudly with code 1. In M1b the supervisor (the Tauri shell) restarts it, and recovery runs at startup (spec §12).

- [ ] **Step 4: Run, check, smoke-test, commit**

```bash
pnpm vitest run --project daemon
pnpm typecheck && pnpm lint && pnpm knip
pnpm --filter @10db/daemon build
TENDB_DATA_DIR="$(mktemp -d)/10db data" TENDB_PORT=4399 node apps/daemon/dist/daemon.mjs &
sleep 1; curl -s http://127.0.0.1:4399/health; kill %1
pnpm format
git add apps/daemon && git commit -m 'feat(daemon): compose the daemon with lock, logs, backups, recovery, scheduler, API and MCP'
```
Expected: all daemon tests PASS, the bundle builds, and `/health` answers. If esbuild warns about the top-level await, check that `format: 'esm'` and `target: 'node26'` are set.

---

### Task 20: The §1.3 acceptance tests with the fake adapter

**Files:**
- Create: `apps/daemon/test/api-client.ts`
- Test: `apps/daemon/test/acceptance.test.ts`, `apps/daemon/test/crash-recovery.test.ts`
- Modify: `apps/daemon/package.json` (devDependency `@types/better-sqlite3`), `knip.json` (drop the daemon's `ignoreDependencies`)

**Interfaces:**
- Consumes: `startDaemon`, `FakeAdapter`, the HTTP API, the fixtures and `readRuntimeInfo`.
- Produces: `apiClient(url, token)`, a small typed fetch wrapper for tests that returns parsed JSON and throws on any status ≥ 400.

These tests are the M1a definition of done. They cover each §1.3 point except the live subscription run, which is M1b:
- Three tasks.
- An automatic handoff, forced with a low threshold.
- Real questions answered through the inbox.
- `kill -9` and recovery.
- Every task DONE with gate evidence.
- No duplicated tool operation.
- Events replayable, so a reopened window loses nothing.

- [ ] **Step 1: Write the client and the in-process acceptance test**

`apps/daemon/test/api-client.ts`:
```ts
export function apiClient(url: string, token: string) {
  async function call<T>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await fetch(`${url}${path}`, {
      method,
      headers: { Authorization: `Bearer ${token}`, ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    if (res.status >= 400) throw new Error(`${method} ${path} -> ${String(res.status)}: ${text}`);
    return JSON.parse(text) as T;
  }
  return {
    get: <T>(path: string) => call<T>('GET', path),
    post: <T>(path: string, body?: unknown) => call<T>('POST', path, body ?? {}),
  };
}
```
The `as T` cast is test-side only. The daemon's response schemas are checked by the API tests and by the UI's zod parses.

`apps/daemon/test/acceptance.test.ts`:
```ts
import { execFileSync } from 'node:child_process';
import type { DaemonEvent, InboxItemDto, ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import { listEvidence, listSessions, schema } from '@10db/db';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { startDaemon, type RunningDaemon } from '../src/daemon';
import { FakeAdapter, type FakeScriptBook } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, handoffArgs, tempDir, waitForAsync } from './fixtures';

const write = (path: string) => ({ do: 'tool' as const, toolName: 'Write', input: { file_path: path, content: `${path}\n` } });
const commit = (opId: string, path: string) => ({ do: 'mcp' as const, tool: 'commit', args: { opId, paths: [path], message: `Add ${path}` } });
const turn = { do: 'turn_complete' as const };

const BOOK: FakeScriptBook = {
  Alpha: [
    [write('src/a/one.txt'), commit('op-a-0001', 'src/a/one.txt'), { do: 'context', percentage: 72 }, { do: 'await_message', contains: 'write_handoff' }, { do: 'mcp', tool: 'write_handoff', args: handoffArgs('op-a-hand1', 'Add src/a/two.txt') }, turn],
    [{ do: 'mcp', tool: 'get_context', args: {} }, write('src/a/two.txt'), commit('op-a-0002', 'src/a/two.txt'), turn],
  ],
  Beta: [
    [
      { do: 'tool', toolName: 'Bash', input: { command: 'curl -s https://example.com' } },
      { do: 'tool', toolName: 'AskUserQuestion', input: { questions: [{ question: 'Which badge color?', header: 'Color', options: [{ label: 'Teal', description: '' }, { label: 'Red', description: '' }], multiSelect: false }] } },
      write('src/b/one.txt'), commit('op-b-0001', 'src/b/one.txt'), turn,
    ],
  ],
  Gamma: [
    [
      { do: 'mcp', tool: 'ask_human', args: { opId: 'op-c-ask01', category: 'design', question: 'Round or square corners?', options: [{ label: 'Round', description: '' }, { label: 'Square', description: '' }] } },
      write('src/c/one.txt'), commit('op-c-0001', 'src/c/one.txt'), commit('op-c-0001', 'src/c/one.txt'), turn,
    ],
  ],
};

let daemon: RunningDaemon;
let repo: { path: string; cleanup(): void };
let data: { path: string; cleanup(): void };
let api: ReturnType<typeof apiClient>;

beforeAll(async () => {
  repo = await createTempRepo();
  data = tempDir('acceptance');
  daemon = await startDaemon({ dataDir: data.path, port: 0, adapter: new FakeAdapter(BOOK), logLevel: 'warn' });
  api = apiClient(daemon.url, daemon.token);
});
afterAll(async () => {
  await daemon.stop();
  repo.cleanup();
  data.cleanup();
});

describe('§1.3 with the fake adapter', () => {
  it('runs three tasks through handoff, questions, permissions and verification to DONE', async () => {
    const project = await api.post<ProjectDto>('/projects', {
      name: 'acceptance', repoPath: repo.path, gateCommand: 'test -d src', maxLanes: 3,
      areas: [{ name: 'a', globs: ['src/a/**'] }, { name: 'b', globs: ['src/b/**'] }, { name: 'c', globs: ['src/c/**'] }],
      handoffPct: 70, nudgePct: 85,
    });
    const alpha = await api.post<TaskDto>(`/projects/${project.id}/tasks`, { title: 'Alpha', acceptanceCriteria: ['two files'], areas: ['a'] });
    const beta = await api.post<TaskDto>(`/projects/${project.id}/tasks`, { title: 'Beta', acceptanceCriteria: ['one file'], areas: ['b'] });
    const gamma = await api.post<TaskDto>(`/projects/${project.id}/tasks`, { title: 'Gamma', acceptanceCriteria: ['one file'], areas: ['c'], dependsOn: [alpha.id] });
    for (const t of [alpha, beta, gamma]) await api.post<WorkstreamDto>(`/tasks/${t.id}/start`);

    const answer = async (kind: string, title: string, choice: string) => {
      const card = await waitForAsync(async () => (await api.get<InboxItemDto[]>('/inbox?state=OPEN')).find((i) => i.kind === kind && i.title.includes(title)));
      await api.post(`/inbox/${card.id}/answer`, { choice });
    };
    await answer('permission', 'Bash', 'allow_once');
    await answer('question', 'badge color', 'Teal');
    await answer('question', 'corners', 'Round');

    const all = await waitForAsync(async () => {
      const list = await api.get<WorkstreamDto[]>('/workstreams?active=false');
      return list.length === 3 && list.every((w) => w.state === 'DONE') ? list : undefined;
    }, 30_000);

    const byTask = new Map(all.map((w) => [w.taskId, w]));
    const alphaWs = byTask.get(alpha.id);
    if (!alphaWs) throw new Error('no Alpha workstream');
    expect(listSessions(daemon.state.db, alphaWs.id)).toHaveLength(2);
    for (const ws of all) expect(listEvidence(daemon.state.db, ws.id).filter((e) => e.kind === 'gate').at(-1)?.exitCode).toBe(0);

    const trailers = execFileSync('git', ['-C', repo.path, 'log', '--format=%(trailers:key=10db-Op,valueonly)']).toString().split('\n').filter(Boolean);
    expect(trailers.length).toBe(new Set(trailers).size);
    expect(trailers.filter((t) => t === 'op-c-0001')).toHaveLength(1);
    const ops = daemon.state.db.select().from(schema.toolOps).all();
    expect(ops.length).toBe(new Set(ops.map((o) => `${o.workstreamId}:${o.opId}`)).size);

    const decisions = daemon.state.db.select().from(schema.decisions).all();
    expect(decisions.map((d) => d.choice)).toContain('Round');
  }, 60_000);

  it('replays the full history after a cursor, as a reopened window would', async () => {
    const events = await api.get<DaemonEvent[]>('/events?after=0&limit=1000');
    const middle = events[Math.floor(events.length / 2)]?.seq ?? 0;
    const received: number[] = [];
    const socket = new WebSocket(`${daemon.url.replace('http', 'ws')}/events/stream?after=${String(middle)}&token=${daemon.token}`);
    await new Promise<void>((resolve, reject) => {
      socket.onmessage = (m) => {
        received.push((JSON.parse(String(m.data)) as DaemonEvent).seq);
        if (received.at(-1) === events.at(-1)?.seq) resolve();
      };
      socket.onerror = () => { reject(new Error('socket error')); };
    });
    socket.close();
    expect(received).toEqual(events.filter((e) => e.seq > middle).map((e) => e.seq));
  }, 30_000);
});

```

- [ ] **Step 2: Write the crash-recovery test**

`apps/daemon/test/crash-recovery.test.ts`:
```ts
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { DaemonEvent, ProjectDto, TaskDto, WorkstreamDto } from '@10db/contracts';
import Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { readRuntimeInfo } from '../src/daemon';
import type { FakeScriptBook } from '../src/sessions';
import { apiClient } from './api-client';
import { createTempRepo, tempDir, waitForAsync } from './fixtures';

const DAEMON_DIR = resolve(import.meta.dirname, '..');
const BOOK: FakeScriptBook = {
  Xray: [
    [
      { do: 'tool', toolName: 'Write', input: { file_path: 'src/x/one.txt', content: 'one\n' } },
      { do: 'mcp', tool: 'commit', args: { opId: 'op-x-00001', paths: ['src/x/one.txt'], message: 'Add one' } },
      { do: 'activity', summary: 'about to hang' },
      { do: 'hang' },
    ],
    [
      { do: 'mcp', tool: 'commit', args: { opId: 'op-x-00001', paths: ['src/x/one.txt'], message: 'Add one' } },
      { do: 'tool', toolName: 'Write', input: { file_path: 'src/x/two.txt', content: 'two\n' } },
      { do: 'mcp', tool: 'commit', args: { opId: 'op-x-00002', paths: ['src/x/two.txt'], message: 'Add two' } },
      { do: 'turn_complete' },
    ],
  ],
};

let repo: { path: string; cleanup(): void };
let data: { path: string; cleanup(): void };
let child: ChildProcess | null = null;

function launchDaemon(): ChildProcess {
  return spawn(process.execPath, ['--import', 'tsx', 'src/main.ts'], {
    cwd: DAEMON_DIR,
    env: { PATH: process.env['PATH'] ?? '', HOME: process.env['HOME'] ?? '', TENDB_DATA_DIR: data.path, TENDB_PORT: '0', TENDB_LOG_LEVEL: 'warn', TENDB_FAKE_SCRIPTS: join(data.path, 'book.json') },
    stdio: 'ignore',
  });
}

async function connect() {
  return waitForAsync(async () => {
    if (!existsSync(join(data.path, 'daemon.json'))) return undefined;
    const info = readRuntimeInfo(data.path);
    const token = readFileSync(join(data.path, 'ui-token'), 'utf8');
    const ok = await fetch(`http://127.0.0.1:${String(info.port)}/health`).then((r) => r.ok).catch(() => false);
    return ok ? apiClient(`http://127.0.0.1:${String(info.port)}`, token) : undefined;
  }, 20_000);
}

beforeAll(async () => {
  repo = await createTempRepo();
  data = tempDir('crash');
  writeFileSync(join(data.path, 'book.json'), JSON.stringify(BOOK));
});
afterAll(() => {
  child?.kill('SIGKILL');
  repo.cleanup();
  data.cleanup();
});

describe('kill -9 mid-step', () => {
  it('recovers, resumes, and finishes without duplicating the commit', async () => {
    child = launchDaemon();
    let api = await connect();
    const project = await api.post<ProjectDto>('/projects', { name: 'crash', repoPath: repo.path, gateCommand: 'test -f src/x/two.txt', areas: [{ name: 'x', globs: ['src/x/**'] }] });
    const task = await api.post<TaskDto>(`/projects/${project.id}/tasks`, { title: 'Xray', acceptanceCriteria: ['two files'], areas: ['x'] });
    const ws = await api.post<WorkstreamDto>(`/tasks/${task.id}/start`);
    await waitForAsync(async () => (await api.get<DaemonEvent[]>('/events?after=0&limit=1000')).find((e) => e.type === 'session.activity' && e.data['summary'] === 'about to hang'));

    const killed = new Promise((r) => child?.once('exit', r));
    child.kill('SIGKILL');
    await killed;

    child = launchDaemon();
    api = await connect();
    const done = await waitForAsync(async () => {
      const list = await api.get<WorkstreamDto[]>('/workstreams?active=false');
      const mine = list.find((w) => w.id === ws.id);
      return mine?.state === 'DONE' ? mine : undefined;
    }, 30_000);
    // The kill counted as a failed attempt, then the step_done that followed reset the count (Task 16).
    expect(done.recoveryAttempts).toBe(0);

    const events = await api.get<DaemonEvent[]>('/events?after=0&limit=5000');
    expect(events.some((e) => e.type === 'workstream.changed' && e.data['to'] === 'RECOVERING' && e.data['reason'] === 'daemon restarted')).toBe(true);
    expect(events.some((e) => e.type === 'recovery.step')).toBe(true);

    const trailers = execFileSync('git', ['-C', repo.path, 'log', '--format=%(trailers:key=10db-Op,valueonly)']).toString().split('\n').filter(Boolean);
    expect(trailers.filter((t) => t === 'op-x-00001')).toHaveLength(1);
    const db = new Database(join(data.path, '10db.sqlite'), { readonly: true });
    const ops = db.prepare("SELECT count(*) AS n FROM tool_ops WHERE op_id = 'op-x-00001'").get() as { n: number };
    const sessions = db.prepare('SELECT exit_reason FROM sessions WHERE workstream_id = ? ORDER BY sequence').all(ws.id) as { exit_reason: string }[];
    db.close();
    expect(ops.n).toBe(1);
    expect(sessions.map((s) => s.exit_reason)).toEqual(['daemon_restart', 'step_done']);
    // Two daemon boots plus a 30 s wait budget: far beyond vitest's 5 s default, and CI is slower.
  }, 90_000);
});
```
This test opens the database file directly with `better-sqlite3`. M0 Task 9 already lists `better-sqlite3` 13.0.3 in the daemon's `dependencies`, so that the bundle smoke test resolves it at runtime; don't add it again, because `pnpm add -D` would move it to devDependencies and break the bundled daemon. Add only its types:
```bash
pnpm add -D --filter @10db/daemon @types/better-sqlite3@9.6.0
grep -E '"(@types/)?better-sqlite3"' apps/daemon/package.json
```
Expected: `"better-sqlite3": "13.0.3"` (still under `dependencies`) and `"@types/better-sqlite3": "9.6.0"` (under `devDependencies`).

M0 Task 9 also put `"ignoreDependencies": ["better-sqlite3"]` on the `apps/daemon` workspace in `knip.json`, because nothing in the daemon imported it. This test now does, so remove that line. The entry becomes:
```json
    "apps/daemon": {
      "entry": ["src/main.ts", "scripts/*.ts"]
    },
```
`readonly: true` is enough: the test only reads.

- [ ] **Step 3: Run them to see them pass (and prove one goes red)**

```bash
pnpm vitest run --project daemon acceptance crash-recovery
```
Expected: both PASS. To prove the duplicate check can fail, temporarily remove the `findCommitByOp` early return in `git.ts` and rerun. Expected: FAIL, because `op-x-00001` appears twice, or because `op-c-0001` does. Restore the line.

- [ ] **Step 4: Run the gate and commit**

```bash
pnpm format
make gate
git add apps/daemon/test apps/daemon/package.json knip.json pnpm-lock.yaml && git commit -m 'test(daemon): add the §1.3 acceptance tests with the fake adapter, including kill -9 recovery'
```
Expected: `GATE PASS …`, with `knip` clean (no unused `ignoreDependencies` hint), and the hooks pass.

---

### Task 21: Records and the PR

**Files:**
- Modify: `docs/architecture/decisions.md`, `docs/open-items.md`, `apps/daemon/AGENTS.md`, `packages/db/AGENTS.md`

- [ ] **Step 1: Append decisions**

Append these rows to `docs/architecture/decisions.md`, numbered after the last existing row:
```markdown
| 27 | Permission grants live in a `permission_rules` table (project or workstream scope, tool, optional command prefix). | Spec §7's "always for this project writes an allow rule" needs a home; a table is queryable and auditable, unlike settings JSON. |
| 28 | Flag, proposal and review cards close straight to RESOLVED when answered; only question and permission cards deliver to waiting sessions. In M1 a review card only acknowledges; reopening work from it arrives with flows in M2. | They have nothing to deliver; skipping DELIVERING keeps recovery's redelivery pass to cards that need it. |
| 29 | The workstream state machine lives in `@10db/contracts`, not the daemon. | The database layer enforces it on every transition and the UI can show which actions are allowed; both import the same table. |
| 30 | `commit` stamps a `10db-Op: <opId>` git trailer and checks for it before committing. | It makes a retried commit idempotent even when the daemon crashed between the git commit and recording the operation. |
| 31 | One shared daemon log (`logs/daemon.log`, rotated at startup past 10 MiB, 5 kept) with `workstreamId` on every runner line, instead of a file per workstream for now. | The Factory detail view (M2) is the first reader of per-workstream logs; filtering by field covers M1 debugging. |
| 32 | Hazard claims are exclusive per hazard name (two workstreams can't both hold `deps`), not one hazard workstream per repo. A hazard command matches on its words with flags and flag values dropped, so `pnpm -w add`, `pnpm --filter x add` and `pnpm i` need the `deps` claim too. | The spec's "hazard work never runs in parallel" is met per hazard; a repo-wide hazard mutex would serialize unrelated migrations and dependency work. Revisit if real collisions say otherwise. A literal prefix match was trivially bypassed by a flag before the subcommand. |
| 33 | `inbox.answer` applies what an answer implies in the answer's own transaction: permission rules for `allow_workstream` / `allow_project`, and a proposal's status and rationale. An `allow_once` that arrives after the workstream was parked becomes a one-time allowance for the identical call in the resumed session. | The asking session may have been parked before the builder answered, so the broker can't be the only place a choice takes effect. |
| 34 | Recovery signals a stored pid only while its OS start time (`ps -o lstart=`, recorded when the session or gate started) still matches; a running gate's process group is recorded on the workstream so recovery can kill it. | After a reboot a stored pid can belong to an unrelated process; a detached gate survives `kill -9` and would otherwise run twice in one checkout. The `started` session event is unchanged, because the daemon looks the start time up itself. |
| 35 | A clean stop writes `daemon.clean_shutdown` to `app_settings`; the next start passes it to recovery, which then keeps `recoveryAttempts` unchanged. A session that ends in `handoff` or `step_done` resets `recoveryAttempts` to 0. | Spec §5.4 counts failed attempts: quitting the app three times must not fail a long task, and the limit is about consecutive failures, not lifetime ones. |
| 36 | Claims are released when the workstream reaches DONE, CANCELLED or FAILED (including a recovery that fails it), never by lease expiry. `claims.lease_expires_at` follows the workstream lease for diagnostics. | Claims belong to the workstream, recovery re-queues the same holder, and every terminal transition releases them, so expiry would only add a race. Spec §8.1's "released when the lease expires" needs rewording to match (open item). |
```
The rows run 27–36 with no gap, as M0's decisions test (`tests/repo/src/architecture-docs.test.ts`) requires. M1b appends rows 37–53 after row 36.

- [ ] **Step 2: Update the open items and the AGENTS files**

In `docs/open-items.md`, tick `M1a engine core merged` after the merge. Add:
```markdown
- [ ] M2: "answered from D-n" lookup before a question reaches the inbox (spec §7).
- [ ] M2: reviewer approval in flows with a review step before DONE (spec §5.4).
- [ ] M2: per-workstream log files for the Factory detail view.
- [ ] M2: diagnostics bundle export (spec §12).
- [ ] M2: project settings for extra allowed commands (test and lint), beyond the gate command.
- [ ] Spec §8.1: reword "claims are released when the lease expires" to match decision 36 (released on DONE, CANCELLED or FAILED, never by lease expiry).
- [ ] M2: let a resumed agent retrying `ask_human` with the same `opId` get the parked answer back, instead of only the "do not ask again" message.
- [ ] M2: inject the environment into `createGit(env)` instead of reading `process.env` in `git.ts` (M1b already calls `createGit()` with no arguments).
```
In `packages/db/AGENTS.md`, add a line: "Repositories are synchronous functions over `DbReader` (reads) or `WriteContext` (writes); never open a second connection." In `apps/daemon/AGENTS.md`, add: "The fake adapter (`sessions/fake-adapter.ts`) is the test boundary for Claude Code; daemon tests never call the real CLI."

- [ ] **Step 3: Gate, push and open the PR**

Ask the builder before pushing. The PR title is a Conventional Commit, because the squash merge makes it the commit on `main`, and the `policy` check lints it.
```bash
make gate
pnpm format
git add docs/architecture/decisions.md docs/open-items.md apps/daemon/AGENTS.md packages/db/AGENTS.md && git commit -m 'docs(docs): record M1a decisions and open items'
git push -u origin feat/m1a-engine-core
gh pr create --base main --title 'feat(daemon): add the engine core with the fake adapter (m1a)' --body-file - <<'EOF'
M1a from docs/superpowers/plans/2026-10-13-10db-02-m1a-engine-core.md: domain contracts, schema and
repositories, guard, permissions, git through 10db, gate runner, inbox, MCP tools, API with replaying
event stream, runner, scheduler, recovery, daemon composition.

Verification: make gate prints GATE PASS; the §1.3 acceptance and kill -9 tests pass with the fake adapter.
EOF
gh pr checks --watch
```
Expected: CI green.
