import { z } from 'zod';
import {
  BoardColumnId,
  EvidenceId,
  FlowId,
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
  RiskTag,
  TaskStatus,
  Urgency,
  WorkstreamState,
} from './states';
import { WorkstreamStep } from './steps';

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
  {
    name: 'migrations',
    globs: ['**/migrations/**', '**/drizzle/**'],
    commands: ['drizzle-kit generate', 'pnpm db:migrate'],
  },
  {
    name: 'deps',
    globs: ['**/package.json', 'pnpm-lock.yaml', '**/Cargo.toml', '**/Cargo.lock'],
    commands: [
      'pnpm add',
      'pnpm remove',
      'pnpm rm',
      'pnpm install',
      'pnpm i',
      'pnpm update',
      'pnpm up',
      'npm install',
      'npm i',
      'npm uninstall',
      'cargo add',
      'cargo remove',
    ],
  },
  {
    name: 'harness',
    globs: ['AGENTS.md', '**/AGENTS.md', '.claude/**', '.codex/**'],
    commands: [],
  },
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
    flowId: FlowId.nullable().default(null),
    /** The most a task may cost, in USD, compared with a profile's AA cost per task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable().default(null),
  })
  .refine((p) => p.nudgePct > p.handoffPct, {
    message: 'nudgePct must be above handoffPct',
    path: ['nudgePct'],
  });
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
  flowId: FlowId.nullable(),
  budgetCeiling: z.number().nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type ProjectDto = z.infer<typeof ProjectDto>;

/** Fields the builder can change after creation; the nudge/handoff rule is checked against the merged values. */
export const ProjectPatch = z
  .object({
    name: z.string().min(1),
    gateCommand: z.string().min(1),
    maxLanes: z.int().min(1).max(16),
    handoffPct: z.int().min(5).max(95),
    nudgePct: z.int().min(6).max(98),
    humanWaitMinutes: z.int().min(1).max(240),
    flowId: FlowId.nullable(),
    /** The most a task may cost, in USD, compared with a profile's AA cost per task; null for no ceiling. */
    budgetCeiling: z.number().positive().nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type ProjectPatch = z.infer<typeof ProjectPatch>;

export const TaskInput = z.object({
  title: z.string().min(1).max(200),
  description: z.string().default(''),
  acceptanceCriteria: z.array(z.string().min(1)).min(1),
  areas: z.array(Name).min(1),
  dependsOn: z.array(TaskId).default([]),
  riskTags: z.array(z.enum(RiskTag)).default([]),
  flowId: FlowId.nullable().default(null),
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
  riskTags: z.array(z.enum(RiskTag)),
  flowId: FlowId.nullable(),
  status: z.enum(TaskStatus),
  boardOrder: z.number(),
  boardColumnId: BoardColumnId.nullable(),
  dependsOn: z.array(TaskId),
  boardStatus: z.enum(BoardStatus),
  workstreamId: WorkstreamId.nullable(),
  createdAt: Timestamp,
  updatedAt: Timestamp,
});
export type TaskDto = z.infer<typeof TaskDto>;

export const TaskPatch = z
  .object({
    title: z.string().min(1).max(200),
    description: z.string(),
    acceptanceCriteria: z.array(z.string().min(1)).min(1),
    riskTags: z.array(z.enum(RiskTag)),
    flowId: FlowId.nullable(),
  })
  .partial()
  .refine((p) => Object.keys(p).length > 0, { message: 'Change at least one field' });
export type TaskPatch = z.infer<typeof TaskPatch>;

/** What the runner does the next time the workstream gets a lane. */
export const NextAction = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('start') }),
  z.object({ kind: z.literal('continue_from_handoff'), handoffId: HandoffId }),
  z.object({
    kind: z.literal('resume'),
    providerSessionId: z.string().min(1),
    reason: z.string().min(1),
  }),
  z.object({
    kind: z.literal('answer'),
    inboxId: InboxItemId,
    providerSessionId: z.string().min(1).nullable(),
  }),
  z.object({ kind: z.literal('fix'), evidenceId: EvidenceId }),
  z.object({ kind: z.literal('verify') }),
  /** Rerun a step a reviewer rejected; the rejecting step's notes are in its result. */
  z.object({ kind: z.literal('revise'), reviewStep: z.int().min(0) }),
]);
export type NextAction = z.infer<typeof NextAction>;

export const WorkstreamDto = z.object({
  id: WorkstreamId,
  taskId: TaskId,
  taskTitle: z.string(),
  projectId: ProjectId,
  state: z.enum(WorkstreamState),
  nextAction: NextAction,
  attempt: z.int(),
  recoveryAttempts: z.int(),
  model: z.string(),
  effort: z.enum(Effort),
  steps: z.array(WorkstreamStep),
  stepIndex: z.int().min(0),
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

export const InboxAnswer = z.object({
  choice: z.string().min(1),
  note: z.string().max(4000).optional(),
});
export type InboxAnswer = z.infer<typeof InboxAnswer>;

export const InboxTarget = z.object({
  workstreamId: WorkstreamId,
  sessionId: SessionId.nullable(),
});
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
